"""Где я остановился: очередь, трек и позиция — общие для всех устройств пользователя.

Та же запись, что у Subsonic savePlayQueue/getPlayQueue, поэтому переход
«приложение на телефоне → браузер» и обратно тоже работает.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..access import allowed_library_ids
from ..db import get_db
from ..models import PlayQueue, Track, User
from ..security import get_current_user
from ..serialize import tracks_out

router = APIRouter(prefix="/api/queue", tags=["queue"])

MAX_TRACKS = 1000


def _aware(dt: datetime | None) -> datetime | None:
    return dt.replace(tzinfo=timezone.utc) if dt and dt.tzinfo is None else dt


def _device_name(pq: PlayQueue) -> str:
    return pq.changed_by or "другое устройство"


@router.get("")
def get_queue(full: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    now = datetime.now(timezone.utc)
    pq = db.get(PlayQueue, user.id)
    if not pq or not pq.current_id:
        return {"empty": True, "server_time": now}
    ids = [i for i in json.loads(pq.track_ids or "[]") if isinstance(i, int)]
    out = {
        "empty": False,
        "server_time": now,
        "changed_at": _aware(pq.changed_at),
        "device_id": pq.device_id or "",
        "device_name": _device_name(pq),
        "playing": bool(pq.playing),
        "current_id": pq.current_id,
        "position": round((pq.position_ms or 0) / 1000, 2),
        "count": len(ids),
    }
    current = db.get(Track, pq.current_id)
    libs = set(allowed_library_ids(db, user, kind="any"))
    if current and current.library_id in libs:
        out["current"] = tracks_out(db, user.id, [current])[0]
    if full:
        rows = {t.id: t for t in db.scalars(select(Track).where(Track.id.in_(ids or [-1]), Track.library_id.in_(libs or [-1])))}
        out["tracks"] = tracks_out(db, user.id, [rows[i] for i in ids if i in rows])
    return out


class QueueIn(BaseModel):
    track_ids: list[int] = Field(max_length=MAX_TRACKS)
    current_id: int | None = None
    position: float = Field(default=0, ge=0)
    playing: bool = False
    device_id: str = Field(default="", max_length=64)
    device_name: str = Field(default="", max_length=128)


@router.put("")
def save_queue(data: QueueIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    pq = db.get(PlayQueue, user.id) or PlayQueue(user_id=user.id)
    pq.track_ids = json.dumps(data.track_ids)
    pq.current_id = data.current_id
    pq.position_ms = int(data.position * 1000)
    pq.playing = data.playing
    pq.device_id = data.device_id
    pq.changed_by = data.device_name or "Браузер"
    pq.changed_at = datetime.now(timezone.utc)
    db.merge(pq)
    db.commit()
    return {"changed_at": pq.changed_at}
