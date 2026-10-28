from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

USERNAME_PATTERN = r"^[a-zA-Z0-9_.-]{3,64}$"
# Простая проверка: домашние адреса вида admin@home.local тоже допустимы.
EMAIL_PATTERN = r"^[^@\s]+@[^@\s]+$"

Quality = Literal["original", "320", "192", "128"]
UploadMode = Literal["none", "own", "libraries"]


# ---------- setup ----------
class SetupStatus(BaseModel):
    database_configured: bool
    database_from_env: bool
    setup_complete: bool
    setup_token_required: bool


class DatabaseConfig(BaseModel):
    type: Literal["sqlite", "mysql"]
    host: str | None = None
    port: int | None = 3306
    user: str | None = None
    password: str | None = None
    database: str | None = None


class AdminCreate(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    email: str = Field(pattern=EMAIL_PATTERN, max_length=255)
    display_name: str = Field(default="", max_length=128)
    password: str = Field(min_length=8, max_length=128)
    site_name: str = Field(default="SelfMusic", max_length=100)
    registration_mode: Literal["open", "closed"] = "closed"


# ---------- auth ----------
class LoginIn(BaseModel):
    login: str  # username или email
    password: str
    remember: bool = True


class RegisterIn(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    email: str = Field(pattern=EMAIL_PATTERN, max_length=255)
    display_name: str = Field(default="", max_length=128)
    password: str = Field(min_length=8, max_length=128)


class RefreshIn(BaseModel):
    refresh_token: str | None = None


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    username: str
    email: str
    display_name: str
    is_admin: bool
    is_active: bool
    stream_quality: str
    upload_mode: str
    upload_quota_mb: int
    upload_max_files: int
    can_share: bool
    avatar: str | None = None
    created_at: datetime
    last_seen_at: datetime | None = None


class ProfileUpdate(BaseModel):
    display_name: str | None = Field(default=None, max_length=128)
    email: str | None = Field(default=None, pattern=EMAIL_PATTERN, max_length=255)
    stream_quality: Quality | None = None


class PasswordChange(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


class TokenOut(BaseModel):
    access_token: str
    # Для мобильного приложения; в вебе refresh живёт в httpOnly-cookie.
    refresh_token: str
    token_type: str = "bearer"
    user: UserOut


# ---------- settings ----------
class PublicSettings(BaseModel):
    site_name: str
    registration_mode: Literal["open", "closed"]


class AdminSettings(PublicSettings):
    scan_interval: int
    public_url: str


class SettingsUpdate(BaseModel):
    site_name: str | None = Field(default=None, max_length=100)
    registration_mode: Literal["open", "closed"] | None = None
    scan_interval: int | None = Field(default=None, ge=0, le=7 * 24 * 60)
    public_url: str | None = Field(default=None, max_length=255)


# ---------- admin: пользователи ----------
class UserAdminCreate(BaseModel):
    username: str = Field(pattern=USERNAME_PATTERN)
    email: str = Field(pattern=EMAIL_PATTERN, max_length=255)
    display_name: str = Field(default="", max_length=128)
    password: str = Field(min_length=8, max_length=128)
    is_admin: bool = False
    upload_mode: UploadMode = "none"
    upload_quota_mb: int = Field(default=0, ge=0, le=10_000_000)
    upload_max_files: int = Field(default=0, ge=0, le=10_000_000)
    can_share: bool = False


class UserAdminUpdate(BaseModel):
    is_admin: bool | None = None
    is_active: bool | None = None
    username: str | None = Field(default=None, pattern=USERNAME_PATTERN)
    display_name: str | None = Field(default=None, max_length=128)
    email: str | None = Field(default=None, pattern=EMAIL_PATTERN, max_length=255)
    upload_mode: UploadMode | None = None
    upload_quota_mb: int | None = Field(default=None, ge=0, le=10_000_000)
    upload_max_files: int | None = Field(default=None, ge=0, le=10_000_000)
    can_share: bool | None = None


class PasswordReset(BaseModel):
    password: str = Field(min_length=8, max_length=128)


class AccessItem(BaseModel):
    library_id: int
    can_write: bool = False


class AccessList(BaseModel):
    access: list[AccessItem]


# ---------- admin: папки ----------
class LibraryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    path: str = Field(min_length=1, max_length=1024)
    default_access: bool = True


class LibraryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=128)
    path: str | None = Field(default=None, min_length=1, max_length=1024)
    enabled: bool | None = None
    default_access: bool | None = None


class ScanRequest(BaseModel):
    library_id: int | None = None
    full: bool = False


# ---------- плейлисты ----------
class PlaylistCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    comment: str = Field(default="", max_length=2000)
    is_public: bool = False
    track_ids: list[int] = []


class PlaylistUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    comment: str | None = Field(default=None, max_length=2000)
    is_public: bool | None = None


class PlaylistTracks(BaseModel):
    track_ids: list[int]


class PlaylistReorder(BaseModel):
    # Полный новый порядок позиций (entry id)
    entry_ids: list[int]


class PlayIn(BaseModel):
    track_id: int


# ---------- общие ссылки ----------
ShareKind = Literal["folder", "album", "artist", "playlist", "tracks"]


class ShareCreate(BaseModel):
    kind: ShareKind
    library_id: int | None = None
    folder: str = Field(default="", max_length=2000)
    item_id: int | None = None
    track_ids: list[int] = []
    title: str = Field(default="", max_length=255)
    description: str = Field(default="", max_length=2000)
    password: str | None = Field(default=None, max_length=128)
    expires_at: datetime | None = None
    allow_download: bool = False
    max_views: int | None = Field(default=None, ge=1, le=1_000_000)


class ShareUpdate(BaseModel):
    title: str | None = Field(default=None, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    # "" — убрать пароль, None — не менять
    password: str | None = Field(default=None, max_length=128)
    expires_at: datetime | None = None
    clear_expiry: bool = False
    allow_download: bool | None = None
    max_views: int | None = Field(default=None, ge=0, le=1_000_000)  # 0 — без лимита
    enabled: bool | None = None


class ShareUnlock(BaseModel):
    password: str = Field(max_length=128)


class SharePlay(BaseModel):
    track_id: int
