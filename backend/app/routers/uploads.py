"""Загрузка музыки, удаление своих файлов, редактор тегов и обложек."""
from __future__ import annotations

import io
import os
import re
import shutil
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from PIL import Image, ImageOps
from pydantic import BaseModel, Field
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from .. import folders
from ..access import (
    allowed_library_ids,
    can_edit_track,
    can_write,
    fs_writable,
    upload_root_ok,
    upload_targets,
    upload_usage,
)
from ..db import get_db
from ..models import Album, Library, Track, Upload, User
from ..queries import album_tracks
from ..scanner import AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, path_hash, reindex_paths
from ..security import get_current_user
from ..tags import EDITABLE, TagWriteError, read_editable, read_meta, write_tags

router = APIRouter(prefix="/api", tags=["uploads"])

MB = 1024 * 1024
MAX_FILE = 2048 * MB  # одиночный файл — не больше 2 ГБ
CHUNK = 1024 * 1024
_BAD = re.compile(r'[\x00-\x1f<>:"\\|?*]')


def _safe_part(name: str, fallback: str = "_") -> str:
    name = _BAD.sub("_", name).strip().strip(".").strip()
    name = re.sub(r"\s+", " ", name)
    return name[:120] or fallback


def _safe_rel_dir(raw: str) -> str:
    parts = [p for p in re.split(r"[\\/]+", raw or "") if p not in ("", ".", "..")]
    return "/".join(_safe_part(p) for p in parts[:8])


def _unique(path: Path) -> Path:
    if not path.exists():
        return path
    stem, suffix = path.stem, path.suffix
    for i in range(2, 1000):
        candidate = path.with_name(f"{stem} ({i}){suffix}")
        if not candidate.exists():
            return candidate
    return path.with_name(f"{stem}-{uuid.uuid4().hex[:6]}{suffix}")


# Пакетная загрузка папки: куда «разложились» аудиофайлы из каждой исходной подпапки,
# чтобы положить туда же обложку (cover.jpg) из этой подпапки.
_BATCH_DIRS: dict[tuple[int, str, str], tuple[str, float]] = {}
_batch_lock = threading.Lock()


def _remember_dir(user_id: int, batch: str, src_dir: str, dest_dir: str) -> None:
    with _batch_lock:
        now = time.time()
        for key in [k for k, (_, t) in _BATCH_DIRS.items() if now - t > 6 * 3600]:
            _BATCH_DIRS.pop(key, None)
        _BATCH_DIRS[(user_id, batch, src_dir)] = (dest_dir, now)


def _lookup_dir(user_id: int, batch: str, src_dir: str) -> str | None:
    with _batch_lock:
        hit = _BATCH_DIRS.get((user_id, batch, src_dir))
        return hit[0] if hit else None


def _info(db: Session, user: User) -> dict:
    used_bytes, used_files = upload_usage(db, user.id)
    targets = upload_targets(db, user)
    db.commit()  # personal_library мог создать личную папку
    mode = "libraries" if user.is_admin else user.upload_mode
    return {
        "mode": mode,
        "limits": {
            "bytes": 0 if user.is_admin else user.upload_quota_mb * MB,
            "files": 0 if user.is_admin else user.upload_max_files,
        },
        "used": {"bytes": used_bytes, "files": used_files},
        "targets": [{"id": lib.id, "name": lib.name, "personal": lib.owner_id == user.id, "kind": lib.kind} for lib in targets],
        "personal_available": upload_root_ok(),
    }


