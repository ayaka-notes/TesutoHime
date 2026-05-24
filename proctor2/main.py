"""proctor2 — media-chunk aggregation service.

Hardened for production:
- Constant-time token comparison (hmac.compare_digest).
- Refuses to boot with the default shared secret when PROCTOR_ENV=production.
- Session token registry persisted to disk; survives a restart so in-flight
  exams don't lose their chunk uploads.
- Background TTL sweeper drops sessions with no activity >SESSION_TTL_SECS.
- CORS Access-Control-Allow-Origin defaults to the configured web public
  origin; wildcard requires PROCTOR_ALLOW_WILDCARD_CORS=1 and logs a warning.
- Chunks: max size per chunk, max bytes per (session, kind), Authorization
  header parsed strictly, errors don't leak which check failed.

The on-disk layout under SPOOL_DIR is intentionally simple:
  <sid>/camera.webm                 ← append-only spool for the session
  <sid>/screen.webm
  registry.json                     ← {sid: {token, kinds, last_activity}}
On finalize the per-(session, kind) file is uploaded to MinIO and the spool
directory removed.
"""
import asyncio
import hmac
import json
import logging
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

import boto3
from aiohttp import web
from botocore.client import Config as BotoConfig

logger = logging.getLogger('proctor2')

# -------------------------- configuration -----------------------------

HOST = os.environ.get('PROCTOR_HOST', '0.0.0.0')
PORT = int(os.environ.get('PROCTOR_PORT', '5300'))
ENV = os.environ.get('PROCTOR_ENV', 'development').lower()

# Storage for chunks-in-progress. One subdir per session_id.
SPOOL_DIR = Path(os.environ.get('PROCTOR_SPOOL', '/var/lib/proctor2'))
REGISTRY_PATH = SPOOL_DIR / 'registry.json'

# Shared secret with the web side. Browsers never see this. The literal
# below MUST be replaced via env in any production deployment — we
# refuse to start with this value when ENV=production.
DEFAULT_INTERNAL_AUTH = 'Bearer oj-internal-secret'
INTERNAL_AUTH = os.environ.get('PROCTOR_INTERNAL_AUTH', DEFAULT_INTERNAL_AUTH)

# CORS: the web public origin browsers come from. '*' is allowed only
# when explicitly opted in.
ALLOWED_ORIGIN = os.environ.get('PROCTOR_ALLOWED_ORIGIN', 'http://localhost:5080')
ALLOW_WILDCARD_CORS = os.environ.get('PROCTOR_ALLOW_WILDCARD_CORS', '0') == '1'

# Allowed track names — kept narrow to avoid file-name surprises.
ALLOWED_KINDS = {'camera', 'screen'}

# Hard caps to bound resource usage. See README for sizing.
MAX_CHUNK_BYTES = 16 * 1024 * 1024     # 16 MiB per chunk
MAX_SESSION_BYTES = 12 * 1024 ** 3     # 12 GiB total per (session, kind)
SESSION_TTL_SECS = 4 * 60 * 60         # drop registry entries idle >4h
SWEEP_INTERVAL_SECS = 5 * 60           # how often the sweeper runs

# S3 / MinIO settings — same env vars web uses.
S3_ENDPOINT = os.environ.get('S3_INTERNAL_ENDPOINT', 'http://minio:9000/')
S3_KEY = os.environ.get('S3_ACCESS_KEY', 'minioadmin')
S3_SECRET = os.environ.get('S3_SECRET_KEY', 'minioadmin')
S3_BUCKET = os.environ.get('S3_PROCTOR_BUCKET', 'oj-proctoring')
S3_REGION = os.environ.get('AWS_DEFAULT_REGION', 'us-east-1')


# -------------------------- in-memory state ---------------------------

# session_id -> {
#   'token': str,                # rotates on each register
#   'kinds': set[str],
#   'meta': dict,
#   'last_activity': float,      # epoch seconds
#   'segment': int,               # bumps on each register; pre-empties append
# }
_sessions: Dict[str, Dict[str, Any]] = {}

