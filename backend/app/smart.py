"""Умные плейлисты: список треков собирается по правилам и обновляется сам.

Правила (JSON в playlists.rules):
    {"match": "all" | "any",
     "rules": [{"field": "genre", "op": "contains", "value": "rock"}, …],
     "sort": "random" | "added" | "played" | "plays" | "year" | "artist" | "title" | "rating" | "energy",
     "limit": 100}

Пример «Рок 80-х с оценкой 4+, который не слушал месяц»:
    genre contains rock · year between [1980, 1989] · rating gte 4 · last_played not_in_last 30
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import and_, exists, func, not_, or_, select
from sqlalchemy.orm import Session

from .access import allowed_library_ids
from .models import Album, Play, Rating, Star, Track, TrackFeature, User

TEXT_FIELDS = {
    "title": Track.title,
    "artist": Track.artist_name,
    "album": Album.name,
    "genre": Track.genre,
    "format": Track.suffix,
    "path": Track.path,
}
NUM_FIELDS = {"year", "duration", "bitrate", "plays", "rating", "bpm", "energy", "mood"}
DATE_FIELDS = {"added", "last_played"}
BOOL_FIELDS = {"starred", "lossless"}
LOSSLESS = ("flac", "wav", "aiff", "aif", "ape", "wv", "alac", "dsf")

TEXT_OPS = {"contains", "not_contains", "is", "is_not", "starts"}
NUM_OPS = {"eq", "ne", "gt", "gte", "lt", "lte", "between"}
DATE_OPS = {"in_last", "not_in_last", "never"}
BOOL_OPS = {"is_true", "is_false"}


class Rule(BaseModel):
    field: str = Field(max_length=32)
    op: str = Field(max_length=16)
    value: str | float | int | list[float] | None = None


class Rules(BaseModel):
    match: str = Field(default="all", pattern="^(all|any)$")
    rules: list[Rule] = Field(default_factory=list, max_length=20)
    sort: str = Field(default="random", pattern="^(random|added|played|plays|year|artist|title|rating|energy)$")
    limit: int = Field(default=100, ge=1, le=1000)


def _num(v) -> float:  # noqa: ANN001
    try:
        return float(v)
    except (TypeError, ValueError):
        raise HTTPException(422, f"Нужно число, а не «{v}»")


def build_query(db: Session, user: User, rules: Rules):  # noqa: ANN201
    libs = allowed_library_ids(db, user)
    plays = (
        select(Play.track_id, func.count().label("cnt"), func.max(Play.played_at).label("last"))
        .where(Play.user_id == user.id)
        .group_by(Play.track_id)
        .subquery()
    )
    rating = select(Rating.item_id, Rating.rating).where(Rating.user_id == user.id, Rating.kind == "track").subquery()
    q = (
        select(Track)
        .join(Album, Album.id == Track.album_id)
        .outerjoin(plays, plays.c.track_id == Track.id)
        .outerjoin(rating, rating.c.item_id == Track.id)
        .outerjoin(TrackFeature, TrackFeature.track_id == Track.id)
        .where(Track.library_id.in_(libs or [-1]))
    )
    now = datetime.now(timezone.utc)
    conds = []
    for r in rules.rules:
        f, op, v = r.field, r.op, r.value
        if f in TEXT_FIELDS:
            if op not in TEXT_OPS:
                raise HTTPException(422, f"Неизвестное условие «{op}»")
            col = func.lower(TEXT_FIELDS[f])
            text = str(v or "").strip().lower()
            if op == "contains":
                conds.append(col.like(f"%{text}%"))
            elif op == "not_contains":
                conds.append(not_(col.like(f"%{text}%")))
            elif op == "is":
                conds.append(col == text)
            elif op == "is_not":
                conds.append(col != text)
            elif op == "starts":
                conds.append(col.like(f"{text}%"))
        elif f in NUM_FIELDS:
            if op not in NUM_OPS:
                raise HTTPException(422, f"Неизвестное условие «{op}»")
            col = {
                "year": Track.year,
                "duration": Track.duration,
                "bitrate": Track.bitrate,
                "plays": func.coalesce(plays.c.cnt, 0),
                "rating": func.coalesce(rating.c.rating, 0),
                "bpm": TrackFeature.bpm,
                "energy": TrackFeature.energy * 100,
                "mood": TrackFeature.valence * 100,
            }[f]
            if op == "between":
                if not isinstance(v, list) or len(v) != 2:
                    raise HTTPException(422, "Для «между» нужно два числа")
                lo, hi = sorted((_num(v[0]), _num(v[1])))
                conds.append(col.between(lo, hi))
            else:
                n = _num(v)
                conds.append({"eq": col == n, "ne": col != n, "gt": col > n, "gte": col >= n, "lt": col < n, "lte": col <= n}[op])
        elif f in DATE_FIELDS:
            if op not in DATE_OPS:
                raise HTTPException(422, f"Неизвестное условие «{op}»")
            col = Track.created_at if f == "added" else plays.c.last
            if op == "never":
                conds.append(col.is_(None))
                continue
            since = now - timedelta(days=_num(v))
            if op == "in_last":
                conds.append(col >= since)
            else:  # не было за последние N дней (в том числе никогда)
                conds.append(or_(col.is_(None), col < since))
        elif f in BOOL_FIELDS:
            if op not in BOOL_OPS:
                raise HTTPException(422, f"Неизвестное условие «{op}»")
            if f == "starred":
                c = exists().where(Star.user_id == user.id, Star.kind == "track", Star.item_id == Track.id)
            else:
                c = func.lower(Track.suffix).in_(LOSSLESS)
            conds.append(c if op == "is_true" else not_(c))
        else:
            raise HTTPException(422, f"Неизвестное поле «{f}»")
    if conds:
        q = q.where(and_(*conds) if rules.match == "all" else or_(*conds))
    order = {
        "random": [func.random()],
        "added": [Track.created_at.desc()],
        "played": [plays.c.last.desc()],
        "plays": [func.coalesce(plays.c.cnt, 0).desc(), Track.title],
        "year": [Track.year.desc(), Album.id, Track.track_no],
        "artist": [Track.artist_name, Album.year, Album.id, Track.track_no],
        "title": [Track.title],
        "rating": [func.coalesce(rating.c.rating, 0).desc(), Track.title],
        "energy": [TrackFeature.energy.desc()],
    }[rules.sort]
    return q.order_by(*order).limit(rules.limit)


def parse_rules(raw: str | None) -> Rules | None:
    if not raw:
        return None
    try:
        return Rules.model_validate(json.loads(raw))
    except Exception:  # noqa: BLE001
        return None


def evaluate(db: Session, user: User, rules: Rules) -> list[Track]:
    return list(db.scalars(build_query(db, user, rules)).unique())
