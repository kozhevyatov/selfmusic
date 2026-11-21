"""Обложки (с кэшем уменьшенных копий) и отдача аудио: оригинал с поддержкой Range или транскодирование ffmpeg."""
from __future__ import annotations

import asyncio
import colorsys
import hashlib
import io
import logging
import mimetypes
import os
import threading
import uuid
import warnings
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from PIL import Image, ImageDraw, ImageFilter, ImageOps
from sqlalchemy.orm import Session

from .config import CACHE_DIR, COVER_CACHE, META_DIR, settings
from .models import Album, Library, Track
from .tags import embedded_cover

log = logging.getLogger("uvicorn.error")

# Картинка 20000×20000 весит в PNG пару килобайт, а в памяти — больше гигабайта. Такие не открываем.
Image.MAX_IMAGE_PIXELS = 40_000_000
warnings.simplefilter("error", Image.DecompressionBombWarning)

# Не больше двух обложек обрабатываются одновременно (на NAS память и CPU небольшие),
# и одну и ту же обложку не делаем дважды параллельно.
_cover_slots = threading.BoundedSemaphore(int(os.environ.get("COVER_WORKERS", "2")))
_cover_locks: dict[str, threading.Lock] = {}
_cover_locks_guard = threading.Lock()

# Одновременных перекодирований ffmpeg. Каждый поток слушателя держит свой процесс,
# поэтому это не очередь, а «предохранитель»: сверх лимита отвечаем 503.
MAX_TRANSCODES = int(os.environ.get("MAX_TRANSCODES", "12"))
_transcodes = 0
_transcodes_guard = threading.Lock()


class _CoverReadError(Exception):
    """Файл временно недоступен (диск засыпал, том отмонтирован) — не запоминаем «нет обложки»."""

MAX_COVER = 1200
CONTENT_TYPES = {
    "mp3": "audio/mpeg",
    "flac": "audio/flac",
    "m4a": "audio/mp4",
    "m4b": "audio/mp4",
    "mp4": "audio/mp4",
    "aac": "audio/aac",
    "alac": "audio/mp4",
    "ogg": "audio/ogg",
    "oga": "audio/ogg",
    "opus": "audio/ogg",
    "wav": "audio/wav",
    "wma": "audio/x-ms-wma",
    "ape": "audio/x-ape",
    "wv": "audio/x-wavpack",
    "aif": "audio/aiff",
    "aiff": "audio/aiff",
    "dsf": "audio/dsf",
    "mpc": "audio/x-musepack",
}
# Что браузеры играют сами. Остальное (APE, WMA, ALAC, DSD…) в вебе отдаём через ffmpeg.
BROWSER_FRIENDLY = {"mp3", "flac", "m4a", "mp4", "aac", "ogg", "oga", "opus", "wav"}


def content_type(suffix: str) -> str:
    return CONTENT_TYPES.get(suffix.lower()) or mimetypes.guess_type(f"x.{suffix}")[0] or "application/octet-stream"


def track_file(db: Session, track: Track) -> Path:
    lib = db.get(Library, track.library_id)
    if lib is None:
        raise HTTPException(404, "Файл не найден")
    root = Path(lib.path).resolve()
    path = (root / track.path).resolve()
    if root not in path.parents or not path.is_file():
        raise HTTPException(404, "Файл недоступен")
    return path


# ---------------- обложки ----------------


def _original_cover(db: Session, album: Album) -> bytes | None:
    if not album.cover:
        return None
    kind, _, ref = album.cover.partition(":")
    if kind == "meta":  # найдена в Cover Art Archive (app/metadata.py)
        path = META_DIR / "covers" / os.path.basename(ref)
        try:
            return path.read_bytes() if path.is_file() else None
        except OSError as exc:
            raise _CoverReadError from exc
    lib = db.get(Library, album.library_id)
    if lib is None:
        return None
    root = Path(lib.path).resolve()
    try:
        if kind == "file":
            path = (root / ref).resolve()
            if root in path.parents and path.is_file():
                return path.read_bytes()
        elif kind == "embed":
            track = db.get(Track, int(ref))
            if track:
                return embedded_cover((root / track.path).resolve())
    except ValueError:
        return None
    except OSError as exc:
        raise _CoverReadError from exc
    return None