# session_id -> {'kind': retries_so_far} for finalize uploads that
# failed once. Background worker retries each entry with exponential
# backoff. Entries are cleaned when upload succeeds or after the
# backoff ceiling is reached.
_finalize_queue: Dict[str, Dict[str, Any]] = {}

# Per-session-kind asyncio.Lock so concurrent chunk writes from the same
# browser are serialised (MediaRecorder emits chunks in order, but POSTs
# can race over multiple HTTP/2 streams).
_chunk_locks: Dict[str, asyncio.Lock] = {}

# Persistence is serialised so concurrent register / finalize don't
# tear the registry.json file.
_registry_lock = asyncio.Lock()


def _spool_path(session_id: str, kind: str, segment: int) -> Path:
    """Spool file for one (session, kind, segment). Each browser
    reconnect (= a fresh MediaRecorder with a fresh WebM EBML header)
    gets its own segment; concatenating WebM streams with mismatched
    headers produces a corrupt file, so segments stay separate and
    the admin detail page renders them as individual <video>s."""
    return SPOOL_DIR / session_id / f'{kind}-{segment}.webm'


def _chunk_key(session_id: str, kind: str) -> str:
    return f'{session_id}:{kind}'


def _now() -> float:
    return time.time()


# -------------------------- auth helpers ------------------------------

def _check_internal(request: web.Request) -> None:
    """Internal endpoint auth (web -> proctor2). hmac.compare_digest
    runs in constant time; '== ' would leak per-character timing."""
    header = request.headers.get('Authorization', '')
    if not header or not hmac.compare_digest(header, INTERNAL_AUTH):
        raise web.HTTPForbidden(text='bad internal auth')


def _check_session_token(request: web.Request, session_id: str) -> Dict[str, Any]:
    """Per-session bearer token auth (browser -> proctor2).

    We intentionally check token validity before we tell the caller
    whether the session exists — a 404-on-unknown / 403-on-bad-token
    split lets an attacker enumerate live session ids by timing the
    response. Instead, both branches return the same 403 with no
    information leak.
    """
    sess = _sessions.get(session_id)
    header = request.headers.get('Authorization', '')
    if not header.startswith('Bearer '):
        raise web.HTTPForbidden(text='bad auth')
    if sess is None:
        # Burn time comparable to a real comparison so we don't leak
        # session existence via response time.
        hmac.compare_digest('x' * 43, header[len('Bearer '):])
        raise web.HTTPForbidden(text='bad auth')
    if not hmac.compare_digest(header[len('Bearer '):], sess['token']):
        raise web.HTTPForbidden(text='bad auth')
    sess['last_activity'] = _now()
    return sess


# -------------------------- registry persistence ---------------------

def _registry_snapshot() -> Dict[str, Any]:
    """Build a JSON-safe view of _sessions for persistence."""
    sessions_out: Dict[str, Dict[str, Any]] = {}
    for sid, s in _sessions.items():
        sessions_out[sid] = {
            'token': s['token'],
            'kinds': list(s.get('kinds', [])),
            'meta': s.get('meta', {}),
            'last_activity': s.get('last_activity', _now()),
            'segment': s.get('segment', 0),
        }
    return {
        'sessions': sessions_out,
        'finalize_queue': _finalize_queue,
    }


async def _save_registry() -> None:
    """Persist _sessions to disk. Best-effort: a failure logs but
    doesn't propagate — the in-memory state is still authoritative
    until the next restart."""
    snap = _registry_snapshot()
    tmp = REGISTRY_PATH.with_suffix('.json.tmp')
    try:
        await asyncio.to_thread(_atomic_write_json, tmp, REGISTRY_PATH, snap)
    except Exception:
        logger.warning('registry persistence failed', exc_info=True)


