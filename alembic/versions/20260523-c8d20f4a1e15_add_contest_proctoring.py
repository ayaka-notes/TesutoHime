"""contest: proctoring config + sessions + events

Adds:
- contest.proctor_config (JSONB): per-contest proctoring settings.
- contest_proctor_session: one row per (contest, user) attempt.
- contest_proctor_event: append-only log of suspicious / informational
  events tied to a session (tab switch, fullscreen exit, etc.).

Revision ID: c8d20f4a1e15
Revises: b7c1a9e3f204
Create Date: 2026-05-23 09:00:00.000000
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = 'c8d20f4a1e15'
down_revision: Union[str, None] = 'b7c1a9e3f204'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        'contest',
        sa.Column('proctor_config',
                  postgresql.JSONB(astext_type=sa.Text()),
                  nullable=True))

    op.create_table(
        'contest_proctor_session',
        sa.Column('id', sa.Integer(), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False),
        sa.Column('contest_id', sa.Integer(),
                  sa.ForeignKey('contest.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('user_id', sa.Integer(),
                  sa.ForeignKey('user.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('started_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('ended_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('status', sa.String(length=32), nullable=False,
                  server_default='active'),
        sa.Column('tab_switch_count', sa.Integer(), nullable=False,
                  server_default='0'),
        sa.Column('violation_count', sa.Integer(), nullable=False,
                  server_default='0'),
        sa.Column('screen_object_key', sa.String(length=512), nullable=True),
        sa.Column('camera_object_key', sa.String(length=512), nullable=True),
        sa.Column('client_meta',
                  postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.create_index('ix_proctor_session_contest_user',
                    'contest_proctor_session', ['contest_id', 'user_id'])

    op.create_table(
        'contest_proctor_event',
        sa.Column('id', sa.BigInteger(), primary_key=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text('now()'), nullable=False),
        sa.Column('session_id', sa.Integer(),
                  sa.ForeignKey('contest_proctor_session.id',
                                ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text('now()')),
        sa.Column('event_type', sa.String(length=64), nullable=False),
        sa.Column('severity', sa.String(length=16), nullable=False,
                  server_default='info'),
        sa.Column('detail',
                  postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    """DESTRUCTIVE: drops every proctor session row and every event.

    Before running this on a production database, mirror the
    ``oj-proctoring`` MinIO bucket somewhere safe — once the rows are
    gone the recording / snapshot keys become unreachable. The
    Contest.proctor_config column also goes; existing proctored
    contests will no longer be in proctoring mode after rollback.
    """
    op.drop_table('contest_proctor_event')
    op.drop_index('ix_proctor_session_contest_user',
                  table_name='contest_proctor_session')
    op.drop_table('contest_proctor_session')
    op.drop_column('contest', 'proctor_config')
