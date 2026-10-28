"""MariaDB: точный mtime (DOUBLE), длинные тексты (MEDIUMTEXT), бинарное сравнение имён исполнителей.

В SQLite эти типы и так подходят — миграция там ничего не делает.

Revision ID: 0003
Revises: 0002
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

revision = '0003'
down_revision = '0002'
branch_labels = None
depends_on = None


def _is_mysql() -> bool:
    return op.get_bind().dialect.name in ("mysql", "mariadb")


def upgrade() -> None:
    if not _is_mysql():
        return
    op.alter_column('tracks', 'mtime', type_=mysql.DOUBLE(), existing_nullable=False)
    op.alter_column('tracks', 'duration', type_=mysql.DOUBLE(), existing_nullable=False)
    op.alter_column('tracks', 'lyrics', type_=mysql.MEDIUMTEXT(), existing_nullable=True)
    op.alter_column('play_queues', 'track_ids', type_=mysql.MEDIUMTEXT(), existing_nullable=False)
    op.alter_column('shares', 'track_ids', type_=mysql.MEDIUMTEXT(), existing_nullable=False)
    # «Алёна» и «Алена» — разные исполнители. Конфликтов при смене collation не будет:
    # бинарное сравнение строже, а при *_ci такие имена и так хранились одной записью.
    op.alter_column(
        'artists', 'name_key',
        type_=mysql.VARCHAR(255, charset="utf8mb4", collation="utf8mb4_bin"),
        existing_nullable=False,
    )


def downgrade() -> None:
    if not _is_mysql():
        return
    op.alter_column('artists', 'name_key', type_=sa.String(255), existing_nullable=False)
    op.alter_column('shares', 'track_ids', type_=sa.Text(), existing_nullable=False)
    op.alter_column('play_queues', 'track_ids', type_=sa.Text(), existing_nullable=False)
    op.alter_column('tracks', 'lyrics', type_=sa.Text(), existing_nullable=True)
    op.alter_column('tracks', 'duration', type_=sa.Float(), existing_nullable=False)
    op.alter_column('tracks', 'mtime', type_=sa.Float(), existing_nullable=False)
