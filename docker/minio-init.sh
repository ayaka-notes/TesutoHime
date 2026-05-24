#!/bin/sh
set -e

MINIO_URL="${MINIO_URL:-http://minio:9000}"
MINIO_USER="${MINIO_ROOT_USER:-minioadmin}"
MINIO_PASS="${MINIO_ROOT_PASSWORD:-minioadmin}"

echo "[minio-init] waiting for MinIO at ${MINIO_URL}..."
until mc alias set local "${MINIO_URL}" "${MINIO_USER}" "${MINIO_PASS}" >/dev/null 2>&1; do
    echo "[minio-init] MinIO not ready, retrying in 2s..."
    sleep 2
done
echo "[minio-init] MinIO is up."

for bucket in oj-problems oj-submissions oj-artifacts oj-images oj-attachments; do
    mc mb --ignore-existing "local/${bucket}"
    echo "[minio-init] bucket ready: ${bucket}"
done

# Images are served directly to the browser, so allow anonymous downloads.
mc anonymous set download local/oj-images
echo "[minio-init] anonymous download enabled for oj-images"

echo "[minio-init] done."
