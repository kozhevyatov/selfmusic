"""Синхронизация воспроизведения между устройствами.

Revision ID: 0009
Revises: 0008
"""
from alembic import op
import sqlalchemy as sa

revision = '0009'
down_revision = '0008'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('play_queues', sa.Column('device_id', sa.String(64), nullable=False, server_default=''))
    op.add_column('play_queues', sa.Column('playing', sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column('play_queues', 'playing')
    op.drop_column('play_queues', 'device_id')
