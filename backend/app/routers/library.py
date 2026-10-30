"""Веб-API медиатеки: главная, альбомы, исполнители, поиск, избранное, плейлисты, поток и обложки."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Literal

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, ValidationError
from fastapi.responses import Response
from sqlalchemy import delete, desc, func, select
from sqlalchemy.orm import Session

from .. import smart
from ..stats import favorite_artists
from ..access import allowed_library_ids, can_edit_track, can_write
from ..db import get_db
from ..media import cover_path, download_name, file_response, image_response, content_type, stream_track, track_file
from ..models import Album, Artist, Library, Play, Playlist, PlaylistEntry, PlaylistMember, Star, Track, Upload, User
from ..queries import (
    album_list_query,
    album_tracks,
    artists_with_counts,
    genres,
    search_tracks,
    top_tracks,
    tracks_query,
)
from ..schemas import PlayIn, PlaylistCreate, PlaylistReorder, PlaylistTracks, PlaylistUpdate
from ..security import get_current_user, get_media_user
from ..serialize import album_out, albums_out, artist_out, cover_url, starred_ids, track_out, tracks_out

router = APIRouter(prefix="/api", tags=["library"])

QUALITY_BITRATE = {"original": 0, "320": 320, "192": 192, "128": 128}


def _libs(db: Session, user: User, library: int | None = None) -> list[int]:
    return allowed_library_ids(db, user, library)


def _all_libs(db: Session, user: User) -> list[int]:
    """Без учёта «Вся / Общая / Моя»: плейлисты, избранное, история, явно открытые альбом и исполнитель."""
    return allowed_library_ids(db, user, scoped=False)


def _visible_album(db: Session, user: User, album_id: int) -> Album:
    album = db.get(Album, album_id)
    if not album or album.library_id not in allowed_library_ids(db, user, kind="any"):
        raise HTTPException(404, "Альбом не найден")
    return album


def _visible_track(db: Session, user: User, track_id: int) -> Track:
    track = db.get(Track, track_id)
    if not track or track.library_id not in allowed_library_ids(db, user, kind="any"):
        raise HTTPException(404, "Трек не найден")
    return track


def _artist_cards(db: Session, user: User, rows: list[tuple]) -> list[dict]:
    if not rows:
        return []
    cover_albums = {a.id: a for a in db.scalars(select(Album).where(Album.id.in_([r[2] for r in rows if r[2]])))}
    starred = starred_ids(db, user.id, "artist", (r[0].id for r in rows))
    return [
        artist_out(artist, count, cover_url(cover_albums.get(cover_id)), artist.id in starred)
        for artist, count, cover_id in rows
    ]


# ---------------- главная ----------------


@router.get("/libraries")
def my_libraries(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    ids = allowed_library_ids(db, user, kind="any")
    libs = db.scalars(select(Library).where(Library.id.in_(ids or [-1])).order_by(Library.name))
    return [
        {
            "id": lib.id,
            "name": lib.name,
            "kind": lib.kind,
            "personal": lib.owner_id == user.id,
            "path": lib.path if user.is_admin else None,
            "track_count": lib.track_count,
            "album_count": lib.album_count,
            "total_duration": lib.total_duration,
            "total_size": lib.total_size,
            "last_scan_at": lib.last_scan_at,
        }
        for lib in libs
    ]


# ---------------- просмотр по папкам (как «Папки» в DS Audio) ----------------


def _folder_scope(db: Session, user: User, library_id: int, path: str) -> tuple[Library, str]:
    lib = db.get(Library, library_id)
    if not lib or not lib.enabled or lib.id not in allowed_library_ids(db, user, kind="any"):
        raise HTTPException(404, "Папка не найдена")
    rel = "/".join(p for p in path.replace("\\", "/").split("/") if p and p not in (".", ".."))
    return lib, rel


def _like_folder(rel: str) -> str:
    return rel.replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "/%"


def _in_folder(query, rel: str):  # noqa: ANN001, ANN202
    return query.where(Track.path.like(_like_folder(rel), escape="\\")) if rel else query


@router.get("/libraries/{library_id}/browse")
def browse_folder(
    library_id: int, path: str = "", db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    """Содержимое папки: подпапки (по проиндексированным трекам) и треки, лежащие прямо в ней."""
    lib, rel = _folder_scope(db, user, library_id, path)
    prefix = f"{rel}/" if rel else ""
    rows = db.execute(
        _in_folder(select(Track.path, Track.album_id, Track.duration, Track.size).where(Track.library_id == lib.id), rel)
    ).all()
    dirs: dict[str, dict] = {}
    direct_paths: list[str] = []
    total_duration = total_size = 0
    for track_path, album_id, duration, size in rows:
        if not track_path.startswith(prefix):  # LIKE без учёта регистра — отсекаем «похожие» папки
            continue
        total_duration += duration or 0
        total_size += size or 0
        rest = track_path[len(prefix):]
        if "/" not in rest:
            direct_paths.append(track_path)
            continue
        name = rest.split("/", 1)[0]
        d = dirs.setdefault(name, {"name": name, "path": prefix + name, "track_count": 0, "albums": []})
        d["track_count"] += 1
        if album_id not in d["albums"] and len(d["albums"]) < 4:
            d["albums"].append(album_id)
    if rel and not rows:
        raise HTTPException(404, "В этой папке нет музыки")

    album_ids = {a for d in dirs.values() for a in d["albums"]}
    albums = {a.id: a for a in db.scalars(select(Album).where(Album.id.in_(album_ids or [-1])))}
    folders = []
    for d in sorted(dirs.values(), key=lambda d: d["name"].lower()):
        covers = [cover_url(albums.get(a)) for a in d["albums"]]
        folders.append(
            {"name": d["name"], "path": d["path"], "track_count": d["track_count"], "covers": [c for c in covers if c][:4]}
        )

    tracks: list[Track] = []
    if direct_paths:
        tracks = list(
            db.scalars(
                select(Track)
                .where(Track.library_id == lib.id, Track.path.in_(direct_paths[:2000]))
                .order_by(func.coalesce(Track.disc_no, 1), func.coalesce(Track.track_no, 9999), Track.path)
            )
        )
    crumbs = []
    acc = ""
    for part in rel.split("/") if rel else []:
        acc = f"{acc}/{part}" if acc else part
        crumbs.append({"name": part, "path": acc})
    return {
        "library": {"id": lib.id, "name": lib.name},
        "path": rel,
        "name": rel.rsplit("/", 1)[-1] if rel else lib.name,
        "crumbs": crumbs,
        "folders": folders,
        "tracks": tracks_out(db, user.id, tracks),
        "total_tracks": sum(1 for r in rows if r[0].startswith(prefix)),
        "total_duration": int(total_duration),
        "total_size": int(total_size),
    }


@router.get("/libraries/{library_id}/folder-search")
def folder_search(
    library_id: int,
    q: str = Query(..., min_length=1, max_length=200),
    path: str = "",
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Поиск внутри папки (со всеми подпапками): папки по имени и треки по названию, исполнителю, имени файла.
    Сравнение в Python — lower() в SQLite не понимает кириллицу."""
    lib, rel = _folder_scope(db, user, library_id, path)
    prefix = f"{rel}/" if rel else ""
    needle = " ".join(q.lower().split())
    rows = db.execute(
        _in_folder(select(Track.id, Track.path, Track.title, Track.artist_name, Track.album_id).where(Track.library_id == lib.id), rel)
    ).all()
    found_dirs: dict[str, dict] = {}
    track_ids: list[int] = []
    for tid, tpath, title, artist, album_id in rows:
        if not tpath.startswith(prefix):
            continue
        rest = tpath[len(prefix):]
        parts = rest.split("/")
        acc = rel
        for part in parts[:-1]:
            acc = f"{acc}/{part}" if acc else part
            if needle in part.lower():
                d = found_dirs.setdefault(acc, {"name": part, "path": acc, "track_count": 0, "albums": []})
                d["track_count"] += 1
                if album_id not in d["albums"] and len(d["albums"]) < 4:
                    d["albums"].append(album_id)
        if len(track_ids) < 200 and (
            needle in (title or "").lower() or needle in (artist or "").lower() or needle in parts[-1].lower()
        ):
            track_ids.append(tid)
    dirs = sorted(found_dirs.values(), key=lambda d: (d["path"].count("/"), d["name"].lower()))[:60]
    album_ids = {a for d in dirs for a in d["albums"]}
    albums = {a.id: a for a in db.scalars(select(Album).where(Album.id.in_(album_ids or [-1])))}
    tmap = {t.id: t for t in db.scalars(select(Track).where(Track.id.in_(track_ids or [-1])))}
    tracks = sorted((tmap[i] for i in track_ids if i in tmap), key=lambda t: t.path.lower())
    return {
        "folders": [
            {
                "name": d["name"],
                "path": d["path"],
                "parent": d["path"].rsplit("/", 1)[0] if "/" in d["path"] else "",
                "track_count": d["track_count"],
                "covers": [c for c in (cover_url(albums.get(a)) for a in d["albums"]) if c][:4],
            }
            for d in dirs
        ],
        "tracks": tracks_out(db, user.id, tracks[:100]),
        "more_folders": len(found_dirs) > 60,
        "more_tracks": len(track_ids) > 100,
    }


