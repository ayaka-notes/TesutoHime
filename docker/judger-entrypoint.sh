#!/bin/bash
set -e

# Ensure working directories exist and are owned by the sandbox user.
mkdir -p /var/oj/runner /var/log/oj/runner /var/cache/oj/runner
chown -R ojrunner:ojrunner /var/oj/runner /var/log/oj/runner /var/cache/oj/runner

# Raise the namespace limits; nsjail can otherwise hit ENOSPC under load.
for f in /proc/sys/user/max_user_namespaces /proc/sys/user/max_mnt_namespaces \
         /proc/sys/user/max_pid_namespaces /proc/sys/user/max_net_namespaces; do
    [ -w "$f" ] && echo 1073741824 > "$f" || true
done

git config --system safe.directory '*' || true

# ------------------------------------------------------------------
# Auto-register this runner in the OJ's ``judge_runner_v2`` table so
# /about and the runner status page see it. Idempotent (ON CONFLICT
# DO NOTHING) — re-run on container restart is fine.
#
# Requires ``DB`` env var (the same postgres DSN the web service
# uses). If not present we skip silently — for setups where the
# operator manages the registry by hand.
if [ -n "${DB:-}" ]; then
    python3 - <<'PY' || echo "[judger] auto-register skipped (non-fatal)"
import os, sys, yaml, sqlalchemy as sa

with open('/app/runner.yml') as f:
    cfg = yaml.safe_load(f)
rid = int(cfg['id'])
name = os.environ.get('RUNNER_NAME', f'judger-{rid}')
hardware = os.environ.get('RUNNER_HARDWARE', 'Docker container')
provider = os.environ.get('RUNNER_PROVIDER', 'local')

engine = sa.create_engine(os.environ['DB'])
with engine.begin() as conn:
    conn.execute(sa.text(
        "INSERT INTO judge_runner_v2 (id, name, hardware, provider, visible) "
        "VALUES (:id, :name, :hw, :prov, true) "
        "ON CONFLICT (id) DO UPDATE "
        "  SET name = EXCLUDED.name, "
        "      hardware = EXCLUDED.hardware, "
        "      provider = EXCLUDED.provider, "
        "      visible = true"
    ), {'id': rid, 'name': name, 'hw': hardware, 'prov': provider})
print(f'[judger] registered runner id={rid} name={name}')
PY
fi

# Run the judge worker and the custom-run service together. If either exits,
# bring the whole container down so the restart policy can recover it.
echo "[judger] starting judge worker + custom-run service..."
python3 -m judger2.main &
MAIN_PID=$!
python3 -m judger2.runserver &
RUN_PID=$!

wait -n
echo "[judger] a component exited, shutting down container..."
kill "$MAIN_PID" "$RUN_PID" 2>/dev/null || true
exit 1