@router.get("/uploads/info")
def upload_info(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    return _info(db, user)


# Сколько байт каждый пользователь загружает прямо сейчас — чтобы параллельные загрузки
# не проскочили лимит, проверенный до записи.
_inflight: dict[int, int] = {}
_inflight_lock = threading.Lock()


# Обычная (не async) функция: FastAPI выполнит её в пуле потоков, и запись файла,
# чтение тегов и индексация не блокируют остальные запросы (потоки, обложки).
@router.post("/uploads")
def upload_file(
    file: UploadFile = File(...),
    library_id: int = Form(...),
    relative_path: str = Form(""),
    organize: bool = Form(True),
    batch: str = Form(""),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    targets = {lib.id: lib for lib in upload_targets(db, user)}
    db.commit()
    lib = targets.get(library_id)
    if lib is None:
        raise HTTPException(403, "Нет права загружать в эту папку")

    original = os.path.basename((file.filename or "").replace("\\", "/")) or "track"
    ext = os.path.splitext(original)[1].lower()
    is_audio = ext in AUDIO_EXTENSIONS
    if not is_audio and ext not in IMAGE_EXTENSIONS:
        raise HTTPException(415, f"Файл «{original}» не похож на музыку")

    used_bytes, used_files = upload_usage(db, user.id)
    limit_bytes = 0 if user.is_admin else user.upload_quota_mb * MB
    limit_files = 0 if user.is_admin else user.upload_max_files
    if is_audio and limit_files and used_files >= limit_files:
        raise HTTPException(413, f"Достигнут лимит: {limit_files} файлов")
    with _inflight_lock:
        pending = _inflight.get(user.id, 0)
        allowed = MAX_FILE if not limit_bytes else min(MAX_FILE, limit_bytes - used_bytes - pending)
        if allowed <= 0:
            raise HTTPException(413, "Закончилось место для загрузок")
        declared = getattr(file, "size", None) or 0
        reserve = min(declared or allowed, allowed)
        _inflight[user.id] = pending + reserve
    try:
        return _store_upload(db, user, lib, file, original, ext, is_audio, allowed, relative_path, organize, batch)
    finally:
        with _inflight_lock:
            left = _inflight.get(user.id, 0) - reserve
            if left > 0:
                _inflight[user.id] = left
            else:
                _inflight.pop(user.id, None)


def _store_upload(
    db: Session, user: User, lib: Library, file: UploadFile, original: str, ext: str, is_audio: bool,
    allowed: int, relative_path: str, organize: bool, batch: str,
) -> dict:

    root = Path(lib.path).resolve()
    tmp = root / f".selfmusic-upload-{uuid.uuid4().hex}{ext}"
    size = 0
    try:
        with open(tmp, "wb") as out:
            while chunk := file.file.read(CHUNK):
                size += len(chunk)
                if size > allowed:
                    raise HTTPException(
                        413, "Файл больше 2 ГБ" if allowed == MAX_FILE else "Не хватает места в лимите загрузок"
                    )
                out.write(chunk)
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise HTTPException(500, f"Не удалось сохранить файл: {exc.strerror}")

    if not is_audio:
        try:
            with Image.open(tmp) as probe:
                probe.verify()
        except Exception:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            raise HTTPException(415, f"«{original}» — не картинка")

    src_dir = _safe_rel_dir(os.path.dirname((relative_path or "").replace("\\", "/")))
    dest_dir = src_dir
    if is_audio and organize:
        try:
            meta = read_meta(tmp)
        except Exception:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            raise HTTPException(415, f"«{original}» не удалось прочитать как аудиофайл")
        artist = _safe_part(meta.album_artist or meta.artist or "Неизвестный исполнитель")
        album = _safe_part(meta.album or "Без альбома")
        dest_dir = f"{artist}/{album}"
    elif is_audio:
        try:
            read_meta(tmp)
        except Exception:  # noqa: BLE001
            tmp.unlink(missing_ok=True)
            raise HTTPException(415, f"«{original}» не удалось прочитать как аудиофайл")
    elif organize:
        dest_dir = _lookup_dir(user.id, batch, src_dir) or src_dir
    if is_audio and batch:
        _remember_dir(user.id, batch, src_dir, dest_dir)

    target_dir = (root / dest_dir).resolve() if dest_dir else root
    if target_dir != root and root not in target_dir.parents:
        tmp.unlink(missing_ok=True)
        raise HTTPException(400, "Недопустимый путь")
    if dest_dir and not folders.included(folders.parse(lib.folder_rules), dest_dir):
        # файл лёг бы в исключённую папку: в медиатеке его не будет, а квоту займёт
        tmp.unlink(missing_ok=True)
        raise HTTPException(409, f"Папка «{dest_dir}» исключена из медиатеки — загрузка туда недоступна")
    try:
        target_dir.mkdir(parents=True, exist_ok=True)
        if not is_audio and (target_dir / _safe_part(original)).exists():
            # Обложку с тем же именем не дублируем
            tmp.unlink(missing_ok=True)
            return {"path": None, "skipped": True}
        dest = _unique(target_dir / _safe_part(original, f"track{ext}"))
        os.replace(tmp, dest)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        raise HTTPException(500, f"Не удалось сохранить файл: {exc.strerror}")
    rel = dest.relative_to(root).as_posix()
    db.add(Upload(user_id=user.id, library_id=lib.id, path=rel, path_hash=path_hash(rel), size=size))
    db.commit()

    indexed = False
    track_id = None
    if is_audio:
        indexed = reindex_paths(db, lib, [rel])
        track_id = db.scalar(select(Track.id).where(Track.library_id == lib.id, Track.path_hash == path_hash(rel)))
    else:
        # Новая обложка — пересобрать альбомы этой папки
        albums = list(db.scalars(select(Track.path).where(Track.library_id == lib.id, Track.path.like(f"{os.path.dirname(rel)}/%"))))
        if albums:
            indexed = reindex_paths(db, lib, albums[:1])
    return {"path": rel, "size": size, "library_id": lib.id, "track_id": track_id, "indexed": indexed}


@router.get("/uploads/mine")
def my_uploads(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    rows = db.execute(
        select(Upload, Library.name, Track.id, Track.title, Track.artist_name, Track.album_id)
        .join(Library, Library.id == Upload.library_id)
        .outerjoin(Track, (Track.library_id == Upload.library_id) & (Track.path_hash == Upload.path_hash))
        .where(Upload.user_id == user.id)
        .order_by(desc(Upload.created_at))
        .limit(500)
    ).all()
    return [
        {
            "id": up.id,
            "path": up.path,
            "size": up.size,
            "created_at": up.created_at,
            "library": lib_name,
            "track_id": tid,
            "title": title,
            "artist": artist,
            "album_id": album_id,
        }
        for up, lib_name, tid, title, artist, album_id in rows
    ]


# Что можно удалить вместе с последним треком папки. Буклеты, .cue, .log, видео — не трогаем.
_DISPOSABLE_EXT = set(IMAGE_EXTENSIONS) | {".lrc"}
_JUNK = {".DS_Store", "Thumbs.db", "desktop.ini", "@eaDir"}


def _remove_empty_dirs(root: Path, start: Path) -> None:
    current = start
    while current != root and root in current.parents:
        try:
            entries = list(current.iterdir())
            junk = [p for p in entries if p.name in _JUNK or p.name.startswith("._")]
            rest = [p for p in entries if p not in junk]
            if any(p.is_dir() or p.suffix.lower() not in _DISPOSABLE_EXT for p in rest):
                return  # в папке есть что-то ещё — оставляем как есть
            for p in rest + junk:
                if p.is_dir():
                    shutil.rmtree(p, ignore_errors=True)  # @eaDir — миниатюры DSM
                else:
                    p.unlink(missing_ok=True)
            current.rmdir()
        except OSError:
            return
        current = current.parent


@router.delete("/tracks/{track_id}")
def delete_track(track_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Удалить файл с диска: свой загруженный — сам пользователь, любой — администратор."""
    track = db.get(Track, track_id)
    if not track or track.library_id not in allowed_library_ids(db, user, kind="any"):
        raise HTTPException(404, "Трек не найден")
    lib = db.get(Library, track.library_id)
    up = db.scalar(select(Upload).where(Upload.library_id == lib.id, Upload.path_hash == track.path_hash))
    own = bool(up and up.user_id == user.id)
    if not (own or (user.is_admin and can_write(db, user, lib))):
        raise HTTPException(403, "Удалять можно только свои загруженные файлы")
    if not fs_writable(lib.path):
        raise HTTPException(409, "Папка доступна только для чтения")
    root = Path(lib.path).resolve()
    path = (root / track.path).resolve()
    if root not in path.parents:
        raise HTTPException(400, "Недопустимый путь")
    try:
        path.unlink(missing_ok=True)
    except OSError as exc:
        raise HTTPException(500, f"Не удалось удалить файл: {exc.strerror}")
    lrc = path.with_suffix(".lrc")
    if lrc.exists():
        lrc.unlink(missing_ok=True)
    rel = track.path
    reindex_paths(db, lib, [], removed=[rel])
    _remove_empty_dirs(root, path.parent)
    return {"ok": True}


# ---------------- редактор тегов ----------------


class TagChanges(BaseModel):
    title: str | None = Field(default=None, max_length=512)
    artist: str | None = Field(default=None, max_length=512)
    album_artist: str | None = Field(default=None, max_length=512)
    album: str | None = Field(default=None, max_length=512)
    track: str | None = Field(default=None, max_length=16)
    disc: str | None = Field(default=None, max_length=16)
    year: str | None = Field(default=None, max_length=16)
    genre: str | None = Field(default=None, max_length=128)
    lyrics: str | None = Field(default=None, max_length=100_000)


class AlbumTagChanges(BaseModel):
    album: str | None = Field(default=None, max_length=512)
    album_artist: str | None = Field(default=None, max_length=512)
    artist: str | None = Field(default=None, max_length=512)
    year: str | None = Field(default=None, max_length=16)
    genre: str | None = Field(default=None, max_length=128)
    # Поштучные изменения: {track_id: {...}}
    tracks: dict[int, TagChanges] = {}


def _track_ctx(db: Session, user: User, track_id: int) -> tuple[Track, Library, Path]:
    track = db.get(Track, track_id)
    if not track or track.library_id not in allowed_library_ids(db, user, kind="any"):
        raise HTTPException(404, "Трек не найден")
    lib = db.get(Library, track.library_id)
    root = Path(lib.path).resolve()
    path = (root / track.path).resolve()
    if root not in path.parents or not path.is_file():
        raise HTTPException(404, "Файл недоступен")
    return track, lib, path


def _edit_reason(db: Session, user: User, lib: Library, track: Track) -> str | None:
    if not fs_writable(lib.path):
        return "Папка смонтирована только для чтения — откройте её на запись в docker-compose"
    if not can_edit_track(db, user, lib, track.path):
        return "Нужно право записи на эту папку"
    return None


@router.get("/tracks/{track_id}/tags")
def get_tags(track_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    track, lib, path = _track_ctx(db, user, track_id)
    try:
        tags = read_editable(path)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(422, f"Не удалось прочитать теги: {exc}")
    reason = _edit_reason(db, user, lib, track)
    return {"tags": tags, "editable": reason is None, "reason": reason, "file": track.path.rsplit("/", 1)[-1], "suffix": track.suffix}


@router.put("/tracks/{track_id}/tags")
def put_tags(
    track_id: int, data: TagChanges, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    track, lib, path = _track_ctx(db, user, track_id)
    reason = _edit_reason(db, user, lib, track)
    if reason:
        raise HTTPException(403, reason)
    try:
        write_tags(path, data.model_dump(exclude_none=True))
    except TagWriteError as exc:
        raise HTTPException(422, str(exc))
    rel = track.path
    reindex_paths(db, lib, [rel])
    new = db.scalar(select(Track).where(Track.library_id == lib.id, Track.path_hash == path_hash(rel)))
    return {"ok": True, "track_id": new.id if new else None, "album_id": new.album_id if new else None}


@router.get("/albums/{album_id}/tags")
def get_album_tags(album_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    album = db.get(Album, album_id)
    if not album or album.library_id not in allowed_library_ids(db, user, kind="any"):
        raise HTTPException(404, "Альбом не найден")
    lib = db.get(Library, album.library_id)
    tracks = album_tracks(db, album.id)
    root = Path(lib.path).resolve()
    items = []
    reason = None
    for t in tracks:
        try:
            tags = read_editable(root / t.path)
        except Exception:  # noqa: BLE001
            tags = {k: "" for k in EDITABLE}
        r = _edit_reason(db, user, lib, t)
        reason = reason or r
        items.append({"id": t.id, "file": t.path.rsplit("/", 1)[-1], "suffix": t.suffix, "tags": tags, "editable": r is None})

    def common(key: str) -> str | None:
        values = {it["tags"].get(key, "") for it in items}
        return values.pop() if len(values) == 1 else None  # None — значения различаются

    return {
        "album": common("album") if items else album.name,
        "album_artist": common("album_artist"),
        "artist": common("artist"),
        "year": common("year"),
        "genre": common("genre"),
        "tracks": items,
        "editable": all(it["editable"] for it in items) and bool(items),
        "reason": reason,
        "has_cover": bool(album.cover),
    }


@router.put("/albums/{album_id}/tags")
def put_album_tags(
    album_id: int, data: AlbumTagChanges, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    album = db.get(Album, album_id)
    if not album or album.library_id not in allowed_library_ids(db, user, kind="any"):
        raise HTTPException(404, "Альбом не найден")
    lib = db.get(Library, album.library_id)
    tracks = album_tracks(db, album.id)
    root = Path(lib.path).resolve()
    common = data.model_dump(exclude_none=True, exclude={"tracks"})
    errors = []
    rels = []
    for t in tracks:
        reason = _edit_reason(db, user, lib, t)
        if reason:
            raise HTTPException(403, reason)
    for t in tracks:
        changes = dict(common)
        if t.id in data.tracks:
            changes.update(data.tracks[t.id].model_dump(exclude_none=True))
        if not changes:
            continue
        try:
            write_tags(root / t.path, changes)
            rels.append(t.path)
        except TagWriteError as exc:
            errors.append(f"{t.path.rsplit('/', 1)[-1]}: {exc}")
    if rels:
        reindex_paths(db, lib, rels)
    new_album = None
    if rels:
        new_album = db.scalar(
            select(Track.album_id).where(Track.library_id == lib.id, Track.path_hash == path_hash(rels[0]))
        )
    return {"ok": not errors, "errors": errors, "updated": len(rels), "album_id": new_album or album_id}


@router.post("/albums/{album_id}/cover")
def set_album_cover(
    album_id: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    album = db.get(Album, album_id)
    if not album or album.library_id not in allowed_library_ids(db, user, kind="any"):
        raise HTTPException(404, "Альбом не найден")
    lib = db.get(Library, album.library_id)
    tracks = album_tracks(db, album.id)
    if not tracks:
        raise HTTPException(404, "Альбом пуст")
    reason = _edit_reason(db, user, lib, tracks[0])
    if reason:
        raise HTTPException(403, reason)
    data = file.file.read(25 * MB + 1)
    if len(data) > 25 * MB:
        raise HTTPException(413, "Картинка больше 25 МБ")
    try:
        img = Image.open(io.BytesIO(data))
        img = ImageOps.exif_transpose(img).convert("RGB")
        img.thumbnail((1600, 1600), Image.LANCZOS)
    except Exception:  # noqa: BLE001
        raise HTTPException(415, "Это не картинка")
    root = Path(lib.path).resolve()
    folder = (root / album.folder).resolve() if album.folder else root
    if folder != root and root not in folder.parents:
        raise HTTPException(400, "Недопустимый путь")
    target = folder / "cover.jpg"
    try:
        # Другие картинки-обложки в папке переименовываем, чтобы новая точно стала главной
        for name in ("folder.jpg", "folder.png", "front.jpg", "front.png", "cover.png", "cover.webp", "cover.jpeg"):
            old = folder / name
            if old.exists():
                old.rename(_unique(folder / f"{old.stem}.old{old.suffix}"))
        img.save(target, "JPEG", quality=90)
    except OSError as exc:
        raise HTTPException(500, f"Не удалось сохранить обложку: {exc.strerror}")
    album.updated_at = datetime.now(timezone.utc)
    album.cover = "file:" + target.relative_to(root).as_posix()
    db.commit()
    return {"ok": True}

