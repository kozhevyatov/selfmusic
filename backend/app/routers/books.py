"""Аудиокниги: полка, книга с главами, прогресс (синхронизация между устройствами), закладки, серии, авторы."""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import desc, func, or_, select
from sqlalchemy.orm import Session

from ..access import allowed_library_ids
from ..db import get_db
from ..models import Album, Book, Bookmark, BookProgress, Track, User
from ..scanner import book_tracks_sorted
from ..security import get_current_user
from ..serialize import cover_url, tracks_out

router = APIRouter(prefix="/api", tags=["books"])


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime | None) -> datetime | None:
    return dt.replace(tzinfo=timezone.utc) if dt and dt.tzinfo is None else dt


def book_libs(db: Session, user: User) -> list[int]:
    return allowed_library_ids(db, user, kind="audiobooks")


def _progress_out(p: BookProgress | None) -> dict | None:
    if p is None:
        return None
    return {
        "track_id": p.track_id,
        "position": round(p.position or 0, 2),
        "progress": round(p.progress or 0, 4),
        "speed": p.speed or 1.0,
        "finished": p.finished,
        "updated_at": _aware(p.updated_at),
    }


def _card(a: Album, b: Book | None, p: BookProgress | None) -> dict:
    return {
        "id": a.id,
        "title": a.name,
        "subtitle": b.subtitle if b else "",
        "author": (b.author if b else a.artist_name) or "",
        "narrator": b.narrator if b else "",
        "series": b.series if b else "",
        "series_seq": b.series_seq if b else None,
        "year": a.year,
        "cover": cover_url(a),
        "duration": a.duration,
        "track_count": a.track_count,
        "size": a.size,
        "added_at": _aware(a.created_at),
        "progress": _progress_out(p),
    }


def _query(db: Session, user: User):  # noqa: ANN202
    libs = book_libs(db, user)
    return (
        select(Album, Book, BookProgress)
        .outerjoin(Book, Book.album_id == Album.id)
        .outerjoin(BookProgress, (BookProgress.album_id == Album.id) & (BookProgress.user_id == user.id))
        .where(Album.library_id.in_(libs or [-1]))
    )


