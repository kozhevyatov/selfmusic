from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects import mysql
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .db import Base


# MariaDB: FLOAT без точности — 4 байта (mtime ≈1.7e9 теряет ~2 минуты), TEXT — до 64 КБ,
# а *_ci-сравнение склеивает «Алёна» и «Алена». Для этих полей берём типы точнее.
# asdecimal=False: иначе MariaDB вернёт Decimal, и арифметика с float упадёт
Double = Float(precision=53).with_variant(mysql.DOUBLE(asdecimal=False), "mysql", "mariadb")
LongText = Text().with_variant(mysql.MEDIUMTEXT(), "mysql", "mariadb")
BinKey = String(255).with_variant(mysql.VARCHAR(255, charset="utf8mb4", collation="utf8mb4_bin"), "mysql", "mariadb")


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------- пользователи и настройки ----------------


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    display_name: Mapped[str] = mapped_column(String(128), default="")
    password_hash: Mapped[str] = mapped_column(String(255))
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    # Увеличивается при смене пароля/выходе со всех устройств — инвалидирует refresh-токены.
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    # Пароль для Subsonic-приложений (зашифрован, т.к. протокол требует md5(пароль+соль)).
    subsonic_password: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Качество потока в вебе: original | 320 | 192 | 128
    stream_quality: Mapped[str] = mapped_column(String(16), default="original")
    # Загрузка музыки: none — нельзя; own — только в личную папку; libraries — в общие папки с правом записи
    upload_mode: Mapped[str] = mapped_column(String(16), default="none")
    upload_quota_mb: Mapped[int] = mapped_column(Integer, default=0)  # 0 — без лимита
    upload_max_files: Mapped[int] = mapped_column(Integer, default=0)  # 0 — без лимита
    # Может создавать публичные ссылки (администратор — всегда)
    can_share: Mapped[bool] = mapped_column(Boolean, default=False)
    # 0 — нет аватарки; иначе номер версии (для сброса кэша в браузере)
    avatar_version: Mapped[int] = mapped_column(Integer, default=0)

    @property
    def avatar(self) -> str | None:
        return f"/api/avatar/{self.id}?v={self.avatar_version}" if self.avatar_version else None
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class AppSetting(Base):
    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[str] = mapped_column(Text, default="")


# ---------------- медиатека ----------------


class Library(Base):
    """Папка с музыкой. Их может быть несколько, доступ выдаётся по каждой отдельно."""

    __tablename__ = "libraries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    path: Mapped[str] = mapped_column(String(1024))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Открывать ли папку новым пользователям автоматически
    default_access: Mapped[bool] = mapped_column(Boolean, default=True)
    # Личная папка пользователя (для загрузок). У общих папок — NULL.
    owner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), nullable=True, index=True)
    track_count: Mapped[int] = mapped_column(Integer, default=0)
    album_count: Mapped[int] = mapped_column(Integer, default=0)
    total_size: Mapped[int] = mapped_column(BigInteger, default=0)
    total_duration: Mapped[int] = mapped_column(Integer, default=0)
    last_scan_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_scan_error: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class LibraryAccess(Base):
    __tablename__ = "library_access"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    library_id: Mapped[int] = mapped_column(ForeignKey("libraries.id", ondelete="CASCADE"), primary_key=True)
    # Право записи (загрузка в эту папку). Чтение — само наличие строки.
    can_write: Mapped[bool] = mapped_column(Boolean, default=False)


