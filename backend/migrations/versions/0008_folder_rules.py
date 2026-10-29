"""Исключение подпапок из медиатеки.

Revision ID: 0008
Revises: 0007
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

LongText = sa.Text().with_variant(mysql.MEDIUMTEXT(), "mysql", "mariadb")

revision = '0008'
down_revision = '0007'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('libraries', sa.Column('folder_rules', LongText, nullable=True))


def downgrade() -> None:
    op.drop_column('libraries', 'folder_rules')
