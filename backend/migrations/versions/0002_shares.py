"""Общие ссылки (shares) и право пользователя создавать их (users.can_share).

Revision ID: 0002
Revises: 0001
"""
from alembic import op
import sqlalchemy as sa

MYSQL_OPTS = {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"}


revision = '0002'
down_revision = '0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table('shares',
    sa.Column('id', sa.Integer(), nullable=False),
    sa.Column('token', sa.String(length=32), nullable=False),
    sa.Column('owner_id', sa.Integer(), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('library_id', sa.Integer(), nullable=True),
    sa.Column('folder', sa.Text(), nullable=False),
    sa.Column('item_id', sa.Integer(), nullable=True),
    sa.Column('track_ids', sa.Text(), nullable=False),
    sa.Column('title', sa.String(length=255), nullable=False),
    sa.Column('description', sa.Text(), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=True),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('allow_download', sa.Boolean(), nullable=False),
    sa.Column('max_views', sa.Integer(), nullable=True),
    sa.Column('views', sa.Integer(), nullable=False),
    sa.Column('plays', sa.Integer(), nullable=False),
    sa.Column('downloads', sa.Integer(), nullable=False),
    sa.Column('last_opened_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('enabled', sa.Boolean(), nullable=False),
    sa.Column('secret_version', sa.Integer(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['library_id'], ['libraries.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    **MYSQL_OPTS,
    )
    with op.batch_alter_table('shares', schema=None) as batch_op:
        batch_op.create_index(batch_op.f('ix_shares_owner_id'), ['owner_id'], unique=False)
        batch_op.create_index(batch_op.f('ix_shares_token'), ['token'], unique=True)

    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.add_column(sa.Column('can_share', sa.Boolean(), nullable=False, server_default=sa.false()))



def downgrade() -> None:
    with op.batch_alter_table('users', schema=None) as batch_op:
        batch_op.drop_column('can_share')

    with op.batch_alter_table('shares', schema=None) as batch_op:
        batch_op.drop_index(batch_op.f('ix_shares_token'))
        batch_op.drop_index(batch_op.f('ix_shares_owner_id'))

    op.drop_table('shares')
