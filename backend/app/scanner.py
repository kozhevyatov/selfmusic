"""Сканер папок с музыкой.

Инкрементальный: файлы с теми же mtime и размером повторно не читаются.
Альбом = папка + название альбома из тегов (подпапки CD1/CD2 склеиваются в один альбом).
Если папка недоступна (том не смонтирован) — ничего не удаляем, только пишем ошибку.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.orm import Session

from . import db as dbmod
from .app_settings import get_setting, set_setting
from .models import Album, Artist, Book, Library, Play, PlaylistEntry, Star, Track, Upload
from .books import UNKNOWN_AUTHOR, book_tags, file_chapters, natural_key, parse_book_folder, read_text_file, split_path
from .tags import TrackMeta, read_meta

log = logging.getLogger("uvicorn.error")

AUDIO_EXTENSIONS = {
    ".mp3", ".flac", ".m4a", ".m4b", ".mp4", ".aac", ".alac", ".ogg", ".oga", ".opus",
    ".wav", ".wma", ".ape", ".wv", ".aif", ".aiff", ".dsf", ".mpc",
}
IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
COVER_NAMES = ("cover", "folder", "front", "album", "albumart", "albumartsmall", "artwork", "thumb")
# .скрытые, @eaDir (миниатюры DSM), #recycle и #snapshot (корзина и снимки Btrfs), $RECYCLE.BIN
SKIP_DIRS = re.compile(r"^(\.|@|#|\$recycle)", re.I)
DISC_DIR = re.compile(r"^(cd|disc|disk|диск|диск\s*№?)\s*[-_.]?\s*\d+\b.*$", re.I)
VARIOUS = "Разные исполнители"
UNKNOWN_ARTIST = "Неизвестный исполнитель"
BATCH = 200
# Меняется, когда меняется само чтение тегов (например, исправление кодировки cp1251).
# При запуске с новой версией один раз выполняется полное пересканирование.
INDEX_VERSION = "4"  # 4: ReplayGain из тегов (смена типа папки на «книги» — отдельный полный скан этой папки)
COMMIT_EVERY = 2.0  # сек: не держим запись в SQLite дольше — веб-запросы ждут
LYRICS_MAX = 100_000


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def name_key(name: str) -> str:
    return " ".join(name.lower().split())[:255]


def sort_name(name: str) -> str:
    low = name.strip()
    for article in ("the ", "a ", "an "):
        if low.lower().startswith(article):
            return low[len(article):]
    return low


def clean(value: str | None, limit: int | None = None) -> str:
    """Строка, которую точно примет БД: без «сломанных» символов из кривых тегов и имён файлов."""
    if not value:
        return ""
    value = value.encode("utf-8", "replace").decode("utf-8").replace("\x00", "")
    return value[:limit] if limit else value


def decodable(rel: str) -> bool:
    """Имя файла в неизвестной кодировке (старые zip-архивы из Windows) в базу не запишется."""
    try:
        rel.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False


def path_hash(rel: str) -> str:
    return hashlib.sha1(rel.encode("utf-8", "surrogateescape")).hexdigest()


def format_quality(tracks: list[Track]) -> str:
    suffixes = Counter(t.suffix.lower() for t in tracks if t.suffix)
    if not suffixes:
        return ""
    suffix, _ = suffixes.most_common(1)[0]
    label = suffix.upper()
    sample = [t for t in tracks if t.suffix.lower() == suffix]
    if suffix in ("flac", "wav", "aiff", "aif", "ape", "wv", "alac", "dsf") or any(t.codec == "alac" for t in sample):
        if any(t.codec == "alac" for t in sample):
            label = "ALAC"
        depth = Counter(t.bit_depth for t in sample if t.bit_depth).most_common(1)
        rate = Counter(t.sample_rate for t in sample if t.sample_rate).most_common(1)
        if depth and rate:
            khz = rate[0][0] / 1000
            khz_s = f"{khz:.1f}".rstrip("0").rstrip(".")
            return f"{label} · {depth[0][0]}/{khz_s}"
        return label
    br = Counter(round(t.bitrate / 8) * 8 for t in sample if t.bitrate).most_common(1)
    return f"{label} · {br[0][0]}" if br else label


class IndexContext:
    """Кэши на время одного прохода: исполнители и альбомы по ключу, затронутые альбомы."""

    def __init__(self) -> None:
        self.artists: dict[str, int] = {}
        self.albums: dict[str, Album] = {}
        self.new_albums: set[int] = set()
        self.touched: set[int] = set()

    def reset_caches(self) -> None:
        """После отката точки сохранения в кэшах могут остаться id, которых нет в базе."""
        self.artists.clear()
        self.albums.clear()


def album_for(db: Session, lib: Library, rel: str, meta: TrackMeta, ctx: IndexContext) -> Album:
    folder = os.path.dirname(rel)
    parts = folder.split("/") if folder else []
    if parts and DISC_DIR.match(parts[-1]) and len(parts) > 1:
        folder = "/".join(parts[:-1])  # Альбом/CD1 → Альбом
    if lib.kind == "audiobooks":
        # Книга = папка (теги «альбома» у глав часто разные). Файл в корне — отдельная книга.
        if folder:
            name = parse_book_folder(os.path.basename(folder)).title
            key_src = f"{lib.id}|book|{folder.lower()}"
        else:
            name = clean(meta.album) or os.path.splitext(os.path.basename(rel))[0]
            key_src = f"{lib.id}|book-file|{rel.lower()}"
        name = clean(name) or "Без названия"
        key = hashlib.sha1(key_src.encode("utf-8", "surrogateescape")).hexdigest()
    else:
        name = clean(meta.album or (os.path.basename(folder) if folder else "Без альбома")) or "Без альбома"
        key = hashlib.sha1(f"{lib.id}|{folder.lower()}|{name.lower()}".encode("utf-8", "surrogateescape")).hexdigest()
    album = ctx.albums.get(key)
    if album is None:
        album = db.scalar(select(Album).where(Album.album_key == key))
        if album is None:
            album = Album(library_id=lib.id, album_key=key, name=name[:512], sort_name=sort_name(name)[:512], folder=folder)
            db.add(album)
            db.flush()
            ctx.new_albums.add(album.id)
        ctx.albums[key] = album
    return album


def index_file(
    db: Session,
    lib: Library,
    root: Path,
    abs_path: Path,
    rel: str,
    st: os.stat_result,
    track: Track | None,
    ctx: IndexContext,
) -> tuple[bool, bool]:
    """Прочитать файл и создать/обновить трек. Возвращает (добавлен_новый, теги_прочитаны)."""
    ok = True
    try:
        meta = read_meta(abs_path)
    except Exception as exc:  # noqa: BLE001
        log.warning("Не удалось прочитать теги %s: %s", rel, exc)
        meta = TrackMeta()
        ok = False
    if track is not None:
        ctx.touched.add(track.album_id)
    album = album_for(db, lib, rel, meta, ctx)
    ctx.touched.add(album.id)
    artist_name = clean(meta.artist or meta.album_artist, 512).strip() or UNKNOWN_ARTIST
    if lib.kind == "audiobooks":
        # у книги «исполнитель» — автор: из структуры Автор/Серия/Книга, иначе из тегов
        path_author = split_path(album.folder)[0] if album.folder else ""
        artist_name = clean(path_author or meta.album_artist or meta.artist, 512).strip() or UNKNOWN_AUTHOR
    artist_id = get_or_create_artist(db, artist_name, ctx.artists)
    added = track is None
    if track is None:
        track = Track(library_id=lib.id, path=rel, path_hash=path_hash(rel), created_at=utcnow())
    fname = abs_path.name
    track.album_id = album.id
    track.artist_id = artist_id
    track.title = clean(meta.title or os.path.splitext(fname)[0], 512) or "Без названия"
    track.artist_name = clean(artist_name, 512)
    track.album_artist_name = clean(meta.album_artist, 512)
    track.track_no = meta.track_no or _track_from_name(fname)
    track.disc_no = meta.disc_no or _disc_from_dir(str(abs_path.parent))
    track.year = meta.year
    track.genre = clean(meta.genre, 128)
    track.duration = meta.duration
    track.bitrate = meta.bitrate
    track.sample_rate = meta.sample_rate
    track.bit_depth = meta.bit_depth
    track.channels = meta.channels
    track.codec = clean(meta.codec, 32)
    track.suffix = abs_path.suffix.lower().lstrip(".")
    track.size = st.st_size
    track.mtime = st.st_mtime
    track.has_cover = meta.has_cover
    track.lyrics = clean(meta.lyrics or _sidecar_lyrics(abs_path), LYRICS_MAX) or None
    track.replaygain = meta.rg_track
    track.replaygain_album = meta.rg_album
    if added:
        db.add(track)
    return added, ok


def update_library_stats(db: Session, lib: Library) -> None:
    stats = db.execute(
        select(func.count(Track.id), func.coalesce(func.sum(Track.size), 0), func.coalesce(func.sum(Track.duration), 0)).where(
            Track.library_id == lib.id
        )
    ).one()
    lib.track_count = stats[0]
    lib.total_size = int(stats[1])
    lib.total_duration = int(stats[2])
    lib.album_count = db.scalar(select(func.count(Album.id)).where(Album.library_id == lib.id)) or 0


# Индексация из запросов (загрузка, редактор тегов) и сканер не должны писать одну папку одновременно
index_lock = threading.RLock()


def reindex_paths(db: Session, lib: Library, rels: list[str], removed: list[str] | None = None) -> bool:
    """Сразу обновить в базе указанные файлы папки. False — идёт сканирование, файлы попадут в него."""
    if not index_lock.acquire(timeout=3):
        scanner.start(library_id=lib.id)
        return False
    try:
        root = Path(lib.path)
        ctx = IndexContext()
        need_cleanup = bool(removed)
        for rel in removed or []:
            track = db.scalar(select(Track).where(Track.library_id == lib.id, Track.path_hash == path_hash(rel)))
            if track:
                ctx.touched.add(track.album_id)
                db.delete(track)
            db.execute(delete(Upload).where(Upload.library_id == lib.id, Upload.path_hash == path_hash(rel)))
        db.flush()
        for rel in rels:
            abs_path = root / rel
            try:
                st = abs_path.stat()
            except OSError:
                continue
            track = db.scalar(select(Track).where(Track.library_id == lib.id, Track.path_hash == path_hash(rel)))
            need_cleanup = need_cleanup or track is not None  # правка тегов может «осиротить» исполнителя
            index_file(db, lib, root, abs_path, rel, st, track, ctx)
        db.flush()
        for album_id in ctx.touched:
            finalize_album(db, album_id, root, album_id in ctx.new_albums, ctx.artists)
        db.flush()
        if need_cleanup:
            cleanup_orphans(db)
        update_library_stats(db, lib)
        db.commit()
        return True
    finally:
        index_lock.release()


class Scanner:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._pending: list[tuple[int | None, bool]] = []
        self._state: dict = {
            "running": False,
            "library_id": None,
            "library_name": None,
            "phase": "",
            "checked": 0,
            "changed": 0,
            "started_at": None,
            "finished_at": None,
            "last_result": None,
        }
        self._scheduler: threading.Thread | None = None
        self._last_auto = time.monotonic()

    # ---------- публичное API ----------

    def status(self) -> dict:
        with self._lock:
            return dict(self._state)

    def start(self, library_id: int | None = None, full: bool = False) -> bool:
        """Поставить сканирование в очередь. Возвращает True, если запущено сразу."""
        if not dbmod.is_configured():
            return False
        with self._lock:
            if self._state["running"]:
                if (library_id, full) not in self._pending:
                    self._pending.append((library_id, full))
                return False
            self._state.update(running=True, checked=0, changed=0, started_at=utcnow(), phase="Подготовка")
            self._thread = threading.Thread(target=self._run, args=(library_id, full), daemon=True, name="scanner")
            self._thread.start()
            return True

    def start_scheduler(self) -> None:
        if self._scheduler and self._scheduler.is_alive():
            return
        self._scheduler = threading.Thread(target=self._schedule_loop, daemon=True, name="scan-scheduler")
        self._scheduler.start()

    # ---------- внутреннее ----------

    def _schedule_loop(self) -> None:
        time.sleep(5)
        full = False
        try:
            with dbmod.session_scope() as db:
                if get_setting(db, "index_version") != INDEX_VERSION:
                    full = True
                    set_setting(db, "index_version", INDEX_VERSION)
                    db.commit()
        except Exception:  # noqa: BLE001
            log.exception("Проверка версии индекса")
        if full:
            log.info("Новая версия чтения тегов — полное пересканирование")
        self.start(full=full)  # при запуске: быстрая инкрементальная проверка (или полная после обновления)
        while True:
            time.sleep(30)
            try:
                with dbmod.session_scope() as db:
                    raw = get_setting(db, "scan_interval")
                interval = int(raw) if raw.isdigit() else 60
                if interval > 0 and time.monotonic() - self._last_auto >= interval * 60:
                    self._last_auto = time.monotonic()
                    self.start()
            except Exception:  # noqa: BLE001
                log.exception("Планировщик сканирования")

    def _run(self, library_id: int | None, full: bool) -> None:
        jobs = [(library_id, full)]
        totals = {"added": 0, "updated": 0, "removed": 0, "errors": 0}
        while jobs:
            lib_id, is_full = jobs.pop(0)
            try:
                with dbmod.session_scope() as db:
                    query = select(Library).where(Library.enabled.is_(True)).order_by(Library.id)
                    if lib_id is not None:
                        query = select(Library).where(Library.id == lib_id)
                    for lib in list(db.scalars(query)):
                        with self._lock:
                            self._state.update(library_id=lib.id, library_name=lib.name, phase="Поиск файлов")
                        with index_lock:
                            result = self._scan_library(db, lib, is_full)
                        for k in totals:
                            totals[k] += result.get(k, 0)
                    cleanup_orphans(db)
                    db.commit()
            except Exception:  # noqa: BLE001
                log.exception("Ошибка сканирования")
                totals["errors"] += 1
            with self._lock:
                if self._pending:
                    jobs.append(self._pending.pop(0))
                else:
                    # под тем же замком: запрос, пришедший в эту секунду, не потеряется
                    self._state.update(
                        running=False,
                        phase="",
                        library_id=None,
                        library_name=None,
                        finished_at=utcnow(),
                        last_result=totals,
                    )
        self._last_auto = time.monotonic()
        log.info("Сканирование завершено: %s", totals)

    def _progress(self, checked: int | None = None, changed: int | None = None, phase: str | None = None) -> None:
        with self._lock:
            if checked is not None:
                self._state["checked"] = checked
            if changed is not None:
                self._state["changed"] = changed
            if phase is not None:
                self._state["phase"] = phase

    def _scan_library(self, db: Session, lib: Library, full: bool) -> dict:
        root = Path(lib.path)
        result = {"added": 0, "updated": 0, "removed": 0, "errors": 0}
        existing = {
            row.path: row
            for row in db.execute(
                select(Track.id, Track.path, Track.mtime, Track.size, Track.album_id).where(Track.library_id == lib.id)
            )
        }
        if not root.is_dir():
            lib.last_scan_error = "Папка недоступна внутри контейнера — проверьте volumes в docker-compose"
            lib.last_scan_at = utcnow()
            db.commit()
            return result

        ctx = IndexContext()
        seen: set[str] = set()
        checked = changed = 0
        visited: set[tuple[int, int]] = set()  # защита от петель из символических ссылок
        bad_names: list[str] = []
        last_commit = time.monotonic()

        for dirpath, dirnames, filenames in os.walk(root, followlinks=True):
            try:
                dst = os.stat(dirpath)
                if (dst.st_dev, dst.st_ino) in visited:
                    dirnames[:] = []
                    continue
                visited.add((dst.st_dev, dst.st_ino))
            except OSError:
                continue
            dirnames[:] = sorted(d for d in dirnames if not SKIP_DIRS.match(d))
            for fname in sorted(filenames):
                ext = os.path.splitext(fname)[1].lower()
                if ext not in AUDIO_EXTENSIONS or fname.startswith("."):
                    continue
                abs_path = Path(dirpath) / fname
                rel = abs_path.relative_to(root).as_posix()
                if not decodable(rel):
                    bad_names.append(rel.encode("utf-8", "backslashreplace").decode())
                    continue
                try:
                    st = abs_path.stat()
                except OSError:
                    continue
                seen.add(rel)
                checked += 1
                old = existing.get(rel)
                if old and not full and abs(old.mtime - st.st_mtime) < 0.01 and old.size == st.st_size:
                    if checked % 500 == 0:
                        self._progress(checked=checked)
                    continue
                track = db.get(Track, old.id) if old else None
                try:
                    # каждый файл — в своей точке сохранения: один «битый» файл не валит весь скан
                    with db.begin_nested():
                        added, ok = index_file(db, lib, root, abs_path, rel, st, track, ctx)
                except Exception as exc:  # noqa: BLE001
                    log.warning("Файл пропущен %s: %s", rel, exc)
                    result["errors"] += 1
                    ctx.reset_caches()  # старая запись (если была) остаётся как есть
                    continue
                result["added" if added else "updated"] += 1
                if not ok:
                    result["errors"] += 1
                changed += 1
                if changed % BATCH == 0 or time.monotonic() - last_commit > COMMIT_EVERY:
                    db.commit()
                    last_commit = time.monotonic()
                if checked % 50 == 0:
                    self._progress(checked=checked, changed=changed)
        if bad_names:
            result["errors"] += len(bad_names)
            log.warning("Пропущено файлов с нечитаемым именем: %d, например: %s", len(bad_names), bad_names[0])

        self._progress(checked=checked, changed=changed, phase="Обновление альбомов")
        missing = [row for path, row in existing.items() if path not in seen]
        if missing and not seen:
            # Папка пуста, а в базе были треки — скорее всего, том не смонтирован. Ничего не удаляем.
            lib.last_scan_error = "В папке не найдено ни одного файла — медиатека не изменена"
            lib.last_scan_at = utcnow()
            db.commit()
            return result
        for i in range(0, len(missing), 500):
            chunk = missing[i : i + 500]
            ctx.touched.update(r.album_id for r in chunk)
            db.execute(delete(Track).where(Track.id.in_([r.id for r in chunk])))
            db.execute(
                delete(Upload).where(Upload.library_id == lib.id, Upload.path_hash.in_([path_hash(r.path) for r in chunk]))
            )
        result["removed"] = len(missing)
        db.commit()

        album_ids = ctx.touched
        if full:
            album_ids = ctx.touched | set(db.scalars(select(Album.id).where(Album.library_id == lib.id)))
        for n, album_id in enumerate(album_ids, 1):
            finalize_album(db, album_id, root, album_id in ctx.new_albums, ctx.artists)
            if n % BATCH == 0:
                db.commit()
        db.commit()

        update_library_stats(db, lib)
        lib.last_scan_at = utcnow()
        lib.last_scan_error = (
            f"Пропущено файлов с нечитаемым именем: {len(bad_names)} (например, {bad_names[0][:200]}). Переименуйте их."
            if bad_names
            else None
        )
        db.commit()
        log.info("Папка «%s»: %s", lib.name, result)
        return result

def get_or_create_artist(db: Session, name: str, cache: dict[str, int] | None = None) -> int:
    key = name_key(name) or name_key(UNKNOWN_ARTIST)
    if cache is not None and key in cache:
        return cache[key]
    artist_id = db.scalar(select(Artist.id).where(Artist.name_key == key))
    if artist_id is None:
        artist = Artist(name=name.strip()[:512], sort_name=sort_name(name)[:512], name_key=key)
        db.add(artist)
        db.flush()
        artist_id = artist.id
    if cache is not None:
        cache[key] = artist_id
    return artist_id


def _track_from_name(fname: str) -> int | None:
    m = re.match(r"^\s*(?:\d-)?(\d{1,3})[\s._-]", fname)
    return int(m.group(1)) if m else None


def _disc_from_dir(dirpath: str) -> int | None:
    base = os.path.basename(dirpath)
    if DISC_DIR.match(base):
        m = re.search(r"\d+", base)
        return int(m.group()) if m else None
    return None


def _sidecar_lyrics(path: Path) -> str | None:
    lrc = path.with_suffix(".lrc")
    if lrc.is_file():
        try:
            return lrc.read_text("utf-8", errors="replace")[:100_000]
        except OSError:
            return None
    return None


def find_folder_cover(folder: Path) -> Path | None:
    try:
        files = [e for e in os.scandir(folder) if e.is_file() and e.name.lower().endswith(IMAGE_EXTENSIONS)]
    except OSError:
        return None
    if not files:
        return None
    by_stem = {os.path.splitext(e.name)[0].lower(): e for e in files}
    for name in COVER_NAMES:
        if name in by_stem:
            return Path(by_stem[name].path)
    for e in sorted(files, key=lambda e: e.name.lower()):
        if any(w in e.name.lower() for w in ("cover", "front", "folder")):
            return Path(e.path)
    if len(files) == 1:
        return Path(files[0].path)
    return None


def finalize_album(db: Session, album_id: int, root: Path, is_new: bool, artist_cache: dict[str, int]) -> None:
    album = db.get(Album, album_id)
    if album is None:
        return
    fields = ("track_count", "duration", "size", "disc_count", "year", "genre", "artist_name", "artist_id", "quality", "cover")
    before = tuple(getattr(album, f) for f in fields)
    tracks = list(db.scalars(select(Track).where(Track.album_id == album_id)))
    if not tracks:
        db.delete(album)
        return
    album.track_count = len(tracks)
    album.duration = int(sum(t.duration for t in tracks))
    album.size = sum(t.size for t in tracks)
    album.disc_count = max((t.disc_no or 1) for t in tracks)
    years = Counter(t.year for t in tracks if t.year)
    album.year = years.most_common(1)[0][0] if years else None
    genres = Counter(t.genre for t in tracks if t.genre)
    album.genre = genres.most_common(1)[0][0] if genres else ""
    album_artists = Counter(t.album_artist_name for t in tracks if t.album_artist_name)
    if album_artists:
        artist_name = album_artists.most_common(1)[0][0]
    else:
        names = {t.artist_name for t in tracks if t.artist_name}
        artist_name = names.pop() if len(names) == 1 else (VARIOUS if names else UNKNOWN_ARTIST)
    album.artist_name = artist_name[:512]
    album.artist_id = get_or_create_artist(db, artist_name, artist_cache)
    album.quality = format_quality(tracks)

    folder_path = root / album.folder if album.folder else root
    cover_file = find_folder_cover(folder_path)
    if cover_file is None:
        # Обложка может лежать в подпапке диска (Альбом/CD1/cover.jpg)
        for t in tracks:
            sub = (root / t.path).parent
            if sub != folder_path:
                cover_file = find_folder_cover(sub)
                if cover_file:
                    break
    if cover_file is not None:
        album.cover = "file:" + cover_file.relative_to(root).as_posix()
    else:
        embedded = next((t for t in sorted(tracks, key=lambda t: (t.disc_no or 1, t.track_no or 0)) if t.has_cover), None)
        album.cover = f"embed:{embedded.id}" if embedded else None
    if is_new:
        newest = max(t.mtime for t in tracks)
        album.created_at = min(datetime.fromtimestamp(newest, timezone.utc), utcnow())
    lib = db.get(Library, album.library_id)
    if lib is not None and lib.kind == "audiobooks":
        _finalize_book(db, album, tracks, root, artist_cache)
    if is_new or tuple(getattr(album, f) for f in fields) != before:
        album.updated_at = utcnow()  # от него зависит адрес обложки — меняем только при изменениях


def book_tracks_sorted(tracks: list[Track]) -> list[Track]:
    """Главы по порядку: диск, номер (если у всех разные), иначе «естественная» сортировка имён."""
    nums = [t.track_no for t in tracks]
    use_no = all(n for n in nums) and len(set(zip([t.disc_no or 1 for t in tracks], nums))) == len(tracks)
    if use_no:
        return sorted(tracks, key=lambda t: (t.disc_no or 1, t.track_no or 0, natural_key(t.path)))
    return sorted(tracks, key=lambda t: natural_key(t.path))


def _finalize_book(db: Session, album: Album, tracks: list[Track], root: Path, artist_cache: dict[str, int]) -> None:
    """Метаданные книги: папка (Автор/Серия/Книга), desc.txt/reader.txt, теги первой главы, главы m4b."""
    ordered = book_tracks_sorted(tracks)
    first = ordered[0]
    path_author, path_series, folder_name = split_path(album.folder)
    parsed = parse_book_folder(folder_name) if folder_name else None
    folder_path = (root / album.folder) if album.folder else (root / first.path).parent
    tags = book_tags(root / first.path)
    book = db.get(Book, album.id) or Book(album_id=album.id)
    author = path_author or tags.get("author") or (album.artist_name if album.artist_name not in (VARIOUS, UNKNOWN_ARTIST) else "")
    book.author = (clean(author, 512) or UNKNOWN_AUTHOR).strip()
    book.series = clean(path_series or tags.get("series") or "", 512)
    book.series_seq = parsed.seq if parsed and parsed.seq is not None else tags.get("series_seq")
    book.narrator = clean(
        (parsed.narrator if parsed else "") or read_text_file(folder_path, ("reader.txt", "narrator.txt"), 500) or tags.get("narrator") or "",
        512,
    )
    book.subtitle = clean(tags.get("subtitle") or "", 512)
    book.description = clean(read_text_file(folder_path, ("desc.txt", "description.txt")) or tags.get("description") or "", 20000)
    # главы внутри одного большого файла
    chapters = []
    if len(ordered) == 1:
        chapters = [{"track_id": first.id, **c} for c in file_chapters(root / first.path)]
    book.chapters = json.dumps(chapters, ensure_ascii=False)
    if parsed and parsed.year and not album.year:
        album.year = parsed.year
    album.artist_name = book.author[:512]
    album.artist_id = get_or_create_artist(db, book.author, artist_cache)
    if album.genre == "":
        album.genre = "Аудиокнига"
    db.merge(book)


def cleanup_orphans(db: Session) -> None:
    """Удаляем исполнителей без альбомов и треков, избранное на удалённые объекты."""
    used = select(Album.artist_id).where(Album.artist_id.is_not(None)).union(
        select(Track.artist_id).where(Track.artist_id.is_not(None))
    )
    db.execute(delete(Artist).where(Artist.id.not_in(used)))
    db.execute(delete(Star).where(Star.kind == "track", Star.item_id.not_in(select(Track.id))))
    db.execute(delete(Star).where(Star.kind == "album", Star.item_id.not_in(select(Album.id))))
    db.execute(delete(Star).where(Star.kind == "artist", Star.item_id.not_in(select(Artist.id))))
    db.execute(delete(Album).where(Album.id.not_in(select(Track.album_id))))
    # для истории album_id не нужен ссылочной целостности — обнулим потерянные
    db.execute(update(Play).where(or_(Play.album_id.not_in(select(Album.id)))).values(album_id=None))
    _ = PlaylistEntry  # записи плейлистов удаляются каскадом вместе с треками


scanner = Scanner()


def _on_db_ready() -> None:
    scanner.start_scheduler()


dbmod.on_ready(_on_db_ready)