def cover_path(db: Session, album: Album, size: int | None) -> Path | None:
    """Путь к кэшированной копии обложки нужного размера (WebP) или None, если обложки нет."""
    size = max(32, min(int(size or 600), MAX_COVER))
    # Округляем до «ступенек», чтобы кэш не разрастался от произвольных размеров из приложений
    for step in (64, 128, 256, 400, 600, 900, 1200):
        if size <= step:
            size = step
            break
    stamp = int(album.updated_at.timestamp()) if album.updated_at else 0
    COVER_CACHE.mkdir(parents=True, exist_ok=True)
    cached = COVER_CACHE / f"al{album.id}-{size}-{stamp}.webp"
    if cached.exists():
        return cached
    miss = COVER_CACHE / f"al{album.id}-none-{stamp}"
    if miss.exists():
        return None
    with _cover_locks_guard:
        lock = _cover_locks.setdefault(cached.name, threading.Lock())
    with lock:
        try:
            if cached.exists():  # пока ждали, её уже сделал соседний запрос
                return cached
            with _cover_slots:
                return _render_cover(db, album, size, stamp, cached, miss)
        finally:
            with _cover_locks_guard:
                _cover_locks.pop(cached.name, None)


def _render_cover(db: Session, album: Album, size: int, stamp: int, cached: Path, miss: Path) -> Path | None:
    try:
        data = _original_cover(db, album)
    except _CoverReadError:
        return None
    if not data:
        miss.touch()
        return None
    try:
        img = Image.open(io.BytesIO(data))
        img.draft("RGB", (size * 2, size * 2))  # JPEG: декодируем сразу в уменьшенном виде — в разы быстрее
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((size, size), Image.LANCZOS)
    except Exception:  # noqa: BLE001
        log.warning("Не удалось прочитать обложку альбома %s", album.id)
        miss.touch()
        return None
    # Уникальное имя временного файла: одну и ту же обложку могут запросить параллельно
    tmp = cached.with_name(f"{cached.name}.{uuid.uuid4().hex}.tmp")
    try:
        img.save(tmp, "WEBP", quality=86, method=4)
        tmp.replace(cached)
    except OSError:
        tmp.unlink(missing_ok=True)
        if not cached.exists():
            return None
    # старые версии этой обложки больше не нужны
    for old in COVER_CACHE.glob(f"al{album.id}-*"):
        if f"-{stamp}" not in old.name:
            try:
                old.unlink()
            except OSError:
                pass
    return cached


def placeholder_cover(seed: str, size: int = 600) -> bytes:
    """Красивая заглушка для приложений: две размытые «капли» на тёмном фоне (как в вебе)."""
    size = max(64, min(size, 600))
    h = int(hashlib.md5(seed.encode()).hexdigest()[:8], 16)
    hue1 = (h % 360) / 360
    hue2 = ((h // 360) % 360) / 360

    def rgb(hue: float, light: float, sat: float) -> tuple[int, int, int]:
        r, g, b = colorsys.hls_to_rgb(hue, light, sat)
        return int(r * 255), int(g * 255), int(b * 255)

    img = Image.new("RGB", (size, size), rgb(hue1, 0.12, 0.25))
    layer = Image.new("RGB", (size, size), (0, 0, 0))
    draw = ImageDraw.Draw(layer)
    s = size
    draw.ellipse((-s * 0.2, -s * 0.25, s * 0.75, s * 0.6), fill=rgb(hue1, 0.55, 0.75))
    draw.ellipse((s * 0.35, s * 0.4, s * 1.2, s * 1.2), fill=rgb(hue2, 0.5, 0.7))
    layer = layer.filter(ImageFilter.GaussianBlur(s * 0.12))
    img = Image.blend(img, layer, 0.75)
    buf = io.BytesIO()
    img.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def image_response(path: Path) -> FileResponse:
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "private, max-age=604800"})


# ---------------- аудио ----------------


