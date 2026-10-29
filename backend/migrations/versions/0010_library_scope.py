"""Выбор «Вся / Общая / Моя музыка» в профиле.

Revision ID: 0010
Revises: 0009
"""
from alembic import op
import sqlalchemy as sa

revision = '0010'
down_revision = '0009'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('users', sa.Column('library_scope', sa.String(16), nullable=False, server_default='all'))


def downgrade() -> None:
    op.drop_column('users', 'library_scope')
