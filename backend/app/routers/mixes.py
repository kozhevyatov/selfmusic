"""Подборки (личные): список, подборка, «обновить», «не подходит», «сохранить как плейлист».
Плюс настройки и состояние анализа звука для администратора."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from .. import mixes as mx
from ..access import allowed_library_ids
from ..analysis import analyzer, save_config
from ..db import get_db
from ..models import Album, Playlist, PlaylistEntry, Track, TrackFeature, User
from ..security import get_current_user, require_admin
from ..serialize import cover_url, tracks_out

router = APIRouter(prefix="/api", tags=["mixes"])

GROUPS = [
    ("time", "По времени суток"),
    ("mood", "По настроению"),
    ("season", "Времена года"),
    ("personal", "Из вашей истории"),
]


def load_tracks(db: Session, user: User, ids: list[int]) -> list[Track]:
    if not ids:
        return []
    libs = allowed_library_ids(db, user)
    found = {t.id: t for t in db.scalars(select(Track).where(Track.id.in_(ids), Track.library_id.in_(libs or [-1])))}
    return [found[i] for i in ids if i in found]


def _card(db: Session, m: mx.MixDef, ids: list[int], now_key: str, season_key: str) -> dict:
    album_ids: list[int] = []
    duration = 0.0
    if ids:
        rows = db.execute(select(Track.id, Track.album_id, Track.duration).where(Track.id.in_(ids))).all()
        by_id = {r[0]: r for r in rows}
        for i in ids:
            r = by_id.get(i)
            if not r:
                continue
            duration += r[2] or 0
            if r[1] not in album_ids and len(album_ids) < 12:
                album_ids.append(r[1])
    albums = {a.id: a for a in db.scalars(select(Album).where(Album.id.in_(album_ids or [-1]), Album.cover.is_not(None)))}
    covers = [cover_url(albums[a]) for a in album_ids if a in albums][:4]
    return {
        "key": m.key,
        "group": m.group,
        "title": m.title,
        "subtitle": m.subtitle,
        "icon": m.icon,
        "colors": list(m.colors),
        "track_count": len(ids),
        "duration": int(duration),
        "covers": covers,
        "current": m.key in (now_key, season_key),
    }


@router.get("/mixes")
def list_mixes(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    now_key, season_key = mx.current_time_mix(), mx.current_season()
    cache: dict = {}
    cards = {}
    for m in mx.visible_mixes():
        ids = mx.get_mix(db, user, m.key, cache)
        if m.group == "personal" and len(ids) < 8:
            continue  # пока мало истории — не показываем пустышку
        cards[m.key] = _card(db, m, ids, now_key, season_key)
    groups = []
    for key, title in GROUPS:
        items = [c for c in cards.values() if c["group"] == key]
        if items:
            groups.append({"key": key, "title": title, "items": items})
    total = db.scalar(select(Track.id).limit(1)) is not None
    analyzed = db.scalar(select(TrackFeature.track_id).where(TrackFeature.error.is_(None)).limit(1)) is not None
    return {
        "now": cards.get(now_key),
        "season": cards.get(season_key),
        "groups": groups,
        "analysis_ready": analyzed or not total,
    }


@router.get("/mixes/{key}")
def get_mix(key: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    m = mx.BY_KEY.get(key)
    if m is None:
        raise HTTPException(404, "Подборка не найдена")
    ids = mx.get_mix(db, user, key)
    tracks = load_tracks(db, user, ids)
    card = _card(db, m, [t.id for t in tracks], mx.current_time_mix(), mx.current_season())
    return {**card, "tracks": tracks_out(db, user.id, tracks)}


@router.post("/mixes/{key}/refresh")
def refresh_mix(key: str, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    if key not in mx.BY_KEY:
        raise HTTPException(404, "Подборка не найдена")
    mx.get_mix(db, user, key, refresh=True)
    return get_mix(key, db, user)


class HideIn(BaseModel):
    track_id: int


@router.post("/mixes/{key}/hide")
def hide_in_mix(key: str, data: HideIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    if key not in mx.BY_KEY:
        raise HTTPException(404, "Подборка не найдена")
    mx.hide_track(db, user, key, data.track_id)
    return {"ok": True}


class SaveIn(BaseModel):
    name: str = Field(default="", max_length=255)


@router.post("/mixes/{key}/save")
def save_mix(key: str, data: SaveIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    m = mx.BY_KEY.get(key)
    if m is None:
        raise HTTPException(404, "Подборка не найдена")
    tracks = load_tracks(db, user, mx.get_mix(db, user, key))
    if not tracks:
        raise HTTPException(400, "Подборка пуста")
    today = mx.local_now().strftime("%d.%m.%Y")
    pl = Playlist(owner_id=user.id, name=(data.name.strip() or f"{m.title} · {today}"), comment=m.subtitle)
    db.add(pl)
    db.flush()
    for pos, t in enumerate(tracks):
        db.add(PlaylistEntry(playlist_id=pl.id, track_id=t.id, position=pos))
    pl.updated_at = datetime.now(timezone.utc)
    db.commit()
    return {"id": pl.id, "name": pl.name}


# ---------------- анализ звука (админ) ----------------


class AnalysisSettings(BaseModel):
    enabled: bool | None = None
    start: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}$")
    end: str | None = Field(default=None, pattern=r"^\d{1,2}:\d{2}$")


@router.get("/admin/analysis")
def analysis_status(_: User = Depends(require_admin)) -> dict:
    return analyzer.status()


@router.put("/admin/analysis")
def analysis_update(data: AnalysisSettings, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    save_config(db, data.enabled, data.start, data.end)
    db.commit()
    return analyzer.status()


@router.post("/admin/analysis/run")
def analysis_run(_: User = Depends(require_admin)) -> dict:
    analyzer.run_now()
    return analyzer.status()


@router.post("/admin/analysis/stop")
def analysis_stop(_: User = Depends(require_admin)) -> dict:
    analyzer.stop_now()
    return analyzer.status()
