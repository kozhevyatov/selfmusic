"""Управление: настройки сервиса, пользователи и доступ к папкам, папки с музыкой, сканирование."""
from __future__ import annotations

import os
from pathlib import Path

from pydantic import BaseModel
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..access import fs_writable, grant_default_access, set_user_access
from ..app_settings import admin_settings, public_settings, set_setting
from ..config import MEDIA_ROOT
from ..db import get_db
from ..models import Library, LibraryAccess, User
from ..scanner import AUDIO_EXTENSIONS, cleanup_orphans, scanner
from ..schemas import (
    AdminSettings,
    LibraryCreate,
    AccessList,
    LibraryUpdate,
    PasswordReset,
    PublicSettings,
    ScanRequest,
    SettingsUpdate,
    UserAdminCreate,
    UserAdminUpdate,
    UserOut,
)
from .. import duplicates, folders
from ..books import natural_key
from ..models import Track
from ..scanner import SKIP_DIRS
from ..security import hash_password, require_admin
from .profile import remove_avatar, save_avatar

router = APIRouter(prefix="/api", tags=["admin"])


# ---------------- настройки ----------------


@router.get("/settings", response_model=PublicSettings)
def get_public_settings(db: Session = Depends(get_db)) -> dict:
    """Публичные настройки: название сервиса, открыта ли регистрация."""
    return public_settings(db)