def _atomic_write_json(tmp: Path, final: Path, data: Dict[str, Any]) -> None:
    tmp.parent.mkdir(parents=True, exist_ok=True)
    with open(tmp, 'w') as f:
        json.dump(data, f)
    os.replace(tmp, final)


def _load_registry() -> None:
    """Rebuild _sessions from disk on boot. Missing / corrupt registry
    is treated as 'start clean' — chunks for orphan spool files will
    still be on disk but won't be reachable until a future finalize."""
    if not REGISTRY_PATH.exists():
        return
    try:
        with open(REGISTRY_PATH) as f:
            data = json.load(f)
        if not isinstance(data, dict):
            return
        # Backward-compat: old registry stored sessions at top level.
        sessions = data.get('sessions') if 'sessions' in data else data
        for sid, s in (sessions or {}).items():
            if not isinstance(s, dict) or 'token' not in s:
                continue
            _sessions[sid] = {
                'token': s['token'],
                'kinds': set(s.get('kinds', [])),
                'meta': s.get('meta', {}),
                'last_activity': float(s.get('last_activity', _now())),
                'segment': int(s.get('segment', 0)),
            }
        fq = data.get('finalize_queue')
        if isinstance(fq, dict):
            _finalize_queue.update(fq)
        logger.info('restored %d sessions (%d pending finalize) from registry',
                    len(_sessions), len(_finalize_queue))
    except Exception:
        logger.warning('registry load failed; starting clean', exc_info=True)


# -------------------------- TTL sweeper -------------------------------

async def _ttl_sweeper(app: web.Application) -> None:
    """Background task that drops sessions whose chunk-upload bearer has
    been idle for >SESSION_TTL_SECS. Keeps the registry from growing
    forever if web crashes mid-exam without calling finalize.

    Spool files for dropped sessions are also removed — without a token
    they're unreachable anyway, and a 4-hour-stale recording is by
    policy too old to ship to MinIO.
    """
    while True:
        try:
            cutoff = _now() - SESSION_TTL_SECS
            stale = [sid for sid, s in _sessions.items()
                     if s.get('last_activity', 0) < cutoff]
            for sid in stale:
                logger.info('TTL-dropping idle session %s', sid)
                await asyncio.to_thread(_cleanup_session_dir, sid)
                _sessions.pop(sid, None)
                for kind in ALLOWED_KINDS:
                    _chunk_locks.pop(_chunk_key(sid, kind), None)
            if stale:
                await _save_registry()
        except Exception:
            logger.warning('TTL sweep failed', exc_info=True)
        try:
            await asyncio.sleep(SWEEP_INTERVAL_SECS)
        except asyncio.CancelledError:
            return


# -------------------------- S3 client --------------------------------

def _make_s3():
    return boto3.client(
        's3',
        endpoint_url=S3_ENDPOINT,
        aws_access_key_id=S3_KEY,
        aws_secret_access_key=S3_SECRET,
        region_name=S3_REGION,
        config=BotoConfig(signature_version='s3v4'),
    )


# -------------------------- handlers ---------------------------------

async def handle_health(request: web.Request) -> web.Response:
    # Don't leak session counts to unauthenticated callers — proctor2 is
    # internal-only but a healthcheck endpoint typically isn't auth'd.
    return web.json_response({'status': 'ok'})


async def handle_register_session(request: web.Request) -> web.Response:
    """web -> proctor2: register a new session (idempotent)."""
    _check_internal(request)
    session_id = request.match_info['session_id']
    if not session_id.isdigit():
        return web.json_response({'error': 'bad session_id'}, status=400)
    try:
        data = await request.json()
    except Exception:
        return web.json_response({'error': 'bad json'}, status=400)
    token = data.get('token')
    if not isinstance(token, str) or len(token) < 32 or len(token) > 128:
        return web.json_response({'error': 'bad token'}, status=400)

    existing = _sessions.get(session_id, {})
    # On every (re-)register we bump the segment counter. The first
    # register sets segment=0; a student reconnecting after a power
    # outage triggers register #2 which bumps to 1, and the next
    # chunks start a fresh file. We never overwrite an old segment.
    prev_segment = existing.get('segment')
    next_segment = 0 if prev_segment is None else prev_segment + 1
    _sessions[session_id] = {
        'token': token,
        'kinds': existing.get('kinds', set()),
        'meta': data.get('meta') or {},
        'last_activity': _now(),
        'segment': next_segment,
    }
    (SPOOL_DIR / session_id).mkdir(parents=True, exist_ok=True)
    await _save_registry()
    logger.info('registered session %s (segment=%d)',
                session_id, next_segment)
    return web.json_response({'ok': True, 'segment': next_segment})


