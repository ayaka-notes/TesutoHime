#!/bin/sh
set -e

echo "[web] waiting for database to become available..."
until python -c "import os, sqlalchemy; sqlalchemy.create_engine(os.environ['DB']).connect().close()" 2>/dev/null; do
    echo "[web] database not ready, retrying in 2s..."
    sleep 2
done
echo "[web] database is up."

# Initialize the schema on first run (create_all + alembic stamp head).
HAS_TABLE=$(python -c "import os, sqlalchemy as sa; e=sa.create_engine(os.environ['DB']); print(sa.inspect(e).has_table('user'))")
if [ "$HAS_TABLE" != "True" ]; then
    echo "[web] empty database detected, initializing schema..."
    python -m scripts.db.init
    echo "[web] schema initialized."
else
    echo "[web] existing schema detected, applying migrations..."
    alembic upgrade head || echo "[web] alembic upgrade skipped/failed (non-fatal)."
fi

echo "[web] starting gunicorn on 0.0.0.0:5000"
exec gunicorn \
    --workers "${GUNICORN_WORKERS:-4}" \
    --bind 0.0.0.0:5000 \
    --timeout 120 \
    --access-logfile - \
    web.web:oj
