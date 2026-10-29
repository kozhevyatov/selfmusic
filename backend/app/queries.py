"""Общие запросы к медиатеке — используются и веб-API, и Subsonic API.

Везде передаётся список доступных пользователю папок (lib_ids): так права
на папки соблюдаются одинаково во всех клиентах.
"""
from __future__ import annotations

from sqlalchemy import Select, and_, case, desc, func, or_, select
from sqlalchemy.orm import Session

from .models import Album, Artist, Play, Star, Track


def like(q: str) -> str:
    return "%" + q.lower().replace("\\", "\\\\").replace("%", r"\%").replace("_", r"\_") + "%"


def artists_with_counts(db: Session, lib_ids: list[int], q: str = "", only_ids: list[int] | None = None) -> list[tuple]:
    """(Artist, album_count, album_id_with_cover) — исполнители, у которых есть альбомы в доступных папках."""
    if not lib_ids:
        return []
    cover_album = func.max(case((Album.cover.is_not(None), Album.id), else_=None))
    query = (
        select(Artist, func.count(Album.id), cover_album)
        .join(Album, Album.artist_id == Artist.id)
        .where(Album.library_id.in_(lib_ids))
        .group_by(Artist.id)
        .order_by(func.lower(Artist.sort_name), Artist.id)
    )
    if q:
        query = query.where(func.lower(Artist.name).like(like(q), escape="\\"))
    if only_ids is not None:
        query = query.where(Artist.id.in_(only_ids or [-1]))
    return list(db.execute(query).all())


def album_list_query(
    lib_ids: list[int],
    user_id: int,
    sort: str = "newest",
    *,
    genre: str | None = None,
    from_year: int | None = None,
    to_year: int | None = None,
    q: str = "",
    artist_id: int | None = None,
) -> Select:
    query = select(Album).where(Album.library_id.in_(lib_ids or [-1]))
    if genre:
        query = query.where(Album.genre == genre)
    if artist_id is not None:
        query = query.where(Album.artist_id == artist_id)
    if q:
        pattern = like(q)
        query = query.where(
            or_(func.lower(Album.name).like(pattern, escape="\\"), func.lower(Album.artist_name).like(pattern, escape="\\"))
        )
    if from_year is not None or to_year is not None:
        lo, hi = from_year or 0, to_year or 9999
        if lo <= hi:
            query = query.where(Album.year.between(lo, hi)).order_by(Album.year, Album.id)
        else:
            query = query.where(Album.year.between(hi, lo)).order_by(desc(Album.year), Album.id)
        return query

    if sort == "newest":
        query = query.order_by(desc(Album.created_at), desc(Album.id))
    elif sort in ("name", "alphabeticalByName"):
        query = query.order_by(func.lower(Album.sort_name), Album.id)
    elif sort in ("artist", "alphabeticalByArtist"):
        query = query.order_by(func.lower(Album.artist_name), Album.year, Album.id)
    elif sort in ("year", "byYear"):
        query = query.order_by(desc(Album.year), Album.id)
    elif sort == "random":
        query = query.order_by(func.random())
    elif sort in ("frequent", "recent"):
        plays = (
            select(Play.album_id, func.count(Play.id).label("cnt"), func.max(Play.played_at).label("last"))
            .where(Play.user_id == user_id, Play.album_id.is_not(None))
            .group_by(Play.album_id)
            .subquery()
        )
        query = query.join(plays, plays.c.album_id == Album.id)
        query = query.order_by(desc(plays.c.cnt) if sort == "frequent" else desc(plays.c.last), Album.id)
    elif sort in ("starred",):
        query = query.join(Star, and_(Star.item_id == Album.id, Star.kind == "album", Star.user_id == user_id)).order_by(
            desc(Star.created_at)
        )
    elif sort == "highest":
        from .models import Rating

        query = query.join(
            Rating, and_(Rating.item_id == Album.id, Rating.kind == "album", Rating.user_id == user_id)
        ).order_by(desc(Rating.rating), Album.id)
    else:
        query = query.order_by(desc(Album.created_at), desc(Album.id))
    return query


def tracks_query(lib_ids: list[int]) -> Select:
    return select(Track).where(Track.library_id.in_(lib_ids or [-1]))


def album_tracks(db: Session, album_id: int) -> list[Track]:
    return list(
        db.scalars(
            select(Track)
            .join(Album, Album.id == Track.album_id)
            # треки из исключённой подпапки (часть альбома, например CD2) лежат в «тени» — не показываем
            .where(Track.album_id == album_id, Track.library_id == Album.library_id)
            .order_by(func.coalesce(Track.disc_no, 1), func.coalesce(Track.track_no, 9999), Track.path)
        )
    )


def search_tracks(db: Session, lib_ids: list[int], q: str, limit: int, offset: int = 0) -> list[Track]:
    query = tracks_query(lib_ids)
    if q:
        pattern = like(q)
        query = query.where(
            or_(
                func.lower(Track.title).like(pattern, escape="\\"),
                func.lower(Track.artist_name).like(pattern, escape="\\"),
            )
        )
        query = query.order_by(func.lower(Track.title), Track.id)
    else:
        query = query.order_by(Track.id)
    return list(db.scalars(query.offset(offset).limit(limit)))


def top_tracks(db: Session, lib_ids: list[int], artist_id: int, limit: int = 10) -> list[Track]:
    """Самые прослушиваемые треки исполнителя (по всем пользователям), затем — по порядку в альбомах."""
    plays = select(Play.track_id, func.count(Play.id).label("cnt")).group_by(Play.track_id).subquery()
    query = (
        tracks_query(lib_ids)
        .outerjoin(plays, plays.c.track_id == Track.id)
        .where(or_(Track.artist_id == artist_id, Track.album.has(Album.artist_id == artist_id)))
        .order_by(desc(func.coalesce(plays.c.cnt, 0)), Track.album_id, Track.track_no)
        .limit(limit)
    )
    return list(db.scalars(query))


def play_counts(db: Session, user_id: int, track_ids: list[int]) -> dict[int, int]:
    if not track_ids:
        return {}
    rows = db.execute(
        select(Play.track_id, func.count(Play.id))
        .where(Play.user_id == user_id, Play.track_id.in_(track_ids))
        .group_by(Play.track_id)
    )
    return dict(rows.all())


def genres(db: Session, lib_ids: list[int]) -> list[tuple[str, int, int]]:
    rows = db.execute(
        select(Track.genre, func.count(Track.id), func.count(func.distinct(Track.album_id)))
        .where(Track.library_id.in_(lib_ids or [-1]), Track.genre != "")
        .group_by(Track.genre)
        .order_by(func.lower(Track.genre))
    )
    return list(rows.all())