class Upload(Base):
    """Журнал загрузок: кто какой файл загрузил. Нужен для лимитов и удаления своих треков."""

    __tablename__ = "uploads"
    __table_args__ = (UniqueConstraint("library_id", "path_hash", name="uq_upload_path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    library_id: Mapped[int] = mapped_column(ForeignKey("libraries.id", ondelete="CASCADE"), index=True)
    path: Mapped[str] = mapped_column(Text)
    path_hash: Mapped[str] = mapped_column(String(40))
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Artist(Base):
    __tablename__ = "artists"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(512))
    sort_name: Mapped[str] = mapped_column(String(512), default="")
    # Нормализованное имя (нижний регистр, без лишних пробелов) — для склейки дублей
    name_key: Mapped[str] = mapped_column(BinKey, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Album(Base):
    __tablename__ = "albums"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    library_id: Mapped[int] = mapped_column(ForeignKey("libraries.id", ondelete="CASCADE"), index=True)
    artist_id: Mapped[int | None] = mapped_column(ForeignKey("artists.id", ondelete="SET NULL"), index=True, nullable=True)
    # Альбом = папка + название из тегов: sha1(library|folder|album)
    album_key: Mapped[str] = mapped_column(String(40), unique=True)
    name: Mapped[str] = mapped_column(String(512))
    sort_name: Mapped[str] = mapped_column(String(512), default="")
    artist_name: Mapped[str] = mapped_column(String(512), default="")
    folder: Mapped[str] = mapped_column(Text, default="")
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    genre: Mapped[str] = mapped_column(String(128), default="")
    # Обложка: "file:<путь от корня папки>" или "embed:<id трека>"
    cover: Mapped[str | None] = mapped_column(Text, nullable=True)
    track_count: Mapped[int] = mapped_column(Integer, default=0)
    disc_count: Mapped[int] = mapped_column(Integer, default=1)
    duration: Mapped[int] = mapped_column(Integer, default=0)
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    # Формат, общий для альбома, например «FLAC · 24/96»
    quality: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    artist: Mapped[Artist | None] = relationship(lazy="joined")


class Track(Base):
    __tablename__ = "tracks"
    __table_args__ = (UniqueConstraint("library_id", "path_hash", name="uq_track_path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    library_id: Mapped[int] = mapped_column(ForeignKey("libraries.id", ondelete="CASCADE"), index=True)
    album_id: Mapped[int] = mapped_column(ForeignKey("albums.id", ondelete="CASCADE"), index=True)
    artist_id: Mapped[int | None] = mapped_column(ForeignKey("artists.id", ondelete="SET NULL"), index=True, nullable=True)
    # Путь от корня папки библиотеки (через /)
    path: Mapped[str] = mapped_column(Text)
    path_hash: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(512))
    artist_name: Mapped[str] = mapped_column(String(512), default="")
    album_artist_name: Mapped[str] = mapped_column(String(512), default="")
    track_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    disc_no: Mapped[int | None] = mapped_column(Integer, nullable=True)
    year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    genre: Mapped[str] = mapped_column(String(128), default="", index=True)
    duration: Mapped[float] = mapped_column(Double, default=0)
    bitrate: Mapped[int] = mapped_column(Integer, default=0)  # кбит/с
    sample_rate: Mapped[int] = mapped_column(Integer, default=0)
    bit_depth: Mapped[int] = mapped_column(Integer, default=0)
    channels: Mapped[int] = mapped_column(Integer, default=2)
    suffix: Mapped[str] = mapped_column(String(16), default="")
    codec: Mapped[str] = mapped_column(String(32), default="")
    size: Mapped[int] = mapped_column(BigInteger, default=0)
    mtime: Mapped[float] = mapped_column(Double, default=0)
    has_cover: Mapped[bool] = mapped_column(Boolean, default=False)
    lyrics: Mapped[str | None] = mapped_column(LongText, nullable=True)
    # Громкость: ReplayGain из тегов и оценка по анализу звука (дБ, к уровню −18 LUFS)
    replaygain: Mapped[float | None] = mapped_column(Float, nullable=True)
    replaygain_album: Mapped[float | None] = mapped_column(Float, nullable=True)
    auto_gain: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    album: Mapped[Album] = relationship(lazy="joined")


# ---------------- пользовательские данные ----------------


class Playlist(Base):
    __tablename__ = "playlists"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    comment: Mapped[str] = mapped_column(Text, default="")
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    owner: Mapped[User] = relationship(lazy="joined")


class PlaylistEntry(Base):
    __tablename__ = "playlist_entries"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    playlist_id: Mapped[int] = mapped_column(ForeignKey("playlists.id", ondelete="CASCADE"), index=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"), index=True)
    position: Mapped[int] = mapped_column(Integer, default=0)


class Star(Base):
    """Избранное: kind = track | album | artist."""

    __tablename__ = "stars"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), primary_key=True)
    item_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Rating(Base):
    __tablename__ = "ratings"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    kind: Mapped[str] = mapped_column(String(8), primary_key=True)
    item_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    rating: Mapped[int] = mapped_column(Integer, default=0)


class Play(Base):
    """История прослушиваний (скробблы)."""

    __tablename__ = "plays"
    __table_args__ = (Index("ix_plays_user_time", "user_id", "played_at"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"), index=True)
    album_id: Mapped[int | None] = mapped_column(Integer, nullable=True, index=True)
    played_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class PlayQueue(Base):
    """Сохранённая очередь (Subsonic savePlayQueue) — продолжить на другом устройстве."""

    __tablename__ = "play_queues"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    track_ids: Mapped[str] = mapped_column(LongText, default="[]")
    current_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    position_ms: Mapped[int] = mapped_column(BigInteger, default=0)
    changed_by: Mapped[str] = mapped_column(String(128), default="")
    changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class Share(Base):
    """Публичная ссылка на музыку: папка, альбом, исполнитель, плейлист или выбранные треки."""

    __tablename__ = "shares"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # folder | album | artist | playlist | tracks
    kind: Mapped[str] = mapped_column(String(16))
    library_id: Mapped[int | None] = mapped_column(ForeignKey("libraries.id", ondelete="CASCADE"), nullable=True)
    folder: Mapped[str] = mapped_column(Text, default="")  # для kind=folder: путь от корня папки ("" — вся папка)
    item_id: Mapped[int | None] = mapped_column(Integer, nullable=True)  # альбом / исполнитель / плейлист
    track_ids: Mapped[str] = mapped_column(LongText, default="[]")  # для kind=tracks
    title: Mapped[str] = mapped_column(String(255), default="")
    description: Mapped[str] = mapped_column(Text, default="")
    password_hash: Mapped[str | None] = mapped_column(String(255), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    allow_download: Mapped[bool] = mapped_column(Boolean, default=False)
    max_views: Mapped[int | None] = mapped_column(Integer, nullable=True)
    views: Mapped[int] = mapped_column(Integer, default=0)
    plays: Mapped[int] = mapped_column(Integer, default=0)
    downloads: Mapped[int] = mapped_column(Integer, default=0)
    last_opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Меняется при смене пароля — старые «разблокировки» перестают действовать
    secret_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    owner: Mapped[User] = relationship(lazy="joined")


# ---------------- подборки ----------------


class TrackFeature(Base):
    """Результат анализа звука трека (для подборок по времени суток и настроению)."""

    __tablename__ = "track_features"

    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True)
    version: Mapped[int] = mapped_column(Integer, default=0)
    mtime: Mapped[float] = mapped_column(Double, default=0)  # mtime файла на момент анализа
    analyzed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    error: Mapped[str | None] = mapped_column(String(255), nullable=True)
    bpm: Mapped[float] = mapped_column(Float, default=0)
    loudness: Mapped[float] = mapped_column(Float, default=0)
    dynamics: Mapped[float] = mapped_column(Float, default=0)
    centroid: Mapped[float] = mapped_column(Float, default=0)
    onset_rate: Mapped[float] = mapped_column(Float, default=0)
    pulse: Mapped[float] = mapped_column(Float, default=0)
    mode: Mapped[float] = mapped_column(Float, default=0)
    musical_key: Mapped[str] = mapped_column(String(4), default="")
    energy: Mapped[float] = mapped_column(Float, default=0.5)
    valence: Mapped[float] = mapped_column(Float, default=0.5)


class UserMix(Base):
    """Подборка пользователя на конкретный день (чтобы в течение дня она не «прыгала»)."""

    __tablename__ = "user_mixes"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    day: Mapped[str] = mapped_column(String(10))  # YYYY-MM-DD по времени сервера
    seed: Mapped[int] = mapped_column(Integer, default=0)
    track_ids: Mapped[str] = mapped_column(LongText, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class MixFeedback(Base):
    """«Не подходит для этой подборки» — трек больше не предлагается в ней."""

    __tablename__ = "mix_feedback"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(String(32), primary_key=True)
    track_id: Mapped[int] = mapped_column(ForeignKey("tracks.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