async def handle_chunk(request: web.Request) -> web.Response:
    """browser -> proctor2: append a single MediaRecorder chunk."""
    session_id = request.match_info['session_id']
    kind = request.match_info['kind']
    sess = _check_session_token(request, session_id)

    if kind not in ALLOWED_KINDS:
        return web.json_response({'error': 'bad kind'}, status=400)

    try:
        seq = int(request.match_info['seq'])
        if seq < 0 or seq > 10_000_000:
            raise ValueError
    except ValueError:
        return web.json_response({'error': 'bad seq'}, status=400)

    declared = request.content_length
    if declared is not None and declared > MAX_CHUNK_BYTES:
        return web.json_response({'error': 'chunk too large'}, status=413)

    body = await request.read()
    if len(body) > MAX_CHUNK_BYTES:
        return web.json_response({'error': 'chunk too large'}, status=413)
    if not body:
        return web.json_response({'ok': True, 'bytes': 0})

    segment = sess.get('segment', 0)
    path = _spool_path(session_id, kind, segment)
    lock = _chunk_locks.setdefault(_chunk_key(session_id, kind), asyncio.Lock())
    async with lock:
        # Cap is per-(session, kind) summed across all segments — a
        # student reconnecting 100 times can't bypass the 12 GiB cap.
        d = SPOOL_DIR / session_id
        total = 0
        if d.exists():
            for f in d.iterdir():
                if f.name.startswith(f'{kind}-') and f.name.endswith('.webm'):
                    total += f.stat().st_size
        if total + len(body) > MAX_SESSION_BYTES:
            return web.json_response({'error': 'session too large'}, status=413)
        await asyncio.to_thread(_append, path, body)
    sess['kinds'].add(kind)
    return web.json_response({'ok': True, 'bytes': len(body), 'seq': seq,
                              'segment': segment})


def _append(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'ab') as f:
        f.write(body)


async def handle_finalize(request: web.Request) -> web.Response:
    """web -> proctor2: session ended, upload spool files to MinIO."""
    _check_internal(request)
    session_id = request.match_info['session_id']
    if not session_id.isdigit():
        return web.json_response({'error': 'bad session_id'}, status=400)
    sess = _sessions.get(session_id)
    if sess is None:
        # Idempotent: if there's spool on disk we still try to upload.
        if not (SPOOL_DIR / session_id).exists():
            return web.json_response({'error': 'unknown session'}, status=404)

    success, leftover = await _do_finalize(session_id)
    if leftover:
        # Some uploads failed; keep the spool around and queue the
        # session for background retry. We still report partial
        # success to the web side so the DB row gets ended.
        _finalize_queue[session_id] = {
            'attempts': 1, 'next_retry': _now() + 60.0,
        }
        await _save_registry()
        return web.json_response({
            'ok': False,
            'uploaded': success,
            'pending': list(leftover),
        }, status=202)

    await asyncio.to_thread(_cleanup_session_dir, session_id)
    _sessions.pop(session_id, None)
    _finalize_queue.pop(session_id, None)
    for kind in ALLOWED_KINDS:
        _chunk_locks.pop(_chunk_key(session_id, kind), None)
    await _save_registry()

    return web.json_response({'ok': True, 'uploaded': success})


