"""Защита входа от перебора паролей (в памяти процесса — для одного контейнера достаточно).

Считаем только неудачные попытки. Лимит и на учётную запись, и на IP:
по IP нельзя полагаться полностью — X-Forwarded-For можно подделать,
если порт открыт в локальной сети напрямую.
"""
from __future__ import annotations

import threading
import time

from fastapi import HTTPException

WINDOW = 15 * 60  # сек
MAX_PER_LOGIN = 10
MAX_PER_IP = 30

_lock = threading.Lock()
_fails: dict[str, list[float]] = {}


class TooManyAttempts(HTTPException):
    pass


def _recent(key: str, now: float) -> list[float]:
    hits = [t for t in _fails.get(key, []) if now - t < WINDOW]
    if hits:
        _fails[key] = hits
    else:
        _fails.pop(key, None)
    return hits


def check(login: str, ip: str) -> None:
    now = time.monotonic()
    with _lock:
        by_login = _recent(f"l:{login.lower()}", now)
        by_ip = _recent(f"i:{ip}", now)
        if len(by_login) >= MAX_PER_LOGIN or len(by_ip) >= MAX_PER_IP:
            oldest = min((by_login or by_ip)[:1] or [now])
            wait = max(1, int(WINDOW - (now - oldest)) // 60 + 1)
            raise TooManyAttempts(429, f"Слишком много неудачных попыток. Попробуйте через {wait} мин.")


def fail(login: str, ip: str) -> None:
    now = time.monotonic()
    with _lock:
        for key in (f"l:{login.lower()}", f"i:{ip}"):
            _fails.setdefault(key, []).append(now)
        # не даём словарю расти бесконечно
        if len(_fails) > 10_000:
            for k in list(_fails)[:5_000]:
                _fails.pop(k, None)


def success(login: str) -> None:
    with _lock:
        _fails.pop(f"l:{login.lower()}", None)