def _parse_range(header: str, size: int) -> tuple[int, int] | None:
    try:
        unit, _, spec = header.partition("=")
        if unit.strip().lower() != "bytes" or "," in spec:
            return None
        start_s, _, end_s = spec.strip().partition("-")
        if start_s == "":
            length = int(end_s)
            start, end = max(0, size - length), size - 1
        else:
            start = int(start_s)
            end = int(end_s) if end_s else size - 1
        end = min(end, size - 1)
        if start > end or start >= size:
            return None
        return start, end
    except ValueError:
        return None


def file_response(request: Request, path: Path, media_type: str, filename: str | None = None) -> Response:
    """Отдача файла с поддержкой Range — нужна для перемотки в браузере и приложениях."""
    size = path.stat().st_size
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400"}
    if filename:
        from urllib.parse import quote

        headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(filename)}"
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(path, media_type=media_type, headers=headers)
    rng = _parse_range(range_header, size)
    if rng is None:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
    start, end = rng
    length = end - start + 1

    def iterator():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(256 * 1024, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers.update({"Content-Range": f"bytes {start}-{end}/{size}", "Content-Length": str(length)})
    return StreamingResponse(iterator(), status_code=206, media_type=media_type, headers=headers)


TRANSCODE_FORMATS = {
    "mp3": ("libmp3lame", "mp3", "audio/mpeg"),
    "opus": ("libopus", "ogg", "audio/ogg"),
    "aac": ("aac", "adts", "audio/aac"),
}


def transcode_response(
    path: Path,
    fmt: str,
    bitrate: int,
    offset: float = 0,
    *,
    exact: int | None = None,
    status_code: int = 200,
    headers: dict[str, str] | None = None,
) -> StreamingResponse:
    """exact — отдать ровно столько байт (лишнее обрезать, недостающее добить нулями): так размер ответа
    совпадает с объявленным Content-Length, и плеер может запрашивать поток кусками (Range)."""
    codec, container, media_type = TRANSCODE_FORMATS.get(fmt, TRANSCODE_FORMATS["mp3"])
    bitrate = max(32, min(bitrate, 320))
    cmd = [settings.ffmpeg, "-v", "error", "-nostdin"]
    if offset > 0:
        cmd += ["-ss", f"{offset:.3f}"]
    cmd += ["-i", str(path), "-map", "0:a:0", "-vn", "-threads", "1", "-c:a", codec, "-b:a", f"{bitrate}k"]
    if fmt == "opus":
        cmd += ["-ar", "48000"]
    if exact is not None:
        # чистый поток кадров постоянного битрейта: без ID3 и Xing — байт N ≈ секунда N / (битрейт/8)
        cmd += ["-ar", "44100", "-write_xing", "0", "-id3v2_version", "0"]
    cmd += ["-f", container, "pipe:1"]

    global _transcodes
    with _transcodes_guard:
        if _transcodes >= MAX_TRANSCODES:
            raise HTTPException(503, "Сервер занят перекодированием, попробуйте позже", headers={"Retry-After": "10"})
        _transcodes += 1

    released = False

    def release() -> None:
        global _transcodes
        nonlocal released
        with _transcodes_guard:
            if not released:
                released = True
                _transcodes -= 1

    async def stream():
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
                preexec_fn=_lower_priority,
            )
        except Exception:
            release()
            raise
        try:
            assert proc.stdout is not None
            left = exact
            while left is None or left > 0:
                chunk = await proc.stdout.read(64 * 1024 if left is None else min(64 * 1024, left))
                if not chunk:
                    break
                if left is not None:
                    left -= len(chunk)
                yield chunk
            # ffmpeg закончил чуть раньше расчётного размера — добиваем тишиной (декодер пропустит нули)
            while left:
                pad = min(64 * 1024, left)
                left -= pad
                yield b"\0" * pad
        finally:
            if proc.returncode is None:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
            await proc.wait()
            release()

    return _TranscodeResponse(
        stream(),
        release,
        status_code=status_code,
        media_type=media_type,
        headers=headers or {"Cache-Control": "no-store", "Accept-Ranges": "none"},
    )