async def _do_finalize(session_id: str):
    """Try to upload every segment to MinIO; return (success_map, leftover_set).

    `success_map` is {kind: {prefix, segments, total_bytes}} for kinds
    that fully uploaded. `leftover` is the set of kinds with at least
    one failed segment — the spool stays untouched for them.
    """
    s3 = _make_s3()
    d = SPOOL_DIR / session_id
    if not d.exists():
        return {}, set()
    by_kind: Dict[str, list] = {}
    for path in sorted(d.iterdir()):
        name = path.name
        for kind in ALLOWED_KINDS:
            if name.startswith(f'{kind}-') and name.endswith('.webm'):
                by_kind.setdefault(kind, []).append(path)
                break
    uploaded: Dict[str, Dict[str, Any]] = {}
    leftover: set = set()
    for kind, paths in by_kind.items():
        seg_info = []
        total_bytes = 0
        all_ok = True
        for path in paths:
            if path.stat().st_size == 0:
                continue
            # File name is "<kind>-<n>.webm" — extract n for the S3 key.
            seg_n = path.stem.split('-', 1)[1]
            key = f'{session_id}/{kind}/{seg_n}.webm'
            try:
                await asyncio.to_thread(
                    s3.upload_file, str(path), S3_BUCKET, key,
                    ExtraArgs={'ContentType': 'video/webm'},
                )
            except Exception:
                logger.exception('upload failed for %s/%s seg=%s',
                                 session_id, kind, seg_n)
                all_ok = False
                leftover.add(kind)
                break
            seg_info.append({'key': key, 'segment': int(seg_n),
                             'bytes': path.stat().st_size})
            total_bytes += path.stat().st_size
        if all_ok:
            uploaded[kind] = {
                'prefix': f'{session_id}/{kind}/',
                'segments': seg_info,
                'total_bytes': total_bytes,
            }
            # Remove the successfully-uploaded segments from spool so a
            # retry doesn't double-upload.
            for path in paths:
                try: path.unlink()
                except FileNotFoundError: pass
    return uploaded, leftover


async def _finalize_retry_loop() -> None:
    """Background worker that drains _finalize_queue with exponential
    backoff. Each session gets up to 30 minutes of retries before we
    give up (and the spool sits on disk until TTL sweep)."""
    while True:
        try:
            now = _now()
            due = [sid for sid, st in list(_finalize_queue.items())
                   if st['next_retry'] <= now]
            for sid in due:
                st = _finalize_queue.get(sid)
                if not st:
                    continue
                logger.info('finalize retry #%d for %s', st['attempts'], sid)
                _, leftover = await _do_finalize(sid)
                if not leftover:
                    # Success.
                    await asyncio.to_thread(_cleanup_session_dir, sid)
                    _sessions.pop(sid, None)
                    _finalize_queue.pop(sid, None)
                    await _save_registry()
                    continue
                # Failure — backoff and try again, ceiling 30 min total.
                st['attempts'] += 1
                if st['attempts'] > 8:
                    logger.error('giving up on finalize for %s', sid)
                    _finalize_queue.pop(sid, None)
                    continue
                # 60s, 120s, 240s, 480s, 960s, 1800s ...
                delay = min(60 * (2 ** (st['attempts'] - 1)), 1800)
                st['next_retry'] = now + delay
        except Exception:
            logger.warning('finalize retry loop crashed; restarting',
                           exc_info=True)
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            return


def _cleanup_session_dir(session_id: str) -> None:
    d = SPOOL_DIR / session_id
    if not d.exists():
        return
    for child in d.iterdir():
        try:
            child.unlink()
        except FileNotFoundError:
            pass
    try:
        d.rmdir()
    except OSError:
        pass


async def handle_abort(request: web.Request) -> web.Response:
    """web -> proctor2: drop a session and its spool without uploading."""
    _check_internal(request)
    session_id = request.match_info['session_id']
    if not session_id.isdigit():
        return web.json_response({'error': 'bad session_id'}, status=400)
    await asyncio.to_thread(_cleanup_session_dir, session_id)
    _sessions.pop(session_id, None)
    await _save_registry()
    return web.json_response({'ok': True})


