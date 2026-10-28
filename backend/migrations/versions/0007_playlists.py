"""Умные плейлисты (правила) и совместные (соавторы, кто добавил трек).

Revision ID: 0007
Revises: 0006
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

MYSQL_OPTS = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}
LongText = sa.Text().with_variant(mysql.MEDIUMTEXT(), "mysql", "mariadb")

revision = '0007'
down_revision = '0006'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('playlists', sa.Column('rules', LongText, nullable=True))
    op.add_column('playlist_entries', sa.Column('added_by', sa.Integer(), nullable=True))
    op.create_table('playlist_members',
    sa.Column('playlist_id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('added_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['playlist_id'], ['playlists.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('playlist_id', 'user_id'),
    **MYSQL_OPTS
    )
    op.create_index('ix_playlist_members_user_id', 'playlist_members', ['user_id'])


def downgrade() -> None:
    op.drop_table('playlist_members')
    op.drop_column('playlist_entries', 'added_by')
    op.drop_column('playlists', 'rules')
