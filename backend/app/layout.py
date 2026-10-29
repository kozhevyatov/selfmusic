"""Раскладка личных папок пользователей:

    media/<логин>/music   — «Моя музыка»
    media/<логин>/books   — «Мои аудиокниги»

(внутри контейнера media/ подключена как UPLOAD_ROOT = /uploads).
Треки хранят пути относительно своей папки, поэтому переезд папки — это переименование
каталога и новый Library.path; история, плейлисты и оценки не затрагиваются.
"""
from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import UPLOAD_ROOT
from .models import Library, User

log = logging.getLogger("uvicorn.error")

LAYOUT_VERSION = "2"
SUBDIR = {"music": "music", "audiobooks": "books"}


def slug(name: str) -> str:
    s = re.sub(r"[^\w.-]+", "_", name, flags=re.UNICODE).strip("._")
    return s or "user"


def _personal(db: Session, user_id: int) -> list[Library]:
    return list(
        db.scalars(select(Library).where(Library.owner_id == user_id, Library.hidden_of.is_(None), Library.kind.in_(SUBDIR)))
    )


def _busy(db: Session, home: Path, user_id: int) -> bool:
    """Папку уже занимает другой пользователь (или остатки удалённого) — брать нельзя."""
    prefix = home.as_posix().rstrip("/") + "/"
    for lib_path, owner in db.execute(select(Library.path, Library.owner_id)):
        if owner != user_id and (lib_path == home.as_posix() or lib_path.startswith(prefix)):
            return True
    if home.exists():
        ours = {Path(lib.path) for lib in _personal(db, user_id)}
        if home in ours:
            return False  # старая раскладка: uploads/<логин> — переложим внутрь как <логин>/music
        extra = [p for p in home.iterdir() if not p.name.startswith((".", "@")) and p not in ours]
        return bool(extra)
    return False


def user_home(db: Session, user: User) -> Path:
    """Папка пользователя: по логину, а если она занята — с номером."""
    for lib in _personal(db, user.id):
        p = Path(lib.path)
        if p.name == SUBDIR.get(lib.kind) and p.parent.parent == UPLOAD_ROOT:
            return p.parent  # уже в новой раскладке
    home = UPLOAD_ROOT / slug(user.username)
    if _busy(db, home, user.id):
        home = UPLOAD_ROOT / f"{slug(user.username)}-{user.id}"
    return home


def _move_dir(src: Path, dst: Path) -> None:
    """src → dst, в том числе если dst лежит внутри src (alexey → alexey/music)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        if any(dst.iterdir()):
            raise OSError(f"{dst} уже существует и не пуста")
        dst.rmdir()
    tmp = UPLOAD_ROOT / f".moving-{time.time_ns()}"
    os.rename(src, tmp)
    dst.parent.mkdir(parents=True, exist_ok=True)
    os.rename(tmp, dst)


def place_user(db: Session, user: User, home: Path | None = None) -> None:
    """Переложить личные папки пользователя в home/music и home/books (и обновить пути в базе)."""
    home = home or user_home(db, user)
    for lib in _personal(db, user.id):
        target = home / SUBDIR[lib.kind]
        src = Path(lib.path)
        if src == target:
            continue
        try:
            if src.is_dir():
                _move_dir(src, target)
            else:
                target.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            log.warning("Личная папка %s не перенесена в %s: %s", src, target, exc)
            continue
        lib.path = target.as_posix()
        for shadow in db.scalars(select(Library).where(Library.hidden_of == lib.id)):
            shadow.path = lib.path
        db.flush()
        log.info("Личная папка: %s → %s", src, target)


def migrate_layout(db: Session) -> None:
    """Один раз: старые личные папки (uploads/ivan, uploads/ivan-books) → media/ivan/music, media/ivan/books."""
    from .app_settings import get_setting, set_setting  # noqa: PLC0415

    if get_setting(db, "media_layout") == LAYOUT_VERSION:
        return
    if not UPLOAD_ROOT.is_dir():
        return
    owners = set(db.scalars(select(Library.owner_id).where(Library.owner_id.is_not(None))))
    for uid in owners:
        user = db.get(User, uid)
        if user:
            place_user(db, user)
    set_setting(db, "media_layout", LAYOUT_VERSION)
    db.commit()


def rename_home(db: Session, user: User) -> None:
    """Логин поменялся — папка пользователя следует за ним (если новое имя свободно)."""
    libs = _personal(db, user.id)
    if not libs:
        return
    current = None
    for lib in libs:
        p = Path(lib.path)
        if p.name == SUBDIR.get(lib.kind) and p.parent.parent == UPLOAD_ROOT:
            current = p.parent
    wanted = UPLOAD_ROOT / slug(user.username)
    if current is None or current == wanted or _busy(db, wanted, user.id):
        return
    try:
        if wanted.exists():
            wanted.rmdir()  # пустая — можно занять
        os.rename(current, wanted)
    except OSError as exc:
        log.warning("Папка пользователя не переименована %s → %s: %s", current, wanted, exc)
        return
    for lib in libs:
        lib.path = (wanted / Path(lib.path).name).as_posix()
        for shadow in db.scalars(select(Library).where(Library.hidden_of == lib.id)):
            shadow.path = lib.path
    db.flush()
