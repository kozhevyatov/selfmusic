"""Статистика прослушиваний и «Итоги года»."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..access import allowed_library_ids
from ..db import get_db
from ..models import User
from ..security import get_current_user
from ..stats import compute, years_with_plays

router = APIRouter(prefix="/api/stats", tags=["stats"])


@router.get("")
def get_stats(
    period: str = Query("year", pattern="^(week|month|year|all)$"),
    year: int | None = Query(None, ge=1970, le=2100),
    tz: int = Query(0, ge=-14 * 60, le=14 * 60, description="смещение часового пояса в минутах (UTC+7 → 420)"),
    scope: str = Query("me", pattern="^(me|server)$"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    if scope == "server" and not user.is_admin:
        raise HTTPException(403, "Только для администратора")
    if scope == "server":
        from sqlalchemy import select

        from ..models import Library

        libs = list(db.scalars(select(Library.id).where(Library.kind == "music")))
        user_ids = None
    else:
        libs = allowed_library_ids(db, user)
        user_ids = [user.id]
    data = compute(db, libs, user_ids, user, period, year, tz)
    data["years"] = years_with_plays(db, user_ids)
    return data
