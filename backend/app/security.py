from __future__ import annotations

import base64
import hashlib
import secrets
import string
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError
from cryptography.fernet import Fernet, InvalidToken
from fastapi import Depends, HTTPException, Request, Response, status
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import User

ALGORITHM = "HS256"
REFRESH_COOKIE = "sm_refresh"
# Cookie для <audio> и <img>: они не умеют передавать заголовок Authorization
MEDIA_COOKIE = "sm_media"
_ph = PasswordHasher()


def hash_password(password: str) -> str:
    return _ph.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    try:
        return _ph.verify(hashed, password)
    except (VerifyMismatchError, InvalidHashError):
        return False


# ---------- пароль для Subsonic-приложений ----------


def _fernet() -> Fernet:
    key = hashlib.sha256(("subsonic:" + settings.secret_key).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken:
        return None


def generate_app_password(length: int = 16) -> str:
    # Без похожих символов (0/O, 1/l), чтобы удобно было набирать на телефоне
    alphabet = "".join(c for c in string.ascii_letters + string.digits if c not in "0O1lI")
    return "".join(secrets.choice(alphabet) for _ in range(length))


# ---------- токены ----------


def _encode(payload: dict, lifetime: timedelta) -> str:
    now = datetime.now(timezone.utc)
    payload = {**payload, "iat": now, "exp": now + lifetime}
    return jwt.encode(payload, settings.secret_key, algorithm=ALGORITHM)


def create_access_token(user: User) -> str:
    return _encode(
        {"sub": str(user.id), "type": "access", "adm": user.is_admin},
        timedelta(minutes=settings.access_token_minutes),
    )


SHORT_SESSION = timedelta(days=1)


def refresh_lifetime(remember: bool) -> timedelta:
    return timedelta(days=settings.refresh_token_days) if remember else SHORT_SESSION


def create_refresh_token(user: User, remember: bool = True) -> str:
    return _encode(
        {"sub": str(user.id), "type": "refresh", "ver": user.token_version, "rem": remember},
        refresh_lifetime(remember),
    )


def create_media_token(user: User, remember: bool = True) -> str:
    return _encode({"sub": str(user.id), "type": "media", "ver": user.token_version}, refresh_lifetime(remember))


def decode_token(token: str, expected_type: str) -> dict:
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[ALGORITHM])
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Недействительный токен")
    if payload.get("type") != expected_type:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Недействительный токен")
    return payload


def _is_secure(request: Request) -> bool:
    if settings.cookie_secure == "auto":
        # За reverse proxy схема берётся из X-Forwarded-Proto (uvicorn --proxy-headers).
        return request.url.scheme == "https"
    return settings.cookie_secure.lower() in ("1", "true", "yes")


def set_session_cookies(response: Response, user: User, refresh: str, request: Request, remember: bool = True) -> None:
    max_age = settings.refresh_token_days * 86400 if remember else None
    secure = _is_secure(request)
    response.set_cookie(
        REFRESH_COOKIE, refresh, max_age=max_age, httponly=True, secure=secure, samesite="lax", path="/api/auth"
    )
    response.set_cookie(
        MEDIA_COOKIE,
        create_media_token(user, remember),
        max_age=max_age,
        httponly=True,
        secure=secure,
        samesite="lax",
        path="/api",
    )


def clear_session_cookies(response: Response) -> None:
    response.delete_cookie(REFRESH_COOKIE, path="/api/auth")
    response.delete_cookie(MEDIA_COOKIE, path="/api")


def _bearer(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


def _active_user(db: Session, user_id: int) -> User:
    user = db.get(User, user_id)
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Пользователь не найден")
    return user


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = _bearer(request)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется авторизация")
    payload = decode_token(token, "access")
    return _active_user(db, int(payload["sub"]))


def get_media_user(request: Request, db: Session = Depends(get_db)) -> User:
    """Для потоков и обложек: Bearer-токен (приложение) или media-cookie (браузер)."""
    if _bearer(request):
        return get_current_user(request, db)
    token = request.cookies.get(MEDIA_COOKIE)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется авторизация")
    payload = decode_token(token, "media")
    user = _active_user(db, int(payload["sub"]))
    if payload.get("ver") != user.token_version:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Сессия истекла")
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Нужны права администратора")
    return user