@router.get("/admin/settings", response_model=AdminSettings)
def get_admin_settings(db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    return admin_settings(db)


@router.patch("/admin/settings", response_model=AdminSettings)
def update_settings(data: SettingsUpdate, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    if data.site_name is not None:
        set_setting(db, "site_name", data.site_name.strip() or "SelfMusic")
    if data.registration_mode is not None:
        set_setting(db, "registration_mode", data.registration_mode)
    if data.scan_interval is not None:
        set_setting(db, "scan_interval", str(data.scan_interval))
    if data.public_url is not None:
        set_setting(db, "public_url", data.public_url.strip().rstrip("/"))
    db.commit()
    return admin_settings(db)


# ---------------- пользователи ----------------


def _user_out(db: Session, user: User) -> dict:
    from ..access import upload_usage

    data = UserOut.model_validate(user).model_dump()
    data["access"] = [
        {"library_id": row.library_id, "can_write": row.can_write}
        for row in db.scalars(select(LibraryAccess).where(LibraryAccess.user_id == user.id))
    ]
    used_bytes, used_files = upload_usage(db, user.id)
    data["upload_used"] = {"bytes": used_bytes, "files": used_files}
    personal = db.scalar(select(Library.id).where(Library.owner_id == user.id, Library.kind == "music"))
    data["personal_library_id"] = personal
    return data


@router.get("/admin/users")
def list_users(db: Session = Depends(get_db), _: User = Depends(require_admin)) -> list[dict]:
    return [_user_out(db, u) for u in db.scalars(select(User).order_by(User.id))]


@router.post("/admin/users")
def create_user(data: UserAdminCreate, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    """Админ добавляет пользователя сам — работает и при закрытой регистрации."""
    email = data.email.lower()
    exists = db.scalar(
        select(func.count()).select_from(User).where(or_(User.username == data.username, User.email == email))
    )
    if exists:
        raise HTTPException(409, "Пользователь с таким логином или email уже есть")
    user = User(
        username=data.username,
        email=email,
        display_name=data.display_name or data.username,
        password_hash=hash_password(data.password),
        is_admin=data.is_admin,
        upload_mode=data.upload_mode,
        upload_quota_mb=data.upload_quota_mb,
        upload_max_files=data.upload_max_files,
        can_share=data.can_share,
    )
    db.add(user)
    db.flush()
    grant_default_access(db, user)
    db.commit()
    db.refresh(user)
    return _user_out(db, user)


@router.patch("/admin/users/{user_id}")
def update_user(
    user_id: int, data: UserAdminUpdate, db: Session = Depends(get_db), admin: User = Depends(require_admin)
) -> dict:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    if user.id == admin.id and (data.is_admin is False or data.is_active is False):
        raise HTTPException(400, "Нельзя снять права или отключить самого себя")
    if data.is_admin is not None:
        user.is_admin = data.is_admin
    if data.is_active is not None:
        user.is_active = data.is_active
        if not data.is_active:
            user.token_version += 1
    if data.username is not None and data.username != user.username:
        if db.scalar(select(func.count()).select_from(User).where(User.username == data.username, User.id != user.id)):
            raise HTTPException(409, "Этот логин уже занят")
        user.username = data.username
    if data.email is not None:
        email = data.email.strip().lower()
        if email != user.email:
            if db.scalar(select(func.count()).select_from(User).where(User.email == email, User.id != user.id)):
                raise HTTPException(409, "Этот email уже занят")
            user.email = email
    if data.display_name is not None:
        user.display_name = " ".join(data.display_name.split()) or user.username
    if data.upload_mode is not None:
        user.upload_mode = data.upload_mode
    if data.upload_quota_mb is not None:
        user.upload_quota_mb = data.upload_quota_mb
    if data.upload_max_files is not None:
        user.upload_max_files = data.upload_max_files
    if data.can_share is not None:
        user.can_share = data.can_share
    db.commit()
    db.refresh(user)
    return _user_out(db, user)


@router.post("/admin/users/{user_id}/avatar")
def admin_upload_avatar(user_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    return _user_out(db, save_avatar(db, user, file))


@router.delete("/admin/users/{user_id}/avatar")
def admin_delete_avatar(user_id: int, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    return _user_out(db, remove_avatar(db, user))


@router.put("/admin/users/{user_id}/access")
def set_access(user_id: int, data: AccessList, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    """Доступ к папкам: наличие строки — чтение, can_write — ещё и запись (загрузка, теги)."""
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    set_user_access(db, user.id, [(a.library_id, a.can_write) for a in data.access])
    db.commit()
    return _user_out(db, user)


@router.post("/admin/users/{user_id}/password")
def reset_password(
    user_id: int, data: PasswordReset, db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> dict:
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    user.password_hash = hash_password(data.password)
    user.token_version += 1  # выкидывает со всех устройств
    db.commit()
    return {"ok": True}


@router.delete("/admin/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), admin: User = Depends(require_admin)) -> dict:
    if user_id == admin.id:
        raise HTTPException(400, "Нельзя удалить самого себя")
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Пользователь не найден")
    db.delete(user)
    db.commit()
    return {"ok": True}


# ---------------- папки с музыкой ----------------


def _library_out(db: Session, lib: Library) -> dict:
    users = db.scalar(select(func.count()).select_from(LibraryAccess).where(LibraryAccess.library_id == lib.id))
    owner = db.get(User, lib.owner_id) if lib.owner_id else None
    return {
        "id": lib.id,
        "owner": {"id": owner.id, "name": owner.display_name or owner.username} if owner else None,
        "writable": fs_writable(lib.path),
        "name": lib.name,
        "path": lib.path,
        "enabled": lib.enabled,
        "default_access": lib.default_access,
        "kind": lib.kind,
        "track_count": lib.track_count,
        "album_count": lib.album_count,
        "total_size": lib.total_size,
        "total_duration": lib.total_duration,
        "last_scan_at": lib.last_scan_at,
        "last_scan_error": lib.last_scan_error,
        "exists": os.path.isdir(lib.path),
        "user_count": users or 0,
        "excluded_count": sum(1 for v in folders.parse(lib.folder_rules).values() if not v),
    }


def _check_path(db: Session, raw: str, exclude_id: int | None = None) -> str:
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = MEDIA_ROOT / path
    path = path.resolve()
    if not path.is_dir():
        raise HTTPException(400, f"Папка не найдена внутри контейнера: {path}. Проверьте volumes в docker-compose.")
    for other in db.scalars(select(Library).where(Library.owner_id.is_(None))):
        if other.id == exclude_id:
            continue
        o = Path(other.path).resolve()
        if path == o or o in path.parents or path in o.parents:
            raise HTTPException(409, f"Пересекается с папкой «{other.name}» ({other.path})")
    return path.as_posix()


@router.get("/admin/libraries")
def list_libraries(db: Session = Depends(get_db), _: User = Depends(require_admin)) -> list[dict]:
    return [_library_out(db, lib) for lib in db.scalars(select(Library).order_by(Library.id))]


@router.post("/admin/libraries")
def create_library(data: LibraryCreate, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    lib = Library(name=data.name.strip(), path=_check_path(db, data.path), default_access=data.default_access, kind=data.kind)
    db.add(lib)
    db.flush()
    if data.default_access:
        # Открыта по умолчанию — сразу видна всем существующим пользователям (только чтение)
        for uid in db.scalars(select(User.id)):
            db.add(LibraryAccess(user_id=uid, library_id=lib.id))
    db.commit()
    scanner.start(library_id=lib.id)
    return _library_out(db, lib)


@router.patch("/admin/libraries/{library_id}")
def update_library(
    library_id: int, data: LibraryUpdate, db: Session = Depends(get_db), _: User = Depends(require_admin)
) -> dict:
    lib = db.get(Library, library_id)
    if not lib:
        raise HTTPException(404, "Папка не найдена")
    rescan = False
    if data.name is not None:
        lib.name = data.name.strip()
    if data.path is not None:
        new_path = _check_path(db, data.path, exclude_id=lib.id)
        rescan = new_path != lib.path
        lib.path = new_path
    if data.enabled is not None:
        lib.enabled = data.enabled
    if data.default_access is not None:
        lib.default_access = data.default_access
    if data.kind is not None and data.kind != lib.kind:
        lib.kind = data.kind
        rescan = True  # треки пересобираются в книги (или обратно в альбомы)
    db.commit()
    if rescan:
        scanner.start(library_id=lib.id, full=True)
    return _library_out(db, lib)


def _lib_dir(lib: Library, rel: str) -> tuple[Path, str]:
    # без resolve(): сканер ходит по символическим ссылкам — и здесь подпапка-ссылка должна открываться.
    # Выход наверх невозможен: norm() убирает «..» и ведущий «/».
    root = Path(lib.path)
    rel = folders.norm(rel)
    target = root / rel if rel else root
    if not target.is_dir():
        raise HTTPException(404, "Подпапка не найдена")
    return target, rel


@router.get("/admin/libraries/{library_id}/tree")
def library_tree(library_id: int, path: str = "", db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    """Подпапки одного уровня: включена ли, своё правило, сколько треков в медиатеке."""
    lib = db.get(Library, library_id)
    if not lib:
        raise HTTPException(404, "Папка не найдена")
    target, rel = _lib_dir(lib, path)
    rules = folders.parse(lib.folder_rules)
    # треки этой ветки из базы → счётчики по подпапкам первого уровня
    prefix = f"{rel}/" if rel else ""
    q = select(Track.path).where(Track.library_id == lib.id)
    if prefix:
        esc = prefix.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        q = q.where(Track.path.like(f"{esc}%", escape="\\"))
    counts: dict[str, int] = {}
    here = 0
    for (p,) in db.execute(q):
        rest = p[len(prefix):]
        if "/" in rest:
            head = rest.split("/", 1)[0]
            counts[head] = counts.get(head, 0) + 1
        else:
            here += 1
    dirs = []
    try:
        entries = sorted(
            (e for e in os.scandir(target) if e.is_dir() and not SKIP_DIRS.match(e.name)),
            key=lambda e: natural_key(e.name),
        )
    except OSError as exc:
        raise HTTPException(400, f"Нет доступа к папке: {exc.strerror}")
    for e in entries[:2000]:
        child = f"{prefix}{e.name}"
        try:
            has_children = any(c.is_dir() and not SKIP_DIRS.match(c.name) for c in os.scandir(e.path))
        except OSError:
            has_children = False
        dirs.append(
            {
                "name": e.name,
                "path": child,
                "included": folders.included(rules, child),
                "rule": folders.own_rule(rules, child),
                "tracks": counts.get(e.name, 0),
                "has_children": has_children,
            }
        )
    return {
        "path": rel,
        "included": folders.included(rules, rel),
        "tracks_here": here,
        "dirs": dirs,
        "truncated": len(entries) > 2000,
        "excluded_count": sum(1 for v in rules.values() if not v),
    }


class FolderRuleIn(BaseModel):
    path: str
    include: bool | None = None  # None — снять своё правило (как у родителя)


@router.put("/admin/libraries/{library_id}/folders")
def set_folder_rule(library_id: int, data: FolderRuleIn, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    lib = db.get(Library, library_id, with_for_update=True)  # два быстрых переключения не должны затереть друг друга
    if not lib:
        raise HTTPException(404, "Папка не найдена")
    _, rel = _lib_dir(lib, data.path)
    if not rel:
        raise HTTPException(400, "Корневую папку отключают переключателем «Включена»")
    rules = folders.set_rule(folders.parse(lib.folder_rules), rel, data.include)
    lib.folder_rules = folders.dump(rules)
    db.commit()
    scanner.start(library_id=lib.id)  # быстрый скан: исключённое уберётся, возвращённое добавится
    return {"ok": True, "excluded_count": sum(1 for v in rules.values() if not v)}


@router.delete("/admin/libraries/{library_id}")
def delete_library(library_id: int, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    lib = db.get(Library, library_id)
    if not lib:
        raise HTTPException(404, "Папка не найдена")
    if scanner.status()["running"]:
        raise HTTPException(409, "Идёт сканирование — дождитесь окончания")
    db.delete(lib)
    db.commit()
    cleanup_orphans(db)
    db.commit()
    return {"ok": True}


@router.get("/admin/fs")
def browse(path: str = "", _: User = Depends(require_admin)) -> dict:
    """Обзор папок внутри MEDIA_ROOT — чтобы выбрать папку с музыкой, а не вводить путь руками."""
    root = MEDIA_ROOT.resolve()
    if not root.is_dir():
        return {"root": root.as_posix(), "root_exists": False, "path": "", "parent": None, "dirs": [], "audio_files": 0}
    target = (root / path.lstrip("/")).resolve() if path else root
    if target != root and root not in target.parents:
        raise HTTPException(400, "Путь вне разрешённой папки")
    if not target.is_dir():
        raise HTTPException(404, "Папка не найдена")
    dirs = []
    audio = 0
    try:
        with os.scandir(target) as it:
            for entry in it:
                if entry.name.startswith((".", "@", "#")):  # @eaDir и прочий служебный мусор Synology
                    continue
                if entry.is_dir(follow_symlinks=False):
                    dirs.append(entry.name)
                elif os.path.splitext(entry.name)[1].lower() in AUDIO_EXTENSIONS:
                    audio += 1
    except PermissionError:
        raise HTTPException(403, "Нет доступа к папке")
    rel = target.relative_to(root).as_posix()
    rel = "" if rel == "." else rel
    return {
        "root": root.as_posix(),
        "root_exists": True,
        "path": rel,
        "abs_path": target.as_posix(),
        "parent": None if target == root else ("" if target.parent == root else target.parent.relative_to(root).as_posix()),
        "dirs": sorted(dirs, key=str.lower),
        "audio_files": audio,
    }


# ---------------- сканирование ----------------


@router.get("/admin/scan")
def scan_status(_: User = Depends(require_admin)) -> dict:
    return scanner.status()


@router.post("/admin/scan")
def start_scan(data: ScanRequest, _: User = Depends(require_admin)) -> dict:
    started = scanner.start(library_id=data.library_id, full=data.full)
    return {**scanner.status(), "started": started}


# ---------------- дубликаты ----------------


@router.get("/admin/duplicates")
def get_duplicates(strict: bool = True, db: Session = Depends(get_db), user: User = Depends(require_admin)) -> dict:
    groups = duplicates.find(db, user, strict=strict)
    waste = sum(t["size"] for g in groups for t in g["tracks"] if not t["best"])
    return {"groups": groups, "count": len(groups), "reclaimable": waste}


class IgnoreIn(BaseModel):
    key: str


@router.post("/admin/duplicates/ignore")
def ignore_duplicate(data: IgnoreIn, db: Session = Depends(get_db), _: User = Depends(require_admin)) -> dict:
    duplicates.ignore(db, data.key[:32])
    db.commit()
    return {"ok": True}
