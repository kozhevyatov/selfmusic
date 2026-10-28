"""Подборки: результаты анализа звука, подборки пользователей на день, «не подходит».
Плюс аватарки пользователей (users.avatar_version).

Revision ID: 0004
Revises: 0003
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

MYSQL_OPTS = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}

revision = '0004'
down_revision = '0003'
branch_labels = None
depends_on = None

Double = sa.Float(precision=53).with_variant(mysql.DOUBLE(), "mysql", "mariadb")
LongText = sa.Text().with_variant(mysql.MEDIUMTEXT(), "mysql", "mariadb")


def upgrade() -> None:
    op.add_column('users', sa.Column('avatar_version', sa.Integer(), nullable=False, server_default='0'))
    op.create_table('track_features',
    sa.Column('track_id', sa.Integer(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('mtime', Double, nullable=False),
    sa.Column('analyzed_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('error', sa.String(length=255), nullable=True),
    sa.Column('bpm', sa.Float(), nullable=False),
    sa.Column('loudness', sa.Float(), nullable=False),
    sa.Column('dynamics', sa.Float(), nullable=False),
    sa.Column('centroid', sa.Float(), nullable=False),
    sa.Column('onset_rate', sa.Float(), nullable=False),
    sa.Column('pulse', sa.Float(), nullable=False),
    sa.Column('mode', sa.Float(), nullable=False),
    sa.Column('musical_key', sa.String(length=4), nullable=False),
    sa.Column('energy', sa.Float(), nullable=False),
    sa.Column('valence', sa.Float(), nullable=False),
    sa.ForeignKeyConstraint(['track_id'], ['tracks.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('track_id'),
    **MYSQL_OPTS
    )
    op.create_table('user_mixes',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('day', sa.String(length=10), nullable=False),
    sa.Column('seed', sa.Integer(), nullable=False),
    sa.Column('track_ids', LongText, nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'key'),
    **MYSQL_OPTS
    )
    op.create_table('mix_feedback',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('key', sa.String(length=32), nullable=False),
    sa.Column('track_id', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['track_id'], ['tracks.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'key', 'track_id'),
    **MYSQL_OPTS
    )


def downgrade() -> None:
    op.drop_column('users', 'avatar_version')
    op.drop_table('mix_feedback')
    op.drop_table('user_mixes')
    op.drop_table('track_features')
