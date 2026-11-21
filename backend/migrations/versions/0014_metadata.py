"""Сведения из интернета: MusicBrainz, Cover Art Archive, Википедия, AcoustID.

Revision ID: 0014
Revises: 0013
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = '0014'
down_revision = '0013'
branch_labels = None
depends_on = None

MYSQL_OPTS = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}
LongText = sa.Text().with_variant(mysql.MEDIUMTEXT(), "mysql", "mariadb")


def upgrade() -> None:
    op.create_table(
        'album_meta',
        sa.Column('album_id', sa.Integer(), sa.ForeignKey('albums.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('status', sa.String(16), nullable=False, server_default='notfound'),
        sa.Column('source', sa.String(16), nullable=False, server_default=''),
        sa.Column('release_mbid', sa.String(36), nullable=True),
        sa.Column('release_group_mbid', sa.String(36), nullable=True),
        sa.Column('artist_mbid', sa.String(36), nullable=True),
        sa.Column('title', sa.String(512), nullable=False, server_default=''),
        sa.Column('artist', sa.String(512), nullable=False, server_default=''),
        sa.Column('year', sa.Integer(), nullable=True),
        sa.Column('genre', sa.String(128), nullable=False, server_default=''),
        sa.Column('cover_file', sa.String(255), nullable=True),
        sa.Column('error', sa.String(255), nullable=True),
        sa.Column('checked_at', sa.DateTime(timezone=True), nullable=True),
        **MYSQL_OPTS,
    )
    op.create_index('ix_album_meta_status', 'album_meta', ['status'])
    op.create_table(
        'artist_meta',
        sa.Column('artist_id', sa.Integer(), sa.ForeignKey('artists.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('status', sa.String(16), nullable=False, server_default='notfound'),
        sa.Column('source', sa.String(16), nullable=False, server_default=''),
        sa.Column('mbid', sa.String(36), nullable=True),
        sa.Column('mb_name', sa.String(512), nullable=False, server_default=''),
        sa.Column('disambiguation', sa.String(512), nullable=False, server_default=''),
        sa.Column('country', sa.String(8), nullable=False, server_default=''),
        sa.Column('life_span', sa.String(64), nullable=False, server_default=''),
        sa.Column('genres', sa.String(512), nullable=False, server_default=''),
        sa.Column('bio', LongText, nullable=True),
        sa.Column('bio_lang', sa.String(8), nullable=False, server_default=''),
        sa.Column('bio_url', sa.String(1024), nullable=False, server_default=''),
        sa.Column('image_file', sa.String(255), nullable=True),
        sa.Column('image_source', sa.String(1024), nullable=False, server_default=''),
        sa.Column('error', sa.String(255), nullable=True),
        sa.Column('checked_at', sa.DateTime(timezone=True), nullable=True),
        **MYSQL_OPTS,
    )
    op.create_index('ix_artist_meta_status', 'artist_meta', ['status'])
    op.create_table(
        'track_match',
        sa.Column('track_id', sa.Integer(), sa.ForeignKey('tracks.id', ondelete='CASCADE'), primary_key=True),
        sa.Column('status', sa.String(16), nullable=False, server_default='notfound'),
        sa.Column('recording_mbid', sa.String(36), nullable=True),
        sa.Column('title', sa.String(512), nullable=False, server_default=''),
        sa.Column('artist', sa.String(512), nullable=False, server_default=''),
        sa.Column('score', sa.Float(), nullable=False, server_default='0'),
        sa.Column('error', sa.String(255), nullable=True),
        sa.Column('checked_at', sa.DateTime(timezone=True), nullable=True),
        **MYSQL_OPTS,
    )
    op.create_index('ix_track_match_status', 'track_match', ['status'])


def downgrade() -> None:
    op.drop_table('track_match')
    op.drop_table('artist_meta')
    op.drop_table('album_meta')
