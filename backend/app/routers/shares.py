"""Общие ссылки: управление (/api/shares) и публичный доступ без входа (/api/s/{token}).

Ссылка может вести на папку (или подпапку), альбом, исполнителя, плейлист или выбранные треки.
Содержимое папки, альбома, исполнителя и плейлиста «живое» — новые треки появляются и по ссылке.
Всё отдаётся с правами владельца ссылки: если ему закроют папку, по ссылке она тоже пропадёт.

Пароль проверяется один раз, после чего браузер получает cookie этой ссылки (sm_s_<token>).
В режиме «только слушать» поток всегда MP3 192 кбит/с, а скачивание запрещено.
"""
from __future__ import annotations

import json
import os
import secrets
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from sqlalchemy import Select, desc, func, select
from sqlalchemy.orm import Session

from .. import ratelimit
from ..access import allowed_library_ids
from ..app_settings import get_setting
from ..config import settings
from ..db import get_db
from ..media import content_type, cover_path, download_name, file_response, image_response, stream_track, track_file
from ..models import Album, Artist, Library, Playlist, PlaylistEntry, Share, Track, User, utcnow
from ..queries import album_tracks
from ..schemas import ShareCreate, SharePlay, ShareUnlock, ShareUpdate
from ..security import get_current_user, hash_password, verify_password
from ..serialize import cover_url, track_quality

router = APIRouter(tags=["shares"])

KIND_LABELS = {"folder": "Папка", "album": "Альбом", "artist": "Исполнитель", "playlist": "Плейлист", "tracks": "Подборка"}
LISTEN_BITRATE = 192


