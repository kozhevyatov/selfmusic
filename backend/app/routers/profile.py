"""Личный кабинет: имя, email, пароль, качество потока, пароль для приложений."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import ratelimit
from ..db import get_db
from ..models import User
from ..schemas import PasswordChange, ProfileUpdate, TokenOut, UserOut
from ..security import (
    REFRESH_COOKIE,
    decode_token,
    decrypt_secret,
    encrypt_secret,
    generate_app_password,
    get_current_user,
    hash_password,
    verify_password,
)
from .auth import issue_tokens

router = APIRouter(prefix="/api/me", tags=["profile"])


@router.get("", response_model=UserOut)
def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.patch("", response_model=UserOut)
def update_profile(data: ProfileUpdate, db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> User:
    if data.display_name is not None:
        user.display_name = " ".join(data.display_name.split()) or user.username
    if data.email is not None:
        email = data.email.strip().lower()
        if email != user.email:
            taken = db.scalar(select(func.count()).select_from(User).where(User.email == email, User.id != user.id))
            if taken:
                raise HTTPException(409, "Этот email уже занят")
            user.email = email
    if data.stream_quality is not None:
        user.stream_quality = data.stream_quality
    db.commit()
    db.refresh(user)
    return user


@router.post("/password", response_model=TokenOut)
def change_password(
    data: PasswordChange,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> TokenOut:
    ip = request.client.host if request.client else "?"
    ratelimit.check(user.username, ip)
    if not verify_password(data.current_password, user.password_hash):
        ratelimit.fail(user.username, ip)
        raise HTTPException(400, "Текущий пароль указан неверно")
    user.password_hash = hash_password(data.new_password)
    user.token_version += 1  # остальные устройства выходят
    db.commit()
    db.refresh(user)
    remember = True
    cookie = request.cookies.get(REFRESH_COOKIE)
    if cookie:
        try:
            remember = bool(decode_token(cookie, "refresh").get("rem", True))
        except HTTPException:
            pass
    return issue_tokens(user, request, response, remember)


@router.get("/app-password")
def get_app_password(user: User = Depends(get_current_user)) -> dict:
    """Пароль для Subsonic-приложений (Symfonium, Amperfy, Tempo…).

    Отдельный от основного: протокол Subsonic передаёт md5(пароль + соль), поэтому
    серверу нужно знать пароль в открытом виде. Основной пароль так хранить нельзя.
    """
    return {"username": user.username, "password": decrypt_secret(user.subsonic_password)}


@router.post("/app-password")
def regenerate_app_password(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    password = generate_app_password()
    user.subsonic_password = encrypt_secret(password)
    db.commit()
    return {"username": user.username, "password": password}


@router.delete("/app-password")
def remove_app_password(db: Session = Depends(get_db), user: User = Depends(get_current_user)) -> dict:
    user.subsonic_password = None
    db.commit()
    return {"username": user.username, "password": None}
