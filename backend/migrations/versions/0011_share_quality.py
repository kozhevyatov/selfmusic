"""Качество прослушивания по общей ссылке.

Revision ID: 0011
Revises: 0010
"""
from alembic import op
import sqlalchemy as sa

revision = '0011'
down_revision = '0010'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('shares', sa.Column('quality', sa.String(16), nullable=False, server_default='192'))
    # как было раньше: со скачиванием — оригинал, без — MP3 192
    op.execute("UPDATE shares SET quality = 'original' WHERE allow_download = 1")


def downgrade() -> None:
    op.drop_column('shares', 'quality')
