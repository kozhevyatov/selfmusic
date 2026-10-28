"""Начальная схема: пользователи, папки с музыкой и права на них, загрузки, медиатека, плейлисты, избранное, история.

Revision ID: 0001
Revises: 
"""
from alembic import op
import sqlalchemy as sa

# Для MySQL/MariaDB — utf8mb4, иначе кириллица и эмодзи в тегах ломаются
MYSQL_OPTS = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}


revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('app_settings',
    sa.Column('key', sa.String(length=64), nullable=False),
    sa.Column('value', sa.Text(), nullable=False),
    sa.PrimaryKeyConstraint('key'),
    **MYSQL_OPTS,
    )
    op.create_table('artists',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=512), nullable=False),
    sa.Column('sort_name', sa.String(length=512), nullable=False),
    sa.Column('name_key', sa.String(length=255), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name_key'),
    **MYSQL_OPTS,
    )
    op.create_table('users',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('username', sa.String(length=64), nullable=False),
    sa.Column('email', sa.String(length=255), nullable=False),
    sa.Column('display_name', sa.String(length=128), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('is_admin', sa.Boolean(), nullable=False),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('token_version', sa.Integer(), nullable=False),
    sa.Column('subsonic_password', sa.Text(), nullable=True),
    sa.Column('stream_quality', sa.String(length=16), nullable=False),
    sa.Column('upload_mode', sa.String(length=16), nullable=False),
    sa.Column('upload_quota_mb', sa.Integer(), nullable=False),
    sa.Column('upload_max_files', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('last_seen_at', sa.DateTime(timezone=True), nullable=True),
    sa.PrimaryKeyConstraint('id'),
    **MYSQL_OPTS,
    )
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_users_email'), ['email'], unique=True)
        batch_op.create_index(batch_op.f('ix_users_username'), ['username'], unique=True)

    op.create_table('libraries',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=128), nullable=False),
    sa.Column('path', sa.String(length=1024), nullable=False),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('default_access', sa.Boolean(), nullable=False),
    sa.Column('owner_id', sa.Integer(), nullable=True),
    sa.Column('track_count', sa.Integer(), nullable=False),
    sa.Column('album_count', sa.Integer(), nullable=False),
    sa.Column('total_size', sa.BigInteger(), nullable=False),
    sa.Column('total_duration', sa.Integer(), nullable=False),
    sa.Column('last_scan_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('last_scan_error', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    **MYSQL_OPTS,
    )
    with op.batch_alter_table('libraries', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_libraries_owner_id'), ['owner_id'], unique=False)

    op.create_table('play_queues',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('track_ids', sa.Text(), nullable=False),
    sa.Column('current_id', sa.Integer(), nullable=True),
    sa.Column('position_ms', sa.BigInteger(), nullable=False),
    sa.Column('changed_by', sa.String(length=128), nullable=False),
    sa.Column('changed_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id'),
    **MYSQL_OPTS,
    )
    op.create_table('playlists',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('owner_id', sa.Integer(), nullable=False),
    sa.Column('name', sa.String(length=255), nullable=False),
    sa.Column('comment', sa.Text(), nullable=False),
    sa.Column('is_public', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    **MYSQL_OPTS,
    )
    with op.batch_alter_table('playlists', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_playlists_owner_id'), ['owner_id'], unique=False)

    op.create_table('ratings',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=8), nullable=False),
    sa.Column('item_id', sa.Integer(), nullable=False),
    sa.Column('rating', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'kind', 'item_id'),
    **MYSQL_OPTS,
    )
    op.create_table('stars',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=8), nullable=False),
    sa.Column('item_id', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'kind', 'item_id'),
    **MYSQL_OPTS,
    )
    op.create_table('albums',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('library_id', sa.Integer(), nullable=False),
    sa.Column('artist_id', sa.Integer(), nullable=True),
    sa.Column('album_key', sa.String(length=40), nullable=False),
    sa.Column('name', sa.String(length=512), nullable=False),
    sa.Column('sort_name', sa.String(length=512), nullable=False),
    sa.Column('artist_name', sa.String(length=512), nullable=False),
    sa.Column('folder', sa.Text(), nullable=False),
    sa.Column('year', sa.Integer(), nullable=True),
    sa.Column('genre', sa.String(length=128), nullable=False),
    sa.Column('cover', sa.Text(), nullable=True),
    sa.Column('track_count', sa.Integer(), nullable=False),
    sa.Column('disc_count', sa.Integer(), nullable=False),
    sa.Column('duration', sa.Integer(), nullable=False),
    sa.Column('size', sa.BigInteger(), nullable=False),
    sa.Column('quality', sa.String(length=64), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['artist_id'], ['artists.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['library_id'], ['libraries.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('album_key'),
    **MYSQL_OPTS,
    )
    with op.batch_alter_table('albums', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_albums_artist_id'), ['artist_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_albums_created_at'), ['created_at'], unique=False)
        batch_op.create_index(batch_op.f('ix_albums_library_id'), ['library_id'], unique=False)

    op.create_table('library_access',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('library_id', sa.Integer(), nullable=False),
    sa.Column('can_write', sa.Boolean(), nullable=False),
    sa.ForeignKeyConstraint(['library_id'], ['libraries.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'library_id'),
    **MYSQL_OPTS,
    )
    op.create_table('uploads',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('library_id', sa.Integer(), nullable=False),
    sa.Column('path', sa.Text(), nullable=False),
    sa.Column('path_hash', sa.String(length=40), nullable=False),
    sa.Column('size', sa.BigInteger(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['library_id'], ['libraries.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('library_id', 'path_hash', name='uq_upload_path'),
    **MYSQL_OPTS,
    )
    with op.batch_alter_table('uploads', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_uploads_library_id'), ['library_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_uploads_user_id'), ['user_id'], unique=False)

    op.create_table('tracks',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('library_id', sa.Integer(), nullable=False),
    sa.Column('album_id', sa.Integer(), nullable=False),
    sa.Column('artist_id', sa.Integer(), nullable=True),
    sa.Column('path', sa.Text(), nullable=False),
    sa.Column('path_hash', sa.String(length=40), nullable=False),
    sa.Column('title', sa.String(length=512), nullable=False),
    sa.Column('artist_name', sa.String(length=512), nullable=False),
    sa.Column('album_artist_name', sa.String(length=512), nullable=False),
    sa.Column('track_no', sa.Integer(), nullable=True),
    sa.Column('disc_no', sa.Integer(), nullable=True),
    sa.Column('year', sa.Integer(), nullable=True),
    sa.Column('genre', sa.String(length=128), nullable=False),
    sa.Column('duration', sa.Float(), nullable=False),
    sa.Column('bitrate', sa.Integer(), nullable=False),
    sa.Column('sample_rate', sa.Integer(), nullable=False),
    sa.Column('bit_depth', sa.Integer(), nullable=False),
    sa.Column('channels', sa.Integer(), nullable=False),
    sa.Column('suffix', sa.String(length=16), nullable=False),
    sa.Column('codec', sa.String(length=32), nullable=False),
    sa.Column('size', sa.BigInteger(), nullable=False),
    sa.Column('mtime', sa.Float(), nullable=False),
    sa.Column('has_cover', sa.Boolean(), nullable=False),
    sa.Column('lyrics', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['album_id'], ['albums.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['artist_id'], ['artists.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['library_id'], ['libraries.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('library_id', 'path_hash', name='uq_track_path'),
    **MYSQL_OPTS,
    )
    with op.batch_alter_table('tracks', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_tracks_album_id'), ['album_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_tracks_artist_id'), ['artist_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_tracks_genre'), ['genre'], unique=False)
        batch_op.create_index(batch_op.f('ix_tracks_library_id'), ['library_id'], unique=False)

    op.create_table('playlist_entries',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('playlist_id', sa.Integer(), nullable=False),
    sa.Column('track_id', sa.Integer(), nullable=False),
    sa.Column('position', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['playlist_id'], ['playlists.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['track_id'], ['tracks.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    **MYSQL_OPTS,
    )
    with op.batch_alter_table('playlist_entries', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_playlist_entries_playlist_id'), ['playlist_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_playlist_entries_track_id'), ['track_id'], unique=False)

    op.create_table('plays',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('track_id', sa.Integer(), nullable=False),
    sa.Column('album_id', sa.Integer(), nullable=True),
    sa.Column('played_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['track_id'], ['tracks.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    **MYSQL_OPTS,
    )
    with op.batch_alter_table('plays', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_plays_album_id'), ['album_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_plays_track_id'), ['track_id'], unique=False)
        batch_op.create_index('ix_plays_user_time', ['user_id', 'played_at'], unique=False)



def downgrade() -> None:
    with op.batch_alter_table('plays', schema=None) as batch_op:
        batch_op.drop_index('ix_plays_user_time')
        batch_op.drop_index(batch_op.f('ix_plays_track_id'))
        batch_op.drop_index(batch_op.f('ix_plays_album_id'))

    op.drop_table('plays')
    with op.batch_alter_table('playlist_entries', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_playlist_entries_track_id'))
        batch_op.drop_index(batch_op.f('ix_playlist_entries_playlist_id'))

    op.drop_table('playlist_entries')
    with op.batch_alter_table('tracks', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_tracks_library_id'))
        batch_op.drop_index(batch_op.f('ix_tracks_genre'))
        batch_op.drop_index(batch_op.f('ix_tracks_artist_id'))
        batch_op.drop_index(batch_op.f('ix_tracks_album_id'))

    op.drop_table('tracks')
    with op.batch_alter_table('uploads', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_uploads_user_id'))
        batch_op.drop_index(batch_op.f('ix_uploads_library_id'))

    op.drop_table('uploads')
    op.drop_table('library_access')
    with op.batch_alter_table('albums', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_albums_library_id'))
        batch_op.drop_index(batch_op.f('ix_albums_created_at'))
        batch_op.drop_index(batch_op.f('ix_albums_artist_id'))

    op.drop_table('albums')
    op.drop_table('stars')
    op.drop_table('ratings')
    with op.batch_alter_table('playlists', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_playlists_owner_id'))

    op.drop_table('playlists')
    op.drop_table('play_queues')
    with op.batch_alter_table('libraries', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_libraries_owner_id'))

    op.drop_table('libraries')
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_users_username'))
        batch_op.drop_index(batch_op.f('ix_users_email'))

    op.drop_table('users')
    op.drop_table('artists')
    op.drop_table('app_settings')