# ---------------- перекодированный MP3 с поддержкой Range ----------------
#
# Safari (iPhone, PWA) запрашивает поток кусками — «байты 1589248–4695551», «32487–1589247» — и склеивает
# их в один файл. Значит, байт N в любом ответе обязан быть тем же самым байтом одного и того же файла.
# Поэтому трек перекодируется целиком один раз в файл кэша, а куски отдаются из него (пока файл пишется —
# по мере готовности; ffmpeg работает в десятки раз быстрее реального времени). Размер объявляется заранее
# (длительность × битрейт / 8, постоянный битрейт): лишнее обрезается, недостающее добивается нулями —
# одинаково для всех запросов.

TRANSCODE_CACHE = CACHE_DIR / "transcode"
TRANSCODE_CACHE_MB = int(os.environ.get("TRANSCODE_CACHE_MB", "2048"))


class _Job:
    def __init__(self, part: Path, final: Path) -> None:
        self.part = part
        self.final = final
        self.done = threading.Event()


_jobs: dict[str, _Job] = {}
_jobs_guard = threading.Lock()


def _take_slot() -> None:
    global _transcodes
    with _transcodes_guard:
        if _transcodes >= MAX_TRANSCODES:
            raise HTTPException(503, "Сервер занят перекодированием, попробуйте позже", headers={"Retry-After": "10"})
        _transcodes += 1


def _free_slot() -> None:
    global _transcodes
    with _transcodes_guard:
        _transcodes = max(0, _transcodes - 1)


def _trim_transcode_cache() -> None:
    """Держим кэш в пределах TRANSCODE_CACHE_MB: удаляем давно не слушанные."""
    try:
        files = [(f.stat().st_mtime, f.stat().st_size, f) for f in TRANSCODE_CACHE.glob("*.mp3")]
    except OSError:
        return
    total = sum(size for _, size, _ in files)
    limit = TRANSCODE_CACHE_MB * 1024 * 1024
    for _, size, f in sorted(files):
        if total <= limit:
            break
        try:
            f.unlink()
            total -= size
        except OSError:
            pass


def _run_job(key: str, job: _Job, cmd: list[str]) -> None:
    import subprocess

    try:
        proc = subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, preexec_fn=_lower_priority)
        if proc.returncode == 0:
            os.replace(job.part, job.final)
    except Exception:  # noqa: BLE001
        logging.getLogger(__name__).exception("Перекодирование не удалось")
    finally:
        _free_slot()
        job.done.set()
        with _jobs_guard:
            _jobs.pop(key, None)
        try:
            job.part.unlink(missing_ok=True)
        except OSError:
            pass
        _trim_transcode_cache()


def _transcoded(path: Path, bitrate: int) -> tuple[Path, _Job | None]:
    """Файл перекодированного трека: готовый из кэша или пишущийся сейчас (тогда вернётся и задача)."""
    st = path.stat()
    key = hashlib.sha1(f"{path}|{st.st_mtime_ns}|{st.st_size}|{bitrate}".encode()).hexdigest()[:20]
    final = TRANSCODE_CACHE / f"{key}.mp3"
    if final.exists():
        try:
            os.utime(final)  # «недавно слушали» — для очистки кэша
        except OSError:
            pass
        return final, None
    with _jobs_guard:
        job = _jobs.get(key)
        if job:
            return job.part, job
        _take_slot()
        TRANSCODE_CACHE.mkdir(parents=True, exist_ok=True)
        job = _Job(TRANSCODE_CACHE / f"{key}.{uuid.uuid4().hex[:8]}.part", final)
        cmd = [
            settings.ffmpeg, "-v", "error", "-nostdin", "-y", "-i", str(path), "-map", "0:a:0", "-vn", "-threads", "1",
            "-c:a", "libmp3lame", "-b:a", f"{bitrate}k", "-ar", "44100", "-write_xing", "0", "-id3v2_version", "0",
            "-f", "mp3", str(job.part),
        ]
        _jobs[key] = job
        threading.Thread(target=_run_job, args=(key, job, cmd), daemon=True).start()
    return job.part, job


