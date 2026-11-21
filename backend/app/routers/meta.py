"""Сведения из интернета: настройки, ручной выбор релиза / исполнителя в MusicBrainz, фото исполнителей."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import metadata as md
from ..access import allowed_library_ids
from ..db import get_db
from ..media import image_response
from ..models import Album, AlbumMeta, Artist, ArtistMeta, User
from ..security import get_media_user, require_admin

router = APIRouter(prefix="/api", tags=["metadata"])

MBID_IN = re.compile(r"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})", re.I)


def _mbid(value: str | None, kind: str) -> str | None:
    """MBID или ссылка на musicbrainz.org/<kind>/<MBID>."""
    if not value:
        return None
    if "musicbrainz.org" in value and f"/{kind}/" not in value:
        raise HTTPException(422, f"Это ссылка не на {'релиз' if kind == 'release' else 'исполнителя'} MusicBrainz")
    m = MBID_IN.search(value)
    if not m:
        raise HTTPException(422, "Не похоже на MBID или ссылку MusicBrainz")
    return m.group(1).lower()


def _net(fn, *args, **kwargs):  # noqa: ANN001, ANN002, ANN003, ANN202
    try:
        return fn(*args, **kwargs)
    except md.NotFound:
        raise HTTPException(404, "В MusicBrainz такого нет")
    except md.NetError as exc:
        raise HTTPException(502, f"Нет связи: {exc}")


# ---------------- настройки (админ) ----------------


class MetaSettings(BaseModel):
    enabled: bool | None = None
    covers: bool | None = None
    artists: bool | None = None
    fill: bool | None = None
    lang: str | None = Field(default=None, max_length=8)
    acoustid_key: str | None = Field(default=None, max_length=64)


class RetryIn(BaseModel):
    everything: bool = False


@router.get("/admin/meta")
def meta_status(_: User = Depends(require_admin)) -> dict:
    return md.worker.status()


@router.put("/admin/meta")
def meta_update(data: MetaSettings, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    md.save_config(db, data.model_dump())
    db.commit()
    md.worker.wake()
    return md.worker.status()


@router.post("/admin/meta/retry")
def meta_retry(data: RetryIn, _: User = Depends(require_admin)) -> dict:
    md.worker.retry(failed_only=not data.everything)
    return md.worker.status()


# ---------------- альбом ----------------


def _album(db: Session, user: User, album_id: int) -> Album:
    album = db.get(Album, album_id)
    if not album or album.library_id not in allowed_library_ids(db, user, kind="any"):
        raise HTTPException(404, "Альбом не найден")
    return album


def album_meta_out(db: Session, album: Album) -> dict:
    m = db.get(AlbumMeta, album.id)
    return {
        "status": m.status if m else "pending",
        "source": m.source if m else "",
        "release_mbid": m.release_mbid if m else None,
        "release_group_mbid": m.release_group_mbid if m else None,
        "title": m.title if m else "",
        "artist": m.artist if m else "",
        "year": m.year if m else None,
        "genre": m.genre if m else "",
        "cover_from_meta": bool(album.cover and album.cover.startswith("meta:")),
        "error": m.error if m else None,
        "checked_at": m.checked_at.isoformat() if m and m.checked_at else None,
        "query": {"title": album.name, "artist": album.artist_name},
    }


class AlbumChoice(BaseModel):
    release: str | None = Field(default=None, max_length=300)  # MBID или ссылка на релиз
    auto: bool = False  # заново найти автоматически


@router.get("/albums/{album_id}/meta")
def album_meta(album_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    return album_meta_out(db, _album(db, user, album_id))


@router.get("/albums/{album_id}/meta/search")
def album_meta_search(
    album_id: int, q: str = "", artist: str = "", db: Session = Depends(get_db), user: User = Depends(require_admin)
) -> list[dict]:
    album = _album(db, user, album_id)
    title = (q or album.name).strip()[:300]
    if not title:
        return []
    found = _net(md.search_releases, title, (artist if artist or q else album.artist_name).strip()[:300], 25)
    for r in found:
        r["cover"] = f"{md.CAA}/release/{r['id']}/front-250"
    return found


@router.post("/albums/{album_id}/meta")
def album_meta_choose(album_id: int, data: AlbumChoice, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    album = _album(db, user, album_id)
    release = _mbid(data.release, "release")
    if not release and not data.auto:
        raise HTTPException(422, "Выберите релиз")
    db.close()
    status = _net(md.refresh_album, album_id, release_id=release, manual=bool(release))
    if status == "error":
        raise HTTPException(500, "Не удалось применить релиз — подробности в журнале сервера")
    with md.dbmod.session_scope() as s:
        album = s.get(Album, album_id)
        return album_meta_out(s, album)


@router.delete("/albums/{album_id}/meta")
def album_meta_ignore(album_id: int, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    _album(db, user, album_id)
    db.close()
    md.apply_album(album_id, None, source="manual", status="ignored")
    with md.dbmod.session_scope() as s:
        return album_meta_out(s, s.get(Album, album_id))


# ---------------- исполнитель ----------------


def _artist(db: Session, artist_id: int) -> Artist:
    artist = db.get(Artist, artist_id)
    if not artist:
        raise HTTPException(404, "Исполнитель не найден")
    return artist


def artist_info_out(m: ArtistMeta | None) -> dict | None:
    """Блок «Об исполнителе» для страницы исполнителя (всем пользователям)."""
    if m is None or m.status not in md.FOUND:
        return None
    return {
        "mbid": m.mbid,
        "name": m.mb_name,
        "disambiguation": m.disambiguation,
        "country": m.country,
        "life_span": m.life_span,
        "genres": m.genres,
        "bio": m.bio,
        "bio_lang": m.bio_lang,
        "bio_url": m.bio_url,
        "image_source": m.image_source,
    }


def artist_meta_out(db: Session, artist: Artist) -> dict:
    m = db.get(ArtistMeta, artist.id)
    return {
        "status": m.status if m else "pending",
        "source": m.source if m else "",
        "mbid": m.mbid if m else None,
        "info": artist_info_out(m),
        "image": md.artist_image_url(m),
        "error": m.error if m else None,
        "checked_at": m.checked_at.isoformat() if m and m.checked_at else None,
        "query": artist.name,
    }


class ArtistChoice(BaseModel):
    artist: str | None = Field(default=None, max_length=300)  # MBID или ссылка на исполнителя
    auto: bool = False


@router.get("/artists/{artist_id}/meta")
def artist_meta(artist_id: int, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    return artist_meta_out(db, _artist(db, artist_id))


@router.get("/artists/{artist_id}/meta/search")
def artist_meta_search(artist_id: int, q: str = "", db: Session = Depends(get_db), _: User = Depends(require_admin)) -> list[dict]:
    name = (q or _artist(db, artist_id).name).strip()[:300]
    return _net(md.search_artists, name, 20) if name else []


@router.post("/artists/{artist_id}/meta")
def artist_meta_choose(artist_id: int, data: ArtistChoice, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    _artist(db, artist_id)
    mbid = _mbid(data.artist, "artist")
    if not mbid and not data.auto:
        raise HTTPException(422, "Выберите исполнителя")
    db.close()
    if data.auto:
        # заново: забываем прежний MBID, ищем по имени
        with md.dbmod.session_scope() as s:
            m = s.get(ArtistMeta, artist_id)
            if m is not None:
                m.mbid, m.status = None, "notfound"
                s.commit()
    status = _net(md.refresh_artist, artist_id, mbid=mbid, manual=bool(mbid))
    if status == "error":
        raise HTTPException(500, "Не удалось загрузить сведения — подробности в журнале сервера")
    with md.dbmod.session_scope() as s:
        return artist_meta_out(s, s.get(Artist, artist_id))


@router.delete("/artists/{artist_id}/meta")
def artist_meta_ignore(artist_id: int, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    _artist(db, artist_id)
    db.close()
    md.apply_artist(artist_id, None, source="manual", status="ignored")
    with md.dbmod.session_scope() as s:
        return artist_meta_out(s, s.get(Artist, artist_id))


@router.get("/cover/artist/{artist_id}")
def artist_image(artist_id: int, size: int = 600, db: Session = Depends(get_db), _: User = Depends(get_media_user)) -> Response:
    m = db.get(ArtistMeta, artist_id)
    path = md.artist_image_path(m, max(32, min(size, 1200))) if m else None
    if path is None:
        raise HTTPException(404, "Нет фото")
    return image_response(path)
