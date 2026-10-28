"""Права доступа к папкам с музыкой.

Чтение: администратор видит все общие включённые папки; пользователь — те, что ему открыли,
плюс свою личную папку. Всё, что отдаёт API (и веб, и Subsonic), фильтруется через allowed_library_ids.

Запись (загрузка, редактор тегов): право записи у пользователя на папку И папка доступна
для записи на диске (не смонтирована только для чтения).
"""
from __future__ import annotations

import os
import re

from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from .config import UPLOAD_ROOT
from .models import Library, LibraryAccess, Upload, User


def allowed_library_ids(db: Session, user: User, only: int | None = None) -> list[int]:
    access = select(LibraryAccess.library_id).where(LibraryAccess.user_id == user.id)
    cond = or_(Library.owner_id == user.id, Library.id.in_(access))
    if user.is_admin:
        cond = or_(cond, Library.owner_id.is_(None))
    ids = list(db.scalars(select(Library.id).where(Library.enabled.is_(True), cond)))
    if only is not None:
        return [i for i in ids if i == only]
    return ids


def fs_writable(path: str) -> bool:
    return os.path.isdir(path) and os.access(path, os.W_OK | os.X_OK)


def has_write_right(db: Session, user: User, lib: Library) -> bool:
    """Право записи в папку (без учёта диска)."""
    if lib.owner_id == user.id or (user.is_admin and lib.owner_id is None):
        return True
    row = db.get(LibraryAccess, (user.id, lib.id))
    return bool(row and row.can_write)


def can_write(db: Session, user: User, lib: Library) -> bool:
    return lib.enabled and has_write_right(db, user, lib) and fs_writable(lib.path)


def can_edit_track(db: Session, user: User, lib: Library, path: str) -> bool:
    """Редактировать теги и удалять: право записи на папку или это свой загруженный файл."""
    if not fs_writable(lib.path):
        return False
    if has_write_right(db, user, lib):
        return True
    from .scanner import path_hash

    up = db.scalar(select(Upload).where(Upload.library_id == lib.id, Upload.path_hash == path_hash(path)))
    return bool(up and up.user_id == user.id)


def grant_default_access(db: Session, user: User) -> None:
    """Новому пользователю — папки, отмеченные «открыта для новых пользователей»."""
    for lib in db.scalars(select(Library).where(Library.default_access.is_(True), Library.owner_id.is_(None))):
        db.add(LibraryAccess(user_id=user.id, library_id=lib.id))


def set_user_access(db: Session, user_id: int, access: list[tuple[int, bool]]) -> None:
    """Полный список доступа пользователя: [(library_id, can_write), ...]."""
    current = {row.library_id: row for row in db.scalars(select(LibraryAccess).where(LibraryAccess.user_id == user_id))}
    wanted = dict(access)
    for lid, row in current.items():
        if lid not in wanted:
            db.delete(row)
        else:
            row.can_write = bool(wanted[lid])
    new_ids = [lid for lid in wanted if lid not in current]
    if new_ids:
        for lid in db.scalars(select(Library.id).where(Library.id.in_(new_ids))):
            db.add(LibraryAccess(user_id=user_id, library_id=lid, can_write=bool(wanted[lid])))


def _slug(name: str) -> str:
    s = re.sub(r"[^\w.-]+", "_", name, flags=re.UNICODE).strip("._")
    return s or "user"


def personal_library(db: Session, user: User, create: bool = False) -> Library | None:
    lib = db.scalar(select(Library).where(Library.owner_id == user.id))
    if lib or not create:
        return lib
    path = (UPLOAD_ROOT / _slug(user.username)).resolve()
    path.mkdir(parents=True, exist_ok=True)
    lib = Library(
        name=f"Моя музыка · {user.display_name or user.username}",
        path=path.as_posix(),
        owner_id=user.id,
        default_access=False,
    )
    db.add(lib)
    db.flush()
    return lib


def upload_targets(db: Session, user: User) -> list[Library]:
    """Куда пользователь может загружать с учётом режима, прав и диска."""
    mode = "libraries" if user.is_admin else (user.upload_mode or "none")
    if mode == "none":
        return []
    targets: list[Library] = []
    own = personal_library(db, user, create=mode in ("own", "libraries") and upload_root_ok())
    if own and own.enabled and fs_writable(own.path):
        targets.append(own)
    if mode == "libraries":
        query = select(Library).where(Library.enabled.is_(True), Library.owner_id.is_(None))
        if not user.is_admin:
            query = query.join(
                LibraryAccess, and_(LibraryAccess.library_id == Library.id, LibraryAccess.user_id == user.id)
            ).where(LibraryAccess.can_write.is_(True))
        for lib in db.scalars(query.order_by(Library.name)):
            if fs_writable(lib.path):
                targets.append(lib)
    return targets


def upload_root_ok() -> bool:  # noqa: N802
    try:
        UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    except OSError:
        return False
    return fs_writable(str(UPLOAD_ROOT))


def upload_usage(db: Session, user_id: int) -> tuple[int, int]:
    from sqlalchemy import func

    size = db.scalar(select(func.coalesce(func.sum(Upload.size), 0)).where(Upload.user_id == user_id)) or 0
    # В лимит количества идут только аудиофайлы — обложки не считаем
    images = or_(*(func.lower(Upload.path).like(f"%{ext}") for ext in (".jpg", ".jpeg", ".png", ".webp")))
    files = db.scalar(select(func.count(Upload.id)).where(Upload.user_id == user_id, ~images)) or 0
    return int(size), int(files)


