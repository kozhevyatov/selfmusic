"""«Тень» папки: треки исключённых подпапок не удаляются, а прячутся.

Revision ID: 0013
Revises: 0012
"""
from alembic import op
import sqlalchemy as sa

revision = '0013'
down_revision = '0012'
branch_labels = None
depends_on = None


def upgrade() -> None:
    if op.get_bind().dialect.name == "sqlite":
        # без пересоздания таблицы: при включённых внешних ключах оно стёрло бы треки каскадом
        op.execute("ALTER TABLE libraries ADD COLUMN hidden_of INTEGER REFERENCES libraries(id) ON DELETE CASCADE")
    else:
        op.add_column('libraries', sa.Column('hidden_of', sa.Integer(), nullable=True))
        op.create_foreign_key('fk_libraries_hidden_of', 'libraries', 'libraries', ['hidden_of'], ['id'], ondelete='CASCADE')
    op.create_index('ix_libraries_hidden_of', 'libraries', ['hidden_of'])


def downgrade() -> None:
    op.drop_index('ix_libraries_hidden_of', 'libraries')
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint('fk_libraries_hidden_of', 'libraries', type_='foreignkey')
    op.drop_column('libraries', 'hidden_of')
