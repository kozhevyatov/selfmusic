"""Синхронизация: счётчик версий и время старта воспроизведения.

Revision ID: 0012
Revises: 0011
"""
from alembic import op
import sqlalchemy as sa

revision = '0012'
down_revision = '0011'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('play_queues', sa.Column('rev', sa.Integer(), nullable=False, server_default='0'))
    op.add_column('play_queues', sa.Column('started_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('play_queues', 'started_at')
    op.drop_column('play_queues', 'rev')
