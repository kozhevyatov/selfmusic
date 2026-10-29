"""Где я остановился: очередь, трек и позиция — общие для всех устройств пользователя.

Та же запись, что у Subsonic savePlayQueue/getPlayQueue, поэтому переход
«приложение на телефоне → браузер» и обратно тоже работает.

Порядок записей — по счётчику rev (время у MariaDB хранится без долей секунды).
Кто играет «главным» — по started_at: время последнего нажатия «играть» / смены трека.
Плановая запись (раз в 15 с) или пауза с устройства, которое уже «перебили» более свежим
стартом на другом устройстве, не принимается: в ответ superseded — и плеер там встаёт на паузу.
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


def _state(db: Session, user: User, pq: PlayQueue, full: bool) -> dict:
    ids = [i for i in json.loads(pq.track_ids or "[]") if isinstance(i, int)]
    out = {
        "empty": False,
        "server_time": datetime.now(timezone.utc),
        "rev": pq.rev or 0,
        "changed_at": _aware(pq.changed_at),
        "started_at": _aware(pq.started_at),
        "device_id": pq.device_id or "",
        "device_name": pq.changed_by or "другое устройство",
        "playing": bool(pq.playing),
        "current_id": pq.current_id,
        "position": round((pq.position_ms or 0) / 1000, 2),
        "count": len(ids),
    }
    libs = set(allowed_library_ids(db, user, kind="any"))
    current = db.get(Track, pq.current_id) if pq.current_id else None
    if current and current.library_id in libs:
        out["current"] = tracks_out(db, user.id, [current])[0]
    if full:
        rows = {t.id: t for t in db.scalars(select(Track).where(Track.id.in_(ids or [-1]), Track.library_id.in_(libs or [-1])))}
        out["tracks"] = tracks_out(db, user.id, [rows[i] for i in ids if i in rows])
    return out


@router.get("")
def get_queue(full: bool = False, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    pq = db.get(PlayQueue, user.id)
    if not pq or not pq.current_id:
        return {"empty": True, "server_time": datetime.now(timezone.utc)}
    return _state(db, user, pq, full)


class QueueIn(BaseModel):
    track_ids: list[int] = Field(max_length=MAX_TRACKS)
    current_id: int | None = None
    position: float = Field(default=0, ge=0)
    playing: bool = False
    device_id: str = Field(default="", max_length=64)
    device_name: str = Field(default="", max_length=128)
    # true — запись из-за нажатия «играть» или смены трека здесь (это устройство становится главным)
    started: bool = False
    # started_at последнего старта на этом устройстве (из ответа сервера), если был
    since: datetime | None = None


@router.put("")
def save_queue(data: QueueIn, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    pq = db.get(PlayQueue, user.id, with_for_update=True)
    if pq and pq.device_id and pq.device_id != data.device_id and pq.playing and not data.started:
        other = _aware(pq.started_at)
        mine = _aware(data.since)
        if other and (mine is None or other > mine):
            # на другом устройстве нажали «играть» позже — эту запись не принимаем
            db.rollback()
            return {"superseded": True, "remote": _state(db, user, pq, False)}
    if pq is None:
        pq = PlayQueue(user_id=user.id, rev=0)
        db.add(pq)
    now = datetime.now(timezone.utc)
    pq.track_ids = json.dumps(data.track_ids)
    pq.current_id = data.current_id
    pq.position_ms = int(data.position * 1000)
    pq.playing = data.playing
    pq.device_id = data.device_id
    pq.changed_by = data.device_name or "Браузер"
    pq.changed_at = now
    pq.rev = (pq.rev or 0) + 1
    if data.started:
        pq.started_at = now
    db.commit()
    return {"superseded": False, "rev": pq.rev, "started_at": _aware(pq.started_at) if data.started else None}