async def handle_preview(request: web.Request) -> web.StreamResponse:
    """web -> proctor2: stream the in-progress spool file to the admin.

    Supports Range so the admin's <video> element can seek backwards
    while the file is still being appended. We freeze the byte range
    at the moment the request arrives — the dashboard polls a fresh
    URL every few seconds, which keeps memory predictable.
    """
    _check_internal(request)
    session_id = request.match_info['session_id']
    kind = request.match_info['kind']
    if kind not in ALLOWED_KINDS:
        return web.json_response({'error': 'bad kind'}, status=400)
    if not session_id.isdigit():
        return web.json_response({'error': 'bad session_id'}, status=400)

    # Live preview shows the latest segment (= what the student is
    # currently recording). Older segments are accessible via the
    # admin detail page once the session ends.
    sess = _sessions.get(session_id)
    seg = sess.get('segment', 0) if sess else 0
    path = _spool_path(session_id, kind, seg)
    if not path.exists():
        # Fall back to the most recent existing segment — useful if
        # the segment counter advanced but the new MediaRecorder hasn't
        # flushed its first chunk yet.
        d = SPOOL_DIR / session_id
        if d.exists():
            candidates = sorted(
                (p for p in d.iterdir()
                 if p.name.startswith(f'{kind}-') and p.name.endswith('.webm')),
                key=lambda p: int(p.stem.split('-', 1)[1]),
                reverse=True,
            )
            for cand in candidates:
                if cand.stat().st_size > 0:
                    path = cand
                    break
            else:
                return web.json_response({'error': 'no spool yet'}, status=404)
        else:
            return web.json_response({'error': 'no spool yet'}, status=404)
    file_size = path.stat().st_size
    if file_size == 0:
        return web.json_response({'error': 'empty spool'}, status=404)
    # Staleness gate: MediaRecorder flushes a chunk every 5 s. A spool
    # file whose mtime is older than ~8 s means the student stopped
    # recording (camera off, screen share stopped, network dropped).
    # Returning 410 here makes the admin dashboard mark the panel
    # "无录像" instead of looping an old clip forever — though the
    # SSE event handler usually beats this by reacting to the
    # student's *_track_ended event within a second.
    STALE_AFTER_SECS = 8
    mtime = path.stat().st_mtime
    if _now() - mtime > STALE_AFTER_SECS:
        return web.json_response({'error': 'recording stale',
                                  'last_chunk_seconds_ago':
                                  round(_now() - mtime, 1)}, status=410)

    rng = request.headers.get('Range', '')
    start, end = 0, file_size - 1
    is_range = False
    if rng.startswith('bytes='):
        is_range = True
        try:
            a, b = rng[6:].split('-', 1)
            start = int(a) if a else 0
            end = int(b) if b else file_size - 1
        except ValueError:
            return web.json_response({'error': 'bad range'}, status=416)
        if start >= file_size or start > end:
            return web.json_response({'error': 'range unsatisfiable'},
                                     status=416)
        end = min(end, file_size - 1)

    headers = {
        'Content-Type': 'video/webm',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
    }
    if is_range:
        headers['Content-Range'] = f'bytes {start}-{end}/{file_size}'
    resp = web.StreamResponse(
        status=206 if is_range else 200,
        headers={'Content-Length': str(end - start + 1), **headers},
    )
    await resp.prepare(request)
    remaining = end - start + 1
    chunk = 64 * 1024
    pos = start

    def _read_block(p: int, n: int) -> bytes:
        with open(path, 'rb') as f:
            f.seek(p)
            return f.read(n)

    while remaining > 0:
        buf = await asyncio.to_thread(_read_block, pos, min(chunk, remaining))
        if not buf:
            break
        await resp.write(buf)
        remaining -= len(buf)
        pos += len(buf)
    await resp.write_eof()
    return resp


