"""Аудиокниги: тип папки, книги, прогресс прослушивания, закладки.

Revision ID: 0006
Revises: 0005
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import mysql

MYSQL_OPTS = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}
LongText = sa.Text().with_variant(mysql.MEDIUMTEXT(), "mysql", "mariadb")

revision = '0006'
down_revision = '0005'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('libraries', sa.Column('kind', sa.String(length=16), nullable=False, server_default='music'))
    op.create_table('books',
    sa.Column('album_id', sa.Integer(), nullable=False),
    sa.Column('author', sa.String(length=512), nullable=False),
    sa.Column('narrator', sa.String(length=512), nullable=False),
    sa.Column('series', sa.String(length=512), nullable=False),
    sa.Column('series_seq', sa.Float(), nullable=True),
    sa.Column('subtitle', sa.String(length=512), nullable=False),
    sa.Column('description', LongText, nullable=False),
    sa.Column('chapters', LongText, nullable=False),
    sa.ForeignKeyConstraint(['album_id'], ['albums.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('album_id'),
    **MYSQL_OPTS
    )
    op.create_index('ix_books_series', 'books', ['series'], mysql_length={'series': 191})
    op.create_table('book_progress',
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('album_id', sa.Integer(), nullable=False),
    sa.Column('track_id', sa.Integer(), nullable=True),
    sa.Column('position', sa.Float(), nullable=False),
    sa.Column('progress', sa.Float(), nullable=False),
    sa.Column('speed', sa.Float(), nullable=False),
    sa.Column('finished', sa.Boolean(), nullable=False),
    sa.Column('started_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['album_id'], ['albums.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'album_id'),
    **MYSQL_OPTS
    )
    op.create_index('ix_book_progress_updated_at', 'book_progress', ['updated_at'])
    op.create_table('bookmarks',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('user_id', sa.Integer(), nullable=False),
    sa.Column('track_id', sa.Integer(), nullable=False),
    sa.Column('position', sa.Float(), nullable=False),
    sa.Column('comment', sa.String(length=1000), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['track_id'], ['tracks.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    **MYSQL_OPTS
    )
    op.create_index('ix_bookmarks_user_id', 'bookmarks', ['user_id'])
    op.create_index('ix_bookmarks_track_id', 'bookmarks', ['track_id'])


def downgrade() -> None:
    op.drop_table('bookmarks')
    op.drop_table('book_progress')
    op.drop_table('books')
    op.drop_column('libraries', 'kind')