def _aware(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


# ---------------- содержимое ссылки ----------------


def _owner_libs(db: Session, share: Share) -> list[int]:
    owner = share.owner
    if not owner or not owner.is_active:
        return []
    return allowed_library_ids(db, owner)


def _like_prefix(folder: str) -> str:
    return folder.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "/%"


def share_tracks_query(db: Session, share: Share) -> Select | None:
    """Запрос треков ссылки с учётом прав владельца (без сортировки)."""
    libs = _owner_libs(db, share)
    if not libs:
        return None
    q = select(Track).where(Track.library_id.in_(libs))
    if share.kind == "folder":
        if share.library_id not in libs:
            return None
        q = q.where(Track.library_id == share.library_id)
        if share.folder:
            prefix = share.folder + "/"
            exact = func.substr(Track.path, 1, len(prefix))
            if db.get_bind().dialect.name in ("mysql", "mariadb"):
                exact = exact.collate("utf8mb4_bin")  # иначе «Jazz/» совпало бы с «jazz/» и «Jäzz/»
            # LIKE сужает выборку, точное сравнение начала пути отсекает папки «похожие» по регистру
            q = q.where(Track.path.like(_like_prefix(share.folder), escape="\\"), exact == prefix)
    elif share.kind == "album":
        q = q.where(Track.album_id == share.item_id)
    elif share.kind == "artist":
        q = q.join(Album, Album.id == Track.album_id).where(Album.artist_id == share.item_id)
    elif share.kind == "playlist":
        pl = db.get(Playlist, share.item_id or 0)
        if not pl or (pl.owner_id != share.owner_id and not pl.is_public):
            return None
        q = q.join(PlaylistEntry, PlaylistEntry.track_id == Track.id).where(PlaylistEntry.playlist_id == pl.id)
    elif share.kind == "tracks":
        ids = [i for i in json.loads(share.track_ids or "[]") if isinstance(i, int)]
        q = q.where(Track.id.in_(ids or [-1]))
    else:
        return None
    return q


def share_tracks(db: Session, share: Share, limit: int = 5000) -> list[Track]:
    q = share_tracks_query(db, share)
    if q is None:
        return []
    if share.kind == "album":
        libs = set(_owner_libs(db, share))  # владелец мог потерять доступ к папке альбома
        return [t for t in album_tracks(db, share.item_id or 0) if t.library_id in libs]
    if share.kind == "playlist":
        q = q.order_by(PlaylistEntry.position, PlaylistEntry.id)
    elif share.kind == "artist":
        q = q.order_by(desc(Album.year), Album.id, func.coalesce(Track.disc_no, 1), Track.track_no)
    elif share.kind == "folder":
        q = q.order_by(Track.path)
    tracks = list(db.scalars(q.limit(limit)))
    if share.kind == "tracks":
        order = {tid: i for i, tid in enumerate(json.loads(share.track_ids or "[]"))}
        tracks.sort(key=lambda t: order.get(t.id, 0))
    return tracks


def share_has_track(db: Session, share: Share, track_id: int) -> Track:
    q = share_tracks_query(db, share)
    track = db.scalars(q.where(Track.id == track_id).limit(1)).first() if q is not None else None
    if not track:
        raise HTTPException(404, "Трек не найден")
    return track


def _default_title(db: Session, share: Share) -> tuple[str, str]:
    """Название и подзаголовок по содержимому."""
    if share.kind == "album":
        a = db.get(Album, share.item_id or 0)
        return (a.name, " · ".join(str(x) for x in (a.artist_name, a.year) if x)) if a else ("Альбом", "")
    if share.kind == "artist":
        a = db.get(Artist, share.item_id or 0)
        return (a.name if a else "Исполнитель", "Исполнитель")
    if share.kind == "playlist":
        p = db.get(Playlist, share.item_id or 0)
        return (p.name if p else "Плейлист", "Плейлист")
    if share.kind == "folder":
        lib = db.get(Library, share.library_id or 0)
        name = share.folder.rsplit("/", 1)[-1] if share.folder else (lib.name if lib else "Папка")
        return (name, "Папка")
    return ("Подборка треков", "")


def _cover_album(db: Session, share: Share, tracks: list[Track]) -> Album | None:
    if share.kind == "album":
        return db.get(Album, share.item_id or 0)
    for t in tracks:
        if t.album and t.album.cover:
            return t.album
    return tracks[0].album if tracks else None


def _public_url(db: Session, request: Request, token: str) -> str:
    base = get_setting(db, "public_url").rstrip("/") or str(request.base_url).rstrip("/")
    return f"{base}/s/{token}"


# ---------------- управление ссылками ----------------


def _require_share_right(user: User) -> None:
    if not (user.is_admin or user.can_share):
        raise HTTPException(403, "Администратор не разрешил вам делиться ссылками")


def _share_out(db: Session, request: Request, share: Share, with_count: bool = True) -> dict:
    title, subtitle = _default_title(db, share)
    q = share_tracks_query(db, share) if with_count else None
    count = db.scalar(select(func.count()).select_from(q.order_by(None).subquery())) if q is not None else 0
    now = datetime.now(timezone.utc)
    expires = _aware(share.expires_at)
    state = "active"
    if not share.enabled:
        state = "disabled"
    elif expires and expires <= now:
        state = "expired"
    elif share.max_views and share.views >= share.max_views:
        state = "exhausted"
    cover_album = None
    if share.kind == "album":
        cover_album = db.get(Album, share.item_id or 0)
    elif q is not None:
        cover_album = db.scalars(
            select(Album).where(Album.id.in_(q.with_only_columns(Track.album_id)), Album.cover.is_not(None)).limit(1)
        ).first()
    return {
        "id": share.id,
        "token": share.token,
        "url": _public_url(db, request, share.token),
        "kind": share.kind,
        "kind_label": KIND_LABELS.get(share.kind, ""),
        "target_title": title,
        "target_subtitle": subtitle,
        "title": share.title,
        "description": share.description,
        "has_password": bool(share.password_hash),
        "expires_at": expires,
        "allow_download": share.allow_download,
        "max_views": share.max_views,
        "views": share.views,
        "plays": share.plays,
        "downloads": share.downloads,
        "last_opened_at": _aware(share.last_opened_at),
        "enabled": share.enabled,
        "state": state,
        "track_count": count or 0,
        "cover": cover_url(cover_album),
        "owner": {"id": share.owner_id, "name": share.owner.display_name or share.owner.username},
        "created_at": _aware(share.created_at),
    }


def _validate_target(db: Session, user: User, data: ShareCreate) -> dict:
    libs = allowed_library_ids(db, user)
    target: dict = {"kind": data.kind}
    if data.kind == "folder":
        lib = db.get(Library, data.library_id or 0)
        if not lib or lib.id not in libs:
            raise HTTPException(404, "Папка не найдена")
        folder = "/".join(p for p in data.folder.replace("\\", "/").split("/") if p and p not in (".", ".."))
        root = Path(lib.path).resolve()
        if folder and not (root / folder).resolve().is_dir():
            raise HTTPException(404, "Подпапка не найдена")
        target.update(library_id=lib.id, folder=folder)
    elif data.kind == "album":
        album = db.get(Album, data.item_id or 0)
        if not album or album.library_id not in libs:
            raise HTTPException(404, "Альбом не найден")
        target["item_id"] = album.id
    elif data.kind == "artist":
        if not db.get(Artist, data.item_id or 0):
            raise HTTPException(404, "Исполнитель не найден")
        target["item_id"] = data.item_id
    elif data.kind == "playlist":
        pl = db.get(Playlist, data.item_id or 0)
        if not pl or (pl.owner_id != user.id and not pl.is_public):
            raise HTTPException(404, "Плейлист не найден")
        target["item_id"] = pl.id
    else:
        ids = list(dict.fromkeys(data.track_ids))[:2000]
        valid = set(db.scalars(select(Track.id).where(Track.id.in_(ids or [-1]), Track.library_id.in_(libs or [-1]))))
        ids = [i for i in ids if i in valid]
        if not ids:
            raise HTTPException(400, "Выберите хотя бы один трек")
        target["track_ids"] = json.dumps(ids)
    return target


@router.get("/api/shares")
def list_shares(
    request: Request, all: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[dict]:
    q = select(Share).order_by(desc(Share.created_at))
    if not (all and user.is_admin):
        q = q.where(Share.owner_id == user.id)
    return [_share_out(db, request, s) for s in db.scalars(q.limit(1000))]


@router.post("/api/shares")
def create_share(
    data: ShareCreate, request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    _require_share_right(user)
    target = _validate_target(db, user, data)
    expires = _aware(data.expires_at)
    if expires and expires <= datetime.now(timezone.utc):
        raise HTTPException(400, "Срок действия уже прошёл")
    share = Share(
        token=secrets.token_urlsafe(12),
        owner_id=user.id,
        title=data.title.strip(),
        description=data.description.strip(),
        password_hash=hash_password(data.password) if data.password else None,
        expires_at=expires,
        allow_download=data.allow_download,
        max_views=data.max_views,
        **target,
    )
    db.add(share)
    db.commit()
    db.refresh(share)
    return _share_out(db, request, share)


def _own_share(db: Session, user: User, share_id: int) -> Share:
    share = db.get(Share, share_id)
    if not share or (share.owner_id != user.id and not user.is_admin):
        raise HTTPException(404, "Ссылка не найдена")
    return share


@router.patch("/api/shares/{share_id}")
def update_share(
    share_id: int, data: ShareUpdate, request: Request, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    share = _own_share(db, user, share_id)
    if data.title is not None:
        share.title = data.title.strip()
    if data.description is not None:
        share.description = data.description.strip()
    if data.password is not None:
        share.password_hash = hash_password(data.password) if data.password else None
        share.secret_version += 1
    if data.clear_expiry:
        share.expires_at = None
    elif data.expires_at is not None:
        share.expires_at = _aware(data.expires_at)
    if data.allow_download is not None:
        share.allow_download = data.allow_download
    if data.max_views is not None:
        share.max_views = data.max_views or None
    if data.enabled is not None:
        if data.enabled and not (user.is_admin or user.can_share):
            raise HTTPException(403, "Администратор не разрешил вам делиться ссылками")
        share.enabled = data.enabled
    share.updated_at = utcnow()
    db.commit()
    return _share_out(db, request, share)


@router.delete("/api/shares/{share_id}")
def delete_share(share_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    share = _own_share(db, user, share_id)
    db.delete(share)
    db.commit()
    return {"ok": True}


@router.get("/api/libraries/{library_id}/dirs")
def library_dirs(
    library_id: int, path: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    """Подпапки доступной пользователю папки — чтобы поделиться подпапкой."""
    lib = db.get(Library, library_id)
    if not lib or lib.id not in allowed_library_ids(db, user):
        raise HTTPException(404, "Папка не найдена")
    root = Path(lib.path).resolve()
    target = (root / path.strip("/")).resolve() if path.strip("/") else root
    if target != root and root not in target.parents:
        raise HTTPException(400, "Недопустимый путь")
    dirs: list[str] = []
    try:
        with os.scandir(target) as it:
            dirs = sorted(
                (e.name for e in it if e.is_dir(follow_symlinks=False) and not e.name.startswith((".", "@", "#"))),
                key=str.lower,
            )
    except OSError:
        raise HTTPException(404, "Папка недоступна")
    rel = "" if target == root else target.relative_to(root).as_posix()
    count = db.scalar(
        select(func.count(Track.id)).where(
            Track.library_id == lib.id, *( [Track.path.like(_like_prefix(rel), escape="\\")] if rel else [] )
        )
    )
    return {"library": {"id": lib.id, "name": lib.name}, "path": rel, "dirs": dirs, "track_count": count or 0}


# ---------------- публичный доступ ----------------

COOKIE_PREFIX = "sm_s_"


def _cookie_name(token: str) -> str:
    return COOKIE_PREFIX + token


def _load(db: Session, token: str) -> Share:
    share = db.scalar(select(Share).where(Share.token == token))
    if not share or not share.enabled or not share.owner or not share.owner.is_active:
        raise HTTPException(404, "Ссылка не найдена или отключена")
    owner = share.owner
    if not (owner.is_admin or owner.can_share):
        raise HTTPException(404, "Ссылка не найдена или отключена")
    expires = _aware(share.expires_at)
    if expires and expires <= datetime.now(timezone.utc):
        raise HTTPException(410, "Срок действия ссылки истёк")
    return share


def _access_token(share: Share) -> str:
    now = datetime.now(timezone.utc)
    payload = {"type": "share", "sid": share.id, "sv": share.secret_version, "iat": now, "exp": now + timedelta(days=7)}
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def _has_access(request: Request, share: Share) -> bool:
    raw = request.cookies.get(_cookie_name(share.token))
    if not raw:
        return False
    try:
        p = jwt.decode(raw, settings.secret_key, algorithms=["HS256"])
    except jwt.PyJWTError:
        return False
    return p.get("type") == "share" and p.get("sid") == share.id and p.get("sv") == share.secret_version


def _grant(response: Response, request: Request, share: Share) -> None:
    secure = request.url.scheme == "https" if settings.cookie_secure == "auto" else settings.cookie_secure.lower() in ("1", "true", "yes")
    response.set_cookie(
        _cookie_name(share.token),
        _access_token(share),
        max_age=7 * 86400,
        httponly=True,
        secure=secure,
        samesite="lax",
        path=f"/api/s/{share.token}",
    )


def _guard(request: Request, share: Share) -> None:
    """Для потока, обложек и скачивания: нужен «пропуск» ссылки (cookie)."""
    if not _has_access(request, share):
        raise HTTPException(401, "Откройте ссылку заново")


def _public_track(t: Track, allow_download: bool) -> dict:
    album = t.album
    return {
        "id": t.id,
        "title": t.title,
        "artist": t.artist_name,
        "album": album.name if album else "",
        "album_id": t.album_id,
        "track_no": t.track_no,
        "disc_no": t.disc_no,
        "duration": round(t.duration, 2),
        "quality": track_quality(t) if allow_download else "MP3 · 192",
        "size": t.size if allow_download else None,
        "cover": f"/api/s/{{token}}/cover/{t.album_id}" if album and album.cover else None,
        "has_lyrics": bool(t.lyrics),
    }


@router.get("/api/s/{token}")
def open_share(token: str, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    share = _load(db, token)
    unlocked = _has_access(request, share)
    title, subtitle = _default_title(db, share)
    base = {
        "kind": share.kind,
        "kind_label": KIND_LABELS.get(share.kind, ""),
        "owner": share.owner.display_name or share.owner.username,
        "site_name": get_setting(db, "site_name"),
    }
    if not unlocked:
        if share.max_views and share.views >= share.max_views:
            raise HTTPException(410, "Ссылку открыли максимальное число раз")
        if share.password_hash:
            return {**base, "locked": True}
        share.views += 1
        share.last_opened_at = utcnow()
        db.commit()
        _grant(response, request, share)
    tracks = share_tracks(db, share)
    album = _cover_album(db, share, tracks)
    items = [_public_track(t, share.allow_download) for t in tracks]
    for it in items:
        if it["cover"]:
            it["cover"] = it["cover"].replace("{token}", share.token)
    return {
        **base,
        "locked": False,
        "title": share.title or title,
        "subtitle": subtitle if not share.title else (title if title != share.title else subtitle),
        "description": share.description,
        "allow_download": share.allow_download,
        "expires_at": _aware(share.expires_at),
        "cover": f"/api/s/{share.token}/cover/{album.id}" if album and album.cover else None,
        "tracks": items,
        "duration": int(sum(t.duration for t in tracks)),
        "size": sum(t.size for t in tracks) if share.allow_download else None,
    }


@router.post("/api/s/{token}/unlock")
def unlock_share(token: str, data: ShareUnlock, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    share = _load(db, token)
    if share.max_views and share.views >= share.max_views:
        raise HTTPException(410, "Ссылку открыли максимальное число раз")
    ip = request.client.host if request.client else "?"
    key = f"share:{token}"
    ratelimit.check(key, ip)
    if share.password_hash and not verify_password(data.password, share.password_hash):
        ratelimit.fail(key, ip)
        raise HTTPException(401, "Неверный пароль")
    ratelimit.success(key, ip)
    share.views += 1
    share.last_opened_at = utcnow()
    db.commit()
    _grant(response, request, share)
    return {"ok": True}


@router.get("/api/s/{token}/stream/{track_id}")
def share_stream(token: str, track_id: int, request: Request, db: Session = Depends(get_db)):
    share = _load(db, token)
    _guard(request, share)
    track = share_has_track(db, share, track_id)
    if share.allow_download:
        return stream_track(request, db, track, browser=True)
    # «Только слушать» — не оригинал, а MP3 192
    return stream_track(request, db, track, max_bitrate=LISTEN_BITRATE, fmt="mp3", browser=True)


@router.post("/api/s/{token}/play")
def share_play(token: str, data: SharePlay, request: Request, db: Session = Depends(get_db)) -> dict:
    share = _load(db, token)
    _guard(request, share)
    share_has_track(db, share, data.track_id)
    share.plays += 1
    db.commit()
    return {"ok": True}


@router.get("/api/s/{token}/lyrics/{track_id}")
def share_lyrics(token: str, track_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    share = _load(db, token)
    _guard(request, share)
    return {"lyrics": share_has_track(db, share, track_id).lyrics}


@router.get("/api/s/{token}/cover/{album_id}")
def share_cover(token: str, album_id: int, request: Request, size: int = 600, db: Session = Depends(get_db)):
    share = _load(db, token)
    _guard(request, share)
    q = share_tracks_query(db, share)
    if q is None or not db.scalar(select(func.count()).select_from(q.where(Track.album_id == album_id).limit(1).subquery())):
        raise HTTPException(404, "Нет обложки")
    album = db.get(Album, album_id)
    path = cover_path(db, album, size) if album else None
    if path is None:
        raise HTTPException(404, "Нет обложки")
    return image_response(path)


@router.get("/api/s/{token}/download/{track_id}")
def share_download(token: str, track_id: int, request: Request, db: Session = Depends(get_db)):
    share = _load(db, token)
    _guard(request, share)
    if not share.allow_download:
        raise HTTPException(403, "По этой ссылке можно только слушать")
    track = share_has_track(db, share, track_id)
    if not request.headers.get("range"):
        share.downloads += 1
        db.commit()
    return file_response(request, track_file(db, track), content_type(track.suffix), download_name(track))


class _ZipSink:
    """Поток для zipfile без перемотки: накапливаем байты и отдаём их кусками."""

    def __init__(self) -> None:
        self.chunks: list[bytes] = []
        self.pos = 0

    def write(self, b: bytes) -> int:
        self.chunks.append(bytes(b))
        self.pos += len(b)
        return len(b)

    def tell(self) -> int:
        return self.pos

    def flush(self) -> None:
        pass

    def take(self) -> bytes:
        out = b"".join(self.chunks)
        self.chunks.clear()
        return out


@router.get("/api/s/{token}/zip")
def share_zip(token: str, request: Request, db: Session = Depends(get_db)):
    share = _load(db, token)
    _guard(request, share)
    if not share.allow_download:
        raise HTTPException(403, "По этой ссылке можно только слушать")
    tracks = share_tracks(db, share)
    if not tracks:
        raise HTTPException(404, "Нечего скачивать")
    files: list[tuple[Path, str]] = []
    used: set[str] = set()
    multi_album = len({t.album_id for t in tracks}) > 1
    for i, t in enumerate(tracks, 1):
        try:
            path = track_file(db, t)
        except HTTPException:
            continue
        name = download_name(t)
        if share.kind in ("playlist", "tracks"):
            name = f"{i:02d}. {name}"
        elif multi_album and t.album:
            folder = "".join(c for c in f"{t.album.artist_name} - {t.album.name}" if c not in '\\/:*?"<>|').strip()
            num = f"{t.track_no:02d}. " if t.track_no else ""
            name = f"{folder}/{num}{name}"
        elif t.track_no:
            name = f"{t.track_no:02d}. {name}"
        base, n = name, 2
        while name in used:
            stem, ext = os.path.splitext(base)
            name = f"{stem} ({n}){ext}"
            n += 1
        used.add(name)
        files.append((path, name))
    share.downloads += 1
    db.commit()
    title = share.title or _default_title(db, share)[0]
    filename = "".join(c for c in title if c not in '\\/:*?"<>|').strip() or "music"

    def generate():
        sink = _ZipSink()
        # Музыка уже сжата — храним без сжатия (быстро и без нагрузки на NAS)
        with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
            for path, name in files:
                with open(path, "rb") as src, zf.open(name, "w", force_zip64=True) as dst:
                    while chunk := src.read(512 * 1024):
                        dst.write(chunk)
                        data = sink.take()
                        if data:
                            yield data
                data = sink.take()
                if data:
                    yield data
        data = sink.take()
        if data:
            yield data

    from urllib.parse import quote

    return StreamingResponse(
        generate(),
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}.zip", "Cache-Control": "no-store"},
    )


@router.get("/api/s/{token}/manifest.json")
def share_manifest(token: str, db: Session = Depends(get_db)) -> Response:
    """Свой манифест PWA для ссылки: «На экран Домой» откроет именно эту подборку."""
    try:
        share = _load(db, token)
    except HTTPException:
        share = None
    # Название не раскрываем для закрытых паролем и неактивных ссылок
    title = (share.title or _default_title(db, share)[0]) if share and not share.password_hash else "SelfMusic"
    manifest = {
        "name": title,
        "short_name": title[:24],
        "id": f"/s/{token}",
        "start_url": f"/s/{token}",
        "scope": f"/s/{token}",
        "display": "standalone",
        "background_color": "#0d0d0f",
        "theme_color": "#0d0d0f",
        "lang": "ru",
        "icons": [
            {"src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
            {"src": "/icons/maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable"},
        ],
    }
    return Response(json.dumps(manifest, ensure_ascii=False), media_type="application/manifest+json")