def _read_growing(path: Path, job: _Job | None, start: int, length: int):
    """Кусок файла [start, start+length): ждём, пока ffmpeg допишет нужное; не хватило — добиваем нулями."""
    import time

    sent = 0
    f = None
    idle = 0.0
    try:
        while sent < length:
            if f is None:
                for candidate in (path, job.final if job else path):
                    try:
                        f = open(candidate, "rb")  # noqa: SIM115
                        break
                    except FileNotFoundError:
                        continue
                if f is None:
                    if job and not job.done.is_set() and idle < 120:
                        time.sleep(0.05)
                        idle += 0.05
                        continue
                    break
            f.seek(start + sent)
            chunk = f.read(min(256 * 1024, length - sent))
            if chunk:
                idle = 0.0
                sent += len(chunk)
                yield chunk
                continue
            if job is None or job.done.is_set():
                # задача закончилась — дочитываем то, что успело записаться, и выходим
                chunk = f.read(min(256 * 1024, length - sent))
                if chunk:
                    sent += len(chunk)
                    yield chunk
                    continue
                break
            if idle > 120:  # ffmpeg завис
                break
            time.sleep(0.05)
            idle += 0.05
    finally:
        if f is not None:
            f.close()
    while sent < length:
        pad = min(256 * 1024, length - sent)
        sent += pad
        yield b"\0" * pad


def ranged_mp3_response(request: Request, path: Path, bitrate: int, duration: float) -> Response:
    """Перекодированный MP3 с честной поддержкой Range (см. выше)."""
    bitrate = max(32, min(bitrate, 320))
    total = max(int(duration * bitrate * 1000 // 8), 1)
    file, job = _transcoded(path, bitrate)
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-store"}
    range_header = request.headers.get("range")
    if not range_header:
        start, end, status = 0, total - 1, 200
    else:
        rng = _parse_range(range_header, total)
        if rng is None:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{total}"})
        start, end = rng
        status = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    length = end - start + 1
    headers["Content-Length"] = str(length)
    return StreamingResponse(_read_growing(file, job, start, length), status_code=status, media_type="audio/mpeg", headers=headers)


class _TranscodeResponse(StreamingResponse):
    """Слот ffmpeg освобождается, даже если клиент ушёл до первого байта (генератор не стартовал)."""

    def __init__(self, content, release, **kwargs) -> None:  # noqa: ANN001
        super().__init__(content, **kwargs)
        self._release = release

    async def __call__(self, scope, receive, send) -> None:  # noqa: ANN001
        try:
            await super().__call__(scope, receive, send)
        finally:
            self._release()


def _lower_priority() -> None:
    """ffmpeg с пониженным приоритетом: интерфейс и сканер не «тормозят» от перекодирования."""
    try:
        os.nice(10)
    except OSError:
        pass


def stream_track(
    request: Request,
    db: Session,
    track: Track,
    *,
    max_bitrate: int = 0,
    fmt: str | None = None,
    offset: float = 0,
    browser: bool = False,
) -> Response:
    path = track_file(db, track)
    suffix = track.suffix.lower()
    need = False
    if fmt and fmt not in ("raw", suffix):
        need = fmt in TRANSCODE_FORMATS
    if max_bitrate and track.bitrate and track.bitrate > max_bitrate + 16:
        need = True
    if browser and (suffix not in BROWSER_FRIENDLY or track.codec == "alac"):
        need = True
        max_bitrate = max_bitrate or 320
    if offset > 0 and not need and fmt != "raw":
        # Перемотка «на сервере» (OpenSubsonic transcodeOffset) возможна только через ffmpeg
        need = True
        max_bitrate = max_bitrate or max(track.bitrate, 320)
    if not need:
        return file_response(request, path, content_type(suffix))
    target = fmt if fmt in TRANSCODE_FORMATS else "mp3"
    if browser and target == "mp3" and offset <= 0 and track.duration and track.duration > 0:
        return ranged_mp3_response(request, path, max_bitrate or 320, track.duration)
    return transcode_response(path, target, max_bitrate or 320, offset)


def download_name(track: Track) -> str:
    base = f"{track.artist_name} - {track.title}" if track.artist_name else track.title
    base = "".join(c for c in base if c not in '\\/:*?"<>|').strip() or f"track-{track.id}"
    return f"{base}.{track.suffix}"


def ensure_dirs() -> None:
    os.makedirs(COVER_CACHE, exist_ok=True)
    os.makedirs(META_DIR / "covers", exist_ok=True)
    os.makedirs(META_DIR / "artists", exist_ok=True)