@router.get("/books")
def list_books(
    q: str = "",
    sort: str = Query("recent", pattern="^(recent|title|author|series|listened)$"),
    filter: str = Query("all", pattern="^(all|in_progress|not_started|finished)$"),
    series: str | None = None,
    author: str | None = None,
    limit: int = Query(500, ge=1, le=2000),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> list[dict]:
    query = _query(db, user)
    if q.strip():
        like = f"%{q.strip().lower()}%"
        query = query.where(
            or_(func.lower(Album.name).like(like), func.lower(Book.author).like(like), func.lower(Book.series).like(like), func.lower(Book.narrator).like(like))
        )
    if series is not None:
        query = query.where(Book.series == series)
    if author is not None:
        query = query.where(Book.author == author)
    if filter == "in_progress":
        query = query.where(BookProgress.album_id.is_not(None), BookProgress.finished.is_(False))
    elif filter == "finished":
        query = query.where(BookProgress.finished.is_(True))
    elif filter == "not_started":
        query = query.where(BookProgress.album_id.is_(None))
    if series is not None or sort == "series":
        query = query.order_by(Book.series, func.coalesce(Book.series_seq, 9999), Album.sort_name)
    elif sort == "title":
        query = query.order_by(Album.sort_name)
    elif sort == "author":
        query = query.order_by(Book.author, Book.series, func.coalesce(Book.series_seq, 9999), Album.sort_name)
    elif sort == "listened":
        query = query.order_by(desc(func.coalesce(BookProgress.updated_at, Album.created_at)))
    else:
        query = query.order_by(desc(Album.created_at))
    return [_card(a, b, p) for a, b, p in db.execute(query.limit(limit)).all()]


@router.get("/books/home")
def books_home(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    base = _query(db, user)
    cont = db.execute(
        base.where(BookProgress.album_id.is_not(None), BookProgress.finished.is_(False)).order_by(desc(BookProgress.updated_at)).limit(12)
    ).all()
    recent = db.execute(base.order_by(desc(Album.created_at)).limit(18)).all()
    libs = book_libs(db, user)
    total = db.scalar(select(func.count(Album.id)).where(Album.library_id.in_(libs or [-1]))) or 0
    # серии и авторы: имя, сколько книг, обложка первой
    series_rows = db.execute(
        select(Book.series, Book.author, func.count(Book.album_id), func.min(Album.id))
        .join(Album, Album.id == Book.album_id)
        .where(Album.library_id.in_(libs or [-1]), Book.series != "")
        .group_by(Book.series, Book.author)
        .order_by(Book.series)
    ).all()
    author_rows = db.execute(
        select(Book.author, func.count(Book.album_id), func.min(Album.id))
        .join(Album, Album.id == Book.album_id)
        .where(Album.library_id.in_(libs or [-1]))
        .group_by(Book.author)
        .order_by(Book.author)
    ).all()
    first_ids = {r[3] for r in series_rows} | {r[2] for r in author_rows}
    albums = {a.id: a for a in db.scalars(select(Album).where(Album.id.in_(first_ids or [-1])))}
    return {
        "total": total,
        "continue": [_card(a, b, p) for a, b, p in cont],
        "recent": [_card(a, b, p) for a, b, p in recent],
        "series": [
            {"name": s, "author": au, "count": n, "cover": cover_url(albums.get(aid))} for s, au, n, aid in series_rows
        ],
        "authors": [{"name": au, "count": n, "cover": cover_url(albums.get(aid))} for au, n, aid in author_rows],
    }


def _visible_book(db: Session, user: User, book_id: int) -> tuple[Album, Book | None]:
    album = db.get(Album, book_id)
    if not album or album.library_id not in book_libs(db, user):
        raise HTTPException(404, "Книга не найдена")
    return album, db.get(Book, book_id)


def _chapters(tracks: list[Track], book: Book | None) -> list[dict]:
    """Главы книги с началом от начала книги (book_start) — для общей шкалы прогресса."""
    inner = json.loads(book.chapters or "[]") if book else []
    out: list[dict] = []
    if inner and len(tracks) == 1:
        for i, c in enumerate(inner):
            out.append({"index": i, "track_id": tracks[0].id, "title": c["title"], "start": c["start"], "end": c["end"], "book_start": c["start"]})
        return out
    offset = 0.0
    for i, t in enumerate(tracks):
        out.append({"index": i, "track_id": t.id, "title": t.title, "start": 0.0, "end": round(t.duration, 3), "book_start": round(offset, 3)})
        offset += t.duration or 0
    return out


@router.get("/books/{book_id}")
def get_book(book_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    album, book = _visible_book(db, user, book_id)
    tracks = book_tracks_sorted(list(db.scalars(select(Track).where(Track.album_id == album.id))))
    progress = db.get(BookProgress, (user.id, album.id))
    marks = db.scalars(
        select(Bookmark).where(Bookmark.user_id == user.id, Bookmark.track_id.in_([t.id for t in tracks] or [-1])).order_by(Bookmark.created_at)
    )
    return {
        **_card(album, book, progress),
        "description": book.description if book else "",
        "chapters": _chapters(tracks, book),
        "tracks": tracks_out(db, user.id, tracks),
        "bookmarks": [
            {"id": m.id, "track_id": m.track_id, "position": m.position, "comment": m.comment, "created_at": _aware(m.created_at)} for m in marks
        ],
    }


class ProgressIn(BaseModel):
    track_id: int
    position: float = Field(ge=0)
    speed: float | None = Field(default=None, ge=0.5, le=3.5)
    finished: bool | None = None


def save_progress(db: Session, user: User, album: Album, track_id: int, position: float, speed: float | None = None, finished: bool | None = None) -> BookProgress:
    tracks = book_tracks_sorted(list(db.scalars(select(Track).where(Track.album_id == album.id))))
    total = sum(t.duration or 0 for t in tracks) or 1
    offset = 0.0
    for t in tracks:
        if t.id == track_id:
            break
        offset += t.duration or 0
    else:
        raise HTTPException(400, "Глава не из этой книги")
    p = db.get(BookProgress, (user.id, album.id))
    if p is None:
        p = BookProgress(user_id=user.id, album_id=album.id, started_at=utcnow(), speed=1.0, finished=False)
        db.add(p)
    p.track_id = track_id
    p.position = position
    p.progress = min(1.0, (offset + position) / total)
    if speed is not None:
        p.speed = speed
    if finished is not None:
        p.finished = finished
    elif total - (offset + position) < 15:
        p.finished = True  # дослушали до конца книги
    elif p.finished and total - (offset + position) > 60:
        p.finished = False  # начали слушать заново
    p.updated_at = utcnow()
    db.commit()
    return p


@router.put("/books/{book_id}/progress")
def put_progress(book_id: int, data: ProgressIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    album, _ = _visible_book(db, user, book_id)
    return _progress_out(save_progress(db, user, album, data.track_id, data.position, data.speed, data.finished)) or {}


class FinishedIn(BaseModel):
    finished: bool


@router.post("/books/{book_id}/finished")
def mark_finished(book_id: int, data: FinishedIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    album, _ = _visible_book(db, user, book_id)
    p = db.get(BookProgress, (user.id, album.id))
    if not data.finished and p is not None:
        db.delete(p)  # «Не прослушана» — начать с начала
        db.commit()
        return {"progress": None}
    tracks = book_tracks_sorted(list(db.scalars(select(Track).where(Track.album_id == album.id))))
    if not tracks:
        raise HTTPException(400, "Книга пуста")
    p = save_progress(db, user, album, tracks[-1].id, tracks[-1].duration or 0, finished=True)
    return {"progress": _progress_out(p)}


class BookmarkIn(BaseModel):
    track_id: int
    position: float = Field(ge=0)
    comment: str = Field(default="", max_length=1000)


@router.post("/books/{book_id}/bookmarks")
def add_bookmark(book_id: int, data: BookmarkIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    album, _ = _visible_book(db, user, book_id)
    track = db.get(Track, data.track_id)
    if not track or track.album_id != album.id:
        raise HTTPException(400, "Глава не из этой книги")
    m = Bookmark(user_id=user.id, track_id=track.id, position=data.position, comment=data.comment.strip(), created_at=utcnow())
    db.add(m)
    db.commit()
    return {"id": m.id, "track_id": m.track_id, "position": m.position, "comment": m.comment, "created_at": _aware(m.created_at)}


@router.delete("/bookmarks/{bookmark_id}")
def delete_bookmark(bookmark_id: int, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    m = db.get(Bookmark, bookmark_id)
    if not m or m.user_id != user.id:
        raise HTTPException(404, "Закладка не найдена")
    db.delete(m)
    db.commit()
    return {"ok": True}
