"""Представление объектов медиатеки для веб-API."""
from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Album, Artist, Star, Track


def cover_url(album: Album | None) -> str | None:
    if album is None or not album.cover:
        return None
    stamp = int(album.updated_at.timestamp()) if album.updated_at else 0
    return f"/api/cover/album/{album.id}?v={stamp}"


def track_quality(t: Track) -> str:
    suffix = (t.suffix or "").upper()
    if t.codec == "alac":
        suffix = "ALAC"
    lossless = suffix in ("FLAC", "WAV", "AIFF", "AIF", "APE", "WV", "DSF", "ALAC")
    if lossless and t.bit_depth and t.sample_rate:
        khz = f"{t.sample_rate / 1000:.1f}".rstrip("0").rstrip(".")
        return f"{suffix} · {t.bit_depth}/{khz}"
    if t.bitrate:
        return f"{suffix} · {t.bitrate}"
    return suffix


def starred_ids(db: Session, user_id: int, kind: str, ids: Iterable[int]) -> set[int]:
    ids = list(set(ids))
    if not ids:
        return set()
    return set(
        db.scalars(select(Star.item_id).where(Star.user_id == user_id, Star.kind == kind, Star.item_id.in_(ids)))
    )


def track_out(t: Track, starred: set[int] | None = None) -> dict:
    album = t.album
    return {
        "id": t.id,
        "title": t.title,
        "artist": t.artist_name,
        "artist_id": t.artist_id,
        "album": album.name if album else "",
        "album_id": t.album_id,
        "album_artist": album.artist_name if album else "",
        "album_artist_id": album.artist_id if album else None,
        "track_no": t.track_no,
        "disc_no": t.disc_no,
        "year": t.year,
        "genre": t.genre,
        "duration": round(t.duration, 2),
        "bitrate": t.bitrate,
        "suffix": t.suffix,
        "quality": track_quality(t),
        "size": t.size,
        "cover": cover_url(album),
        "has_lyrics": bool(t.lyrics),
        "starred": t.id in starred if starred is not None else False,
    }


def tracks_out(db: Session, user_id: int, tracks: list[Track]) -> list[dict]:
    starred = starred_ids(db, user_id, "track", (t.id for t in tracks))
    return [track_out(t, starred) for t in tracks]


def album_out(a: Album, starred: set[int] | None = None) -> dict:
    return {
        "id": a.id,
        "name": a.name,
        "artist": a.artist_name,
        "artist_id": a.artist_id,
        "year": a.year,
        "genre": a.genre,
        "track_count": a.track_count,
        "disc_count": a.disc_count,
        "duration": a.duration,
        "quality": a.quality,
        "size": a.size,
        "cover": cover_url(a),
        "library_id": a.library_id,
        "created_at": a.created_at,
        "starred": a.id in starred if starred is not None else False,
    }


def albums_out(db: Session, user_id: int, albums: list[Album]) -> list[dict]:
    starred = starred_ids(db, user_id, "album", (a.id for a in albums))
    return [album_out(a, starred) for a in albums]


def artist_out(a: Artist, album_count: int = 0, cover: str | None = None, starred: bool = False) -> dict:
    return {"id": a.id, "name": a.name, "album_count": album_count, "cover": cover, "starred": starred}
