"""proctor session: unique active session per (contest, user)

Adds a partial unique index so the DB enforces "at most one active
session per (contest, user)".  Without it, two simultaneous setup-
page submits could each see "no active session" and both insert,
leaving an orphan row.  start_session catches the IntegrityError
that this index raises on conflict and reuses the existing row.

Revision ID: d3a47b91c2e8
Revises: c8d20f4a1e15
Create Date: 2026-05-23 09:30:00.000000

"""
from typing import Sequence, Union

from alembic import op

revision: str = 'd3a47b91c2e8'
down_revision: Union[str, None] = 'c8d20f4a1e15'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        'ux_proctor_active_unique',
        'contest_proctor_session',
        ['contest_id', 'user_id'],
        unique=True,
        postgresql_where=op.f("status = 'active'"),
    )


def downgrade() -> None:
    op.drop_index('ux_proctor_active_unique',
                  table_name='contest_proctor_session')
