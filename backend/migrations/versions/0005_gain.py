"""Громкость для выравнивания: ReplayGain из тегов и оценка по анализу звука.

Revision ID: 0005
Revises: 0004
"""
from alembic import op
import sqlalchemy as sa

revision = '0005'
down_revision = '0004'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('tracks', sa.Column('replaygain', sa.Float(), nullable=True))
    op.add_column('tracks', sa.Column('replaygain_album', sa.Float(), nullable=True))
    op.add_column('tracks', sa.Column('auto_gain', sa.Float(), nullable=True))


def downgrade() -> None:
    op.drop_column('tracks', 'auto_gain')
    op.drop_column('tracks', 'replaygain_album')
    op.drop_column('tracks', 'replaygain')