# -------------------------- CORS --------------------------------------

@web.middleware
async def cors_middleware(request: web.Request, handler):
    origin = request.headers.get('Origin', '')
    if request.method == 'OPTIONS':
        return _cors_response(web.Response(status=204), origin)
    try:
        resp = await handler(request)
    except web.HTTPException as e:
        return _cors_response(e, origin)
    return _cors_response(resp, origin)


def _cors_response(resp, origin: str):
    # Echo only the configured origin (or '*' if explicitly enabled).
    # Echoing arbitrary Origin headers would defeat the purpose of CORS.
    if ALLOW_WILDCARD_CORS:
        resp.headers['Access-Control-Allow-Origin'] = '*'
    elif origin and origin == ALLOWED_ORIGIN:
        resp.headers['Access-Control-Allow-Origin'] = origin
        resp.headers['Vary'] = 'Origin'
    else:
        # Don't set Allow-Origin at all — preflight will fail in the
        # browser, which is what we want for unknown origins. Internal
        # endpoints (no browser involvement) work regardless because
        # they don't go through CORS.
        pass
    resp.headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS'
    # X-Acmoj-Is-Csrf is added to every POST by web's base.js fetch
    # monkey-patch (CSRF bypass marker), so we must allow it in the
    # preflight even though proctor2 ignores its value.
    resp.headers['Access-Control-Allow-Headers'] = (
        'Authorization, Content-Type, X-Acmoj-Is-Csrf')
    resp.headers['Access-Control-Max-Age'] = '600'
    return resp


# -------------------------- entry point -------------------------------

def _check_secrets() -> None:
    if INTERNAL_AUTH == DEFAULT_INTERNAL_AUTH:
        if ENV == 'production':
            logger.error(
                'PROCTOR_INTERNAL_AUTH is set to the default; refusing to '
                'start in production. Generate a strong secret '
                '(eg. `openssl rand -hex 32`) and set PROCTOR_INTERNAL_AUTH.')
            sys.exit(2)
        logger.warning(
            'PROCTOR_INTERNAL_AUTH is the default — fine for development, '
            'must be rotated before production deploy.')
    if ALLOW_WILDCARD_CORS:
        logger.warning('CORS Allow-Origin: * — only safe because all '
                       'browser-facing endpoints use bearer tokens, not '
                       'cookies. Set PROCTOR_ALLOWED_ORIGIN to lock down.')


async def _on_startup(app: web.Application) -> None:
    SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    _load_registry()
    app['sweeper_task'] = asyncio.create_task(_ttl_sweeper(app))
    app['finalize_retry_task'] = asyncio.create_task(_finalize_retry_loop())


async def _on_cleanup(app: web.Application) -> None:
    for name in ('sweeper_task', 'finalize_retry_task'):
        task = app.get(name)
        if not task:
            continue
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(name)s %(message)s',
        stream=sys.stderr,
    )
    _check_secrets()

    app = web.Application(
        client_max_size=MAX_CHUNK_BYTES + 64 * 1024,
        middlewares=[cors_middleware],
    )
    app.router.add_get('/health', handle_health)
    app.router.add_post('/internal/sessions/{session_id}', handle_register_session)
    app.router.add_post('/internal/sessions/{session_id}/finalize', handle_finalize)
    app.router.add_post('/internal/sessions/{session_id}/abort', handle_abort)
    app.router.add_get('/internal/preview/{session_id}/{kind}', handle_preview)
    app.router.add_post('/chunk/{session_id}/{kind}/{seq}', handle_chunk)
    app.on_startup.append(_on_startup)
    app.on_cleanup.append(_on_cleanup)

    logger.info('proctor2 listening on %s:%s (env=%s, spool=%s, bucket=%s)',
                HOST, PORT, ENV, SPOOL_DIR, S3_BUCKET)
    web.run_app(app, host=HOST, port=PORT, print=None)


if __name__ == '__main__':
    main()
