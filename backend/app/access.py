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


def allowed_library_ids(
    db: Session, user: User, only: int | None = None, kind: str = "music", scoped: bool = True
) -> list[int]:
    """Доступные пользователю папки. kind: music — музыка (по умолчанию: альбомы, поиск, подборки…),
    audiobooks — аудиокниги, any — все (поток, обложки, теги, ссылки).
    scoped — учитывать выбор «Вся / Общая / Моя» (user.library_scope); не учитывается для плейлистов,
    избранного, истории, явно открытой папки и всего с kind="any"."""
    access = select(LibraryAccess.library_id).where(LibraryAccess.user_id == user.id)
    cond = or_(Library.owner_id == user.id, Library.id.in_(access))
    if user.is_admin:
        cond = or_(cond, Library.owner_id.is_(None))
    query = select(Library.id, Library.owner_id, Library.track_count).where(Library.enabled.is_(True), cond)
    if kind != "any":
        query = query.where(Library.kind == kind)
    rows = list(db.execute(query))
    ids = [r[0] for r in rows]
    if only is not None:
        return [i for i in ids if i == only]
    scope = getattr(user, "library_scope", "all") or "all"
    if scoped and kind != "any" and scope != "all":
        # пустая личная папка (её создаём заранее для загрузок) не считается — иначе «Моя» показала бы пустоту
        mine = [i for i, owner, count in rows if owner == user.id and count]
        shared = [i for i, owner, _ in rows if owner != user.id]
        # фильтруем, только когда есть из чего выбирать — иначе раздел просто опустел бы
        if mine and shared:
            return mine if scope == "mine" else shared
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


def personal_library(db: Session, user: User, create: bool = False, kind: str = "music") -> Library | None:
    """Личная папка пользователя: media/<логин>/music («Моя музыка») или media/<логин>/books («Мои аудиокниги»)."""
    from .layout import SUBDIR, user_home  # noqa: PLC0415

    lib = db.scalar(select(Library).where(Library.owner_id == user.id, Library.kind == kind, Library.hidden_of.is_(None)))
    if lib or not create:
        return lib
    path = (user_home(db, user) / SUBDIR[kind]).resolve()
    path.mkdir(parents=True, exist_ok=True)
    title = "Мои аудиокниги" if kind == "audiobooks" else "Моя музыка"
    lib = Library(
        name=f"{title} · {user.display_name or user.username}",
        path=path.as_posix(),
        owner_id=user.id,
        default_access=False,
        kind=kind,
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
    can_create = mode in ("own", "libraries") and upload_root_ok()
    for kind in ("music", "audiobooks"):
        own = personal_library(db, user, create=can_create, kind=kind)
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