@router.get("/libraries/{library_id}/folder-tracks")
def folder_tracks(
    library_id: int,
    path: str = "",
    limit: int = Query(3000, ge=1, le=10000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    """Все треки папки вместе с подпапками — для «Слушать всё» и «Перемешать»."""
    lib, rel = _folder_scope(db, user, library_id, path)
    prefix = f"{rel}/" if rel else ""
    q = _in_folder(select(Track).where(Track.library_id == lib.id), rel).order_by(Track.path).limit(limit)
    tracks = [t for t in db.scalars(q) if t.path.startswith(prefix)]
    # внутри одной папки — по номеру трека, папки — по алфавиту
    tracks.sort(key=lambda t: (t.path.rsplit("/", 1)[0].lower() if "/" in t.path else "", t.disc_no or 1, t.track_no or 9999, t.path))
    return tracks_out(db, user.id, tracks)


@router.get("/home")
def home(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    ids = _libs(db, user)
    recent = list(db.scalars(album_list_query(ids, user.id, "newest").limit(18)))
    played = list(db.scalars(album_list_query(ids, user.id, "recent").limit(12)))
    random_albums = list(db.scalars(album_list_query(ids, user.id, "random").limit(12)))

    favorites = favorite_artists(db, user, ids, 12)

    stats = db.execute(
        select(func.count(Track.id), func.coalesce(func.sum(Track.duration), 0)).where(Track.library_id.in_(ids or [-1]))
    ).one()
    return {
        "recent_albums": albums_out(db, user.id, recent),
        "recently_played": albums_out(db, user.id, played),
        "random_albums": albums_out(db, user.id, random_albums),
        "favorite_artists": favorites,
        "stats": {
            "tracks": stats[0],
            "albums": db.scalar(select(func.count(Album.id)).where(Album.library_id.in_(ids or [-1]))) or 0,
            "artists": len(artists_with_counts(db, ids)) if ids else 0,
            "duration": int(stats[1]),
        },
    }


# ---------------- альбомы ----------------

AlbumSort = Literal["newest", "name", "artist", "year", "random", "frequent", "recent", "starred"]


@router.get("/albums")
def list_albums(
    sort: AlbumSort = "newest",
    library: int | None = None,
    genre: str | None = None,
    q: str = "",
    offset: int = Query(0, ge=0),
    limit: int = Query(60, ge=1, le=500),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    ids = _libs(db, user, library)
    query = album_list_query(ids, user.id, sort, genre=genre, q=q.strip())
    total = db.scalar(select(func.count()).select_from(query.order_by(None).subquery())) or 0
    items = list(db.scalars(query.offset(offset).limit(limit)))
    return {"items": albums_out(db, user.id, items), "total": total}


@router.get("/albums/{album_id}")
def get_album(album_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    album = _visible_album(db, user, album_id)
    tracks = album_tracks(db, album.id)
    ids = _all_libs(db, user)
    more = []
    if album.artist_id:
        more = list(
            db.scalars(
                album_list_query(ids, user.id, "year", artist_id=album.artist_id).where(Album.id != album.id).limit(12)
            )
        )
    data = album_out(album, starred_ids(db, user.id, "album", [album.id]))
    lib = db.get(Library, album.library_id)
    data["tracks"] = tracks_out(db, user.id, tracks)
    # Удалять можно свои загрузки; администратор — всё в папке, доступной на запись
    if user.is_admin and can_write(db, user, lib):
        deletable = {t.id for t in tracks}
    else:
        mine = set(
            db.scalars(
                select(Upload.path_hash).where(
                    Upload.user_id == user.id,
                    Upload.library_id == lib.id,
                    Upload.path_hash.in_([t.path_hash for t in tracks] or ["-"]),
                )
            )
        )
        deletable = {t.id for t in tracks if t.path_hash in mine}
    for item in data["tracks"]:
        item["can_delete"] = item["id"] in deletable
    data["can_edit"] = bool(tracks) and can_edit_track(db, user, lib, tracks[0].path)
    data["more_by_artist"] = albums_out(db, user.id, more)
    data["library_name"] = lib.name if lib else ""
    return data


# ---------------- исполнители ----------------


@router.get("/artists")
def list_artists(
    q: str = "",
    library: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    return _artist_cards(db, user, artists_with_counts(db, _libs(db, user, library), q.strip()))


@router.get("/artists/{artist_id}")
def get_artist(artist_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    artist = db.get(Artist, artist_id)
    if not artist:
        raise HTTPException(404, "Исполнитель не найден")
    ids = _all_libs(db, user)
    albums = list(db.scalars(album_list_query(ids, user.id, "year", artist_id=artist.id)))
    top = top_tracks(db, ids, artist.id, 10)
    if not albums and not top:
        raise HTTPException(404, "Исполнитель не найден")
    # Альбомы других исполнителей, где он участвует (сборники, фиты)
    appears = list(
        db.scalars(
            select(Album)
            .where(
                Album.library_id.in_(ids or [-1]),
                Album.artist_id != artist.id,
                Album.id.in_(select(Track.album_id).where(Track.artist_id == artist.id)),
            )
            .order_by(desc(Album.year))
            .limit(24)
        )
    )
    cover_album = next((a for a in albums if a.cover), None) or next((a for a in appears if a.cover), None)
    return {
        **artist_out(artist, len(albums), cover_url(cover_album), bool(starred_ids(db, user.id, "artist", [artist.id]))),
        "albums": albums_out(db, user.id, albums),
        "appears_on": albums_out(db, user.id, appears),
        "top_tracks": tracks_out(db, user.id, top),
        "track_count": db.scalar(
            select(func.count(Track.id)).where(Track.library_id.in_(ids or [-1]), Track.album_id.in_([a.id for a in albums] or [-1]))
        )
        or 0,
    }


@router.get("/artists/{artist_id}/tracks")
def artist_tracks(artist_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    """Все треки исполнителя по альбомам — для «Слушать всё» и «Перемешать»."""
    ids = _all_libs(db, user)
    tracks = list(
        db.scalars(
            tracks_query(ids)
            .join(Album, Album.id == Track.album_id)
            .where(Album.artist_id == artist_id)
            .order_by(desc(Album.year), Album.id, func.coalesce(Track.disc_no, 1), Track.track_no)
            .limit(2000)
        )
    )
    return tracks_out(db, user.id, tracks)


# ---------------- поиск, жанры, случайное ----------------


@router.get("/search")
def search(q: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    q = q.strip()
    if not q:
        return {"artists": [], "albums": [], "tracks": []}
    ids = _libs(db, user)
    artists = _artist_cards(db, user, artists_with_counts(db, ids, q)[:12])
    albums = list(db.scalars(album_list_query(ids, user.id, "name", q=q).limit(24)))
    tracks = search_tracks(db, ids, q, 50)
    return {"artists": artists, "albums": albums_out(db, user.id, albums), "tracks": tracks_out(db, user.id, tracks)}


@router.get("/genres")
def list_genres(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    return [{"name": g, "track_count": t, "album_count": a} for g, t, a in genres(db, _libs(db, user))]


@router.get("/tracks/random")
def random_tracks(
    limit: int = Query(50, ge=1, le=500),
    genre: str | None = None,
    library: int | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    query = tracks_query(_libs(db, user, library))
    if genre:
        query = query.where(Track.genre == genre)
    return tracks_out(db, user.id, list(db.scalars(query.order_by(func.random()).limit(limit))))


@router.get("/tracks/{track_id}")
def get_track(track_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    track = _visible_track(db, user, track_id)
    data = track_out(track, starred_ids(db, user.id, "track", [track.id]))
    data["lyrics"] = track.lyrics
    data["path"] = track.path if user.is_admin else None
    return data


@router.get("/tracks/{track_id}/lyrics")
def track_lyrics(track_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    track = _visible_track(db, user, track_id)
    return {"lyrics": track.lyrics}


# ---------------- история ----------------


@router.post("/plays")
def record_play(data: PlayIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    track = _visible_track(db, user, data.track_id)
    now = datetime.now(timezone.utc)
    at = data.played_at
    if at is not None:
        if at.tzinfo is None:
            at = at.replace(tzinfo=timezone.utc)
        # не из будущего и не старше 60 дней
        at = min(at, now) if at > now - timedelta(days=60) else None
    db.add(Play(user_id=user.id, track_id=track.id, album_id=track.album_id, played_at=at or now))
    db.commit()
    return {"ok": True}


@router.get("/history")
def history(
    limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> list[dict]:
    ids = _all_libs(db, user)
    rows = db.execute(
        select(Play.played_at, Track)
        .join(Track, Track.id == Play.track_id)
        .where(Play.user_id == user.id, Track.library_id.in_(ids or [-1]))
        .order_by(desc(Play.played_at))
        .limit(limit)
    ).all()
    starred = starred_ids(db, user.id, "track", (t.id for _, t in rows))
    return [{**track_out(t, starred), "played_at": at} for at, t in rows]


# ---------------- избранное ----------------

Kind = Literal["track", "album", "artist"]


@router.get("/favorites")
def favorites(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    ids = _all_libs(db, user)
    tracks = list(
        db.scalars(
            tracks_query(ids)
            .join(Star, (Star.item_id == Track.id) & (Star.kind == "track") & (Star.user_id == user.id))
            .order_by(desc(Star.created_at))
        )
    )
    albums = list(db.scalars(album_list_query(ids, user.id, "starred")))
    artist_ids = list(
        db.scalars(select(Star.item_id).where(Star.user_id == user.id, Star.kind == "artist").order_by(desc(Star.created_at)))
    )
    rows = artists_with_counts(db, ids, only_ids=artist_ids)
    rows.sort(key=lambda r: artist_ids.index(r[0].id))
    return {
        "tracks": [track_out(t, {t.id for t in tracks}) for t in tracks],
        "albums": [album_out(a, {a.id for a in albums}) for a in albums],
        "artists": _artist_cards(db, user, rows),
    }


@router.put("/favorites/{kind}/{item_id}")
def add_favorite(kind: Kind, item_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    model = {"track": Track, "album": Album, "artist": Artist}[kind]
    if not db.get(model, item_id):
        raise HTTPException(404, "Не найдено")
    if not db.get(Star, (user.id, kind, item_id)):
        db.add(Star(user_id=user.id, kind=kind, item_id=item_id))
        db.commit()
    return {"starred": True}


@router.delete("/favorites/{kind}/{item_id}")
def remove_favorite(kind: Kind, item_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    db.execute(delete(Star).where(Star.user_id == user.id, Star.kind == kind, Star.item_id == item_id))
    db.commit()
    return {"starred": False}


# ---------------- плейлисты ----------------


def _playlist_cover_tracks(db: Session, playlist_id: int, lib_ids: list[int]) -> list[str]:
    rows = db.execute(
        select(Album)
        .join(Track, Track.album_id == Album.id)
        .join(PlaylistEntry, PlaylistEntry.track_id == Track.id)
        .where(PlaylistEntry.playlist_id == playlist_id, Album.cover.is_not(None), Album.library_id.in_(lib_ids or [-1]))
        .order_by(PlaylistEntry.position)
        .limit(40)
    ).scalars()
    return _covers_of(rows.unique())


def _covers_of(albums) -> list[str]:  # noqa: ANN001
    covers: list[str] = []
    for album in albums:
        url = cover_url(album)
        if url and url not in covers:
            covers.append(url)
        if len(covers) == 4:
            break
    return covers


def _user_brief(u: User) -> dict:
    return {"id": u.id, "name": u.display_name or u.username, "avatar": u.avatar}


def _members(db: Session, pl: Playlist) -> list[User]:
    return list(db.scalars(select(User).join(PlaylistMember, PlaylistMember.user_id == User.id).where(PlaylistMember.playlist_id == pl.id)))


def _can_edit(db: Session, pl: Playlist, user: User) -> bool:
    """Можно ли менять состав треков (у умного плейлиста — нельзя никому: он собирается сам)."""
    if pl.rules:
        return False
    return pl.owner_id == user.id or db.get(PlaylistMember, (pl.id, user.id)) is not None


def _playlist_summary(db: Session, pl: Playlist, user: User, lib_ids: list[int], smart_tracks: list[Track] | None = None) -> dict:
    rules = smart.parse_rules(pl.rules)
    if rules is not None:
        tracks = smart_tracks if smart_tracks is not None else smart.evaluate(db, user, rules)
        count, duration = len(tracks), sum(t.duration or 0 for t in tracks)
        covers = _covers_of(t.album for t in tracks[:40] if t.album)
    else:
        stats = db.execute(
            select(func.count(Track.id), func.coalesce(func.sum(Track.duration), 0))
            .join(PlaylistEntry, PlaylistEntry.track_id == Track.id)
            .where(PlaylistEntry.playlist_id == pl.id, Track.library_id.in_(lib_ids or [-1]))
        ).one()
        count, duration = stats[0], stats[1]
        covers = _playlist_cover_tracks(db, pl.id, lib_ids)
    members = _members(db, pl)
    return {
        "id": pl.id,
        "name": pl.name,
        "comment": pl.comment,
        "is_public": pl.is_public,
        "owner": {"id": pl.owner_id, "name": pl.owner.display_name or pl.owner.username, "avatar": pl.owner.avatar},
        "is_owner": pl.owner_id == user.id,
        "can_edit": _can_edit(db, pl, user),
        "smart": rules is not None,
        "rules": rules.model_dump() if rules is not None else None,
        "members": [_user_brief(m) for m in members],
        "track_count": count,
        "duration": int(duration),
        "covers": covers,
        "created_at": pl.created_at,
        "updated_at": pl.updated_at,
    }


def _get_playlist(db: Session, user: User, playlist_id: int, write: bool = False) -> Playlist:
    pl = db.get(Playlist, playlist_id)
    member = pl is not None and db.get(PlaylistMember, (pl.id, user.id)) is not None
    if not pl or (pl.owner_id != user.id and not pl.is_public and not member):
        raise HTTPException(404, "Плейлист не найден")
    if write and not _can_edit(db, pl, user):
        raise HTTPException(403, "Умный плейлист собирается сам" if pl.rules else "Это чужой плейлист")
    return pl


def _append_tracks(db: Session, user: User, pl: Playlist, track_ids: list[int]) -> int:
    ids = _all_libs(db, user)
    valid = set(db.scalars(select(Track.id).where(Track.id.in_(track_ids or [-1]), Track.library_id.in_(ids or [-1]))))
    pos = db.scalar(select(func.coalesce(func.max(PlaylistEntry.position), -1)).where(PlaylistEntry.playlist_id == pl.id))
    added = 0
    for tid in track_ids:
        if tid in valid:
            pos += 1
            db.add(PlaylistEntry(playlist_id=pl.id, track_id=tid, position=pos, added_by=user.id))
            added += 1
    pl.updated_at = datetime.now(timezone.utc)
    return added


def _rules_json(raw: dict | None) -> str | None:
    if raw is None:
        return None
    try:
        return json.dumps(smart.Rules.model_validate(raw).model_dump(), ensure_ascii=False)
    except ValidationError as exc:
        raise HTTPException(422, f"Неверные правила: {exc.errors()[0].get('msg')}")


@router.get("/playlists")
def list_playlists(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    ids = _all_libs(db, user)
    mine = select(PlaylistMember.playlist_id).where(PlaylistMember.user_id == user.id)
    pls = db.scalars(
        select(Playlist)
        .where((Playlist.owner_id == user.id) | Playlist.is_public.is_(True) | Playlist.id.in_(mine))
        .order_by(desc(Playlist.owner_id == user.id), desc(Playlist.updated_at))
    )
    return [_playlist_summary(db, pl, user, ids) for pl in pls]


@router.post("/playlists")
def create_playlist(data: PlaylistCreate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    pl = Playlist(owner_id=user.id, name=data.name.strip(), comment=data.comment, is_public=data.is_public, rules=_rules_json(data.rules))
    db.add(pl)
    db.flush()
    if data.track_ids and not pl.rules:
        _append_tracks(db, user, pl, data.track_ids)
    db.commit()
    db.refresh(pl)
    return _playlist_summary(db, pl, user, _all_libs(db, user))


@router.post("/playlists/preview")
def preview_rules(data: dict, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Предпросмотр правил в редакторе: сколько треков и первые из них."""
    try:
        rules = smart.Rules.model_validate(data)
    except ValidationError as exc:
        raise HTTPException(422, f"Неверные правила: {exc.errors()[0].get('msg')}")
    tracks = smart.evaluate(db, user, rules)
    return {
        "count": len(tracks),
        "duration": int(sum(t.duration or 0 for t in tracks)),
        "tracks": tracks_out(db, user.id, tracks[:30]),
    }


@router.get("/playlists/{playlist_id}")
def get_playlist(playlist_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    pl = _get_playlist(db, user, playlist_id)
    ids = _all_libs(db, user)
    rules = smart.parse_rules(pl.rules)
    if rules is not None:
        tracks = smart.evaluate(db, user, rules)
        return {**_playlist_summary(db, pl, user, ids, tracks), "tracks": tracks_out(db, user.id, tracks)}
    rows = db.execute(
        select(PlaylistEntry.id, PlaylistEntry.added_by, Track)
        .join(Track, Track.id == PlaylistEntry.track_id)
        .where(PlaylistEntry.playlist_id == pl.id, Track.library_id.in_(ids or [-1]))
        .order_by(PlaylistEntry.position, PlaylistEntry.id)
    ).all()
    starred = starred_ids(db, user.id, "track", (t.id for _, _, t in rows))
    summary = _playlist_summary(db, pl, user, ids)
    people = {}
    if summary["members"]:
        who = {a for _, a, _ in rows if a}
        people = {u.id: _user_brief(u) for u in db.scalars(select(User).where(User.id.in_(who or [-1])))}
    return {
        **summary,
        "tracks": [{**track_out(t, starred), "entry_id": eid, "added_by": people.get(by)} for eid, by, t in rows],
    }


@router.patch("/playlists/{playlist_id}")
def update_playlist(
    playlist_id: int, data: PlaylistUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    pl = _get_playlist(db, user, playlist_id)
    if pl.owner_id != user.id:
        raise HTTPException(403, "Название и правила меняет владелец плейлиста")
    if data.name is not None:
        pl.name = data.name.strip()
    if data.comment is not None:
        pl.comment = data.comment
    if data.is_public is not None:
        pl.is_public = data.is_public
    if data.rules is not None and pl.rules:
        pl.rules = _rules_json(data.rules)
    pl.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _playlist_summary(db, pl, user, _all_libs(db, user))


class MembersIn(BaseModel):
    user_ids: list[int] = Field(default_factory=list, max_length=100)


@router.put("/playlists/{playlist_id}/members")
def set_members(playlist_id: int, data: MembersIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    """Соавторы плейлиста (меняет только владелец)."""
    pl = _get_playlist(db, user, playlist_id)
    if pl.owner_id != user.id:
        raise HTTPException(403, "Соавторов приглашает владелец плейлиста")
    if pl.rules:
        raise HTTPException(400, "Умный плейлист собирается сам — соавторы ему не нужны")
    wanted = set(db.scalars(select(User.id).where(User.id.in_(data.user_ids or [-1]), User.is_active.is_(True), User.id != user.id)))
    db.execute(delete(PlaylistMember).where(PlaylistMember.playlist_id == pl.id, PlaylistMember.user_id.not_in(wanted or [-1])))
    have = set(db.scalars(select(PlaylistMember.user_id).where(PlaylistMember.playlist_id == pl.id)))
    for uid in wanted - have:
        db.add(PlaylistMember(playlist_id=pl.id, user_id=uid))
    pl.updated_at = datetime.now(timezone.utc)
    db.commit()
    return _playlist_summary(db, pl, user, _all_libs(db, user))


@router.post("/playlists/{playlist_id}/leave")
def leave_playlist(playlist_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    db.execute(delete(PlaylistMember).where(PlaylistMember.playlist_id == playlist_id, PlaylistMember.user_id == user.id))
    db.commit()
    return {"ok": True}


@router.get("/users/directory")
def users_directory(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> list[dict]:
    """Кого можно пригласить в совместный плейлист."""
    return [_user_brief(u) for u in db.scalars(select(User).where(User.is_active.is_(True), User.id != user.id).order_by(User.display_name, User.username))]


@router.delete("/playlists/{playlist_id}")
def delete_playlist(playlist_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    pl = _get_playlist(db, user, playlist_id)
    if pl.owner_id != user.id:
        raise HTTPException(403, "Удалить может только владелец")
    db.delete(pl)
    db.commit()
    return {"ok": True}


@router.post("/playlists/{playlist_id}/tracks")
def add_to_playlist(
    playlist_id: int, data: PlaylistTracks, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    pl = _get_playlist(db, user, playlist_id, write=True)
    added = _append_tracks(db, user, pl, data.track_ids)
    db.commit()
    return {"added": added}


@router.delete("/playlists/{playlist_id}/entries/{entry_id}")
def remove_from_playlist(
    playlist_id: int, entry_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    pl = _get_playlist(db, user, playlist_id, write=True)
    db.execute(delete(PlaylistEntry).where(PlaylistEntry.id == entry_id, PlaylistEntry.playlist_id == pl.id))
    pl.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


@router.put("/playlists/{playlist_id}/order")
def reorder_playlist(
    playlist_id: int, data: PlaylistReorder, db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    pl = _get_playlist(db, user, playlist_id, write=True)
    entries = {e.id: e for e in db.scalars(select(PlaylistEntry).where(PlaylistEntry.playlist_id == pl.id))}
    order = [eid for eid in data.entry_ids if eid in entries]
    # записи, которых нет в новом порядке (например, из скрытых папок), остаются в конце
    order += [eid for eid in sorted(entries, key=lambda e: entries[e].position) if eid not in order]
    for pos, eid in enumerate(order):
        entries[eid].position = pos
    pl.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"ok": True}


# ---------------- поток и обложки ----------------


@router.get("/stream/{track_id}")
def stream(
    track_id: int,
    request: Request,
    q: str | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_media_user),
):
    track = _visible_track(db, user, track_id)
    quality = q or user.stream_quality or "original"
    bitrate = QUALITY_BITRATE.get(quality, 0)
    return stream_track(request, db, track, max_bitrate=bitrate, fmt="mp3" if bitrate else None, browser=True)


@router.get("/download/{track_id}")
def download(track_id: int, request: Request, db: Session = Depends(get_db), user: User = Depends(get_media_user)):
    track = _visible_track(db, user, track_id)
    return file_response(request, track_file(db, track), content_type(track.suffix), download_name(track))


@router.get("/cover/album/{album_id}")
def album_cover(
    album_id: int, size: int = 600, db: Session = Depends(get_db), user: User = Depends(get_media_user)
) -> Response:
    album = _visible_album(db, user, album_id)
    path = cover_path(db, album, size)
    if path is None:
        raise HTTPException(404, "Нет обложки")
    return image_response(path)
