# Proctoring — security & operational requirements

This document is the source of truth for the proctoring subsystem's
security posture: what it defends against, what it doesn't, and what
operators **must** configure before relying on it for a graded exam.

## Threat model

| Actor | Capability | Trust |
| ----- | ---------- | ----- |
| Student (honest) | Has site account, opens setup page, grants media permissions | Untrusted (input validated). |
| Student (adversarial) | Same as above + tampering with browser-side JS, network MITM of own traffic, sharing screen share with a confederate, screen tap on a second device, asking AI on a phone | Untrusted; **out of scope for browser-side detection** beyond what's documented below. |
| Course admin / site admin | Holds `Privilege.ADMIN`/`SUPER` or owns the contest's course | Trusted with viewing recordings & live streams of students enrolled in their contests. Actions audit-logged. |
| Site operator | Root-equivalent on infra | Trusted with secrets & data retention. Audit log integrity depends on log sink (out of scope). |
| External network attacker | Has TCP to web / proctor2 / MinIO | Untrusted. |
| Internal lateral attacker | Already on the docker network (e.g. compromised one container) | Limited trust; can read Redis pub/sub and reach MinIO. **Encryption-at-rest required for hostile-tenant deployments.** |

## What's hardened (in code)

| Concern | Mitigation | File |
|--|--|--|
| Token comparison timing leak | `hmac.compare_digest` on both internal and per-session bearers, including a same-time dummy comparison when the session is unknown so an attacker can't enumerate live ids by timing | `proctor2/main.py` `_check_session_token` |
| Default shared secret in prod | `proctor2` refuses to start when `PROCTOR_ENV=production` and `PROCTOR_INTERNAL_AUTH` is the bundled default | `proctor2/main.py` `_check_secrets` |
| Chunk DoS by size | 16 MiB / chunk + 12 GiB / session-kind hard caps in proctor2; aiohttp also rejects bodies above `client_max_size` before reaching the handler | `proctor2/main.py` |
| Snapshot polyglot upload | Server rejects bodies whose first 3 bytes don't match the JPEG SOI (`FF D8 FF`) — no HTML/SVG/PDF/etc. sneaking into the gallery as evidence | `web/web.py` `proctor_post_snapshot` |
| Snapshot flood | 1-per-15-seconds per (session, kind) rate limit + 500 total per (session, kind) hard cap, both keyed in Redis with TTL | `web/web.py` `proctor_post_snapshot` |
| Event flood | 120 events / minute per session hard cap, batched payload size accounted (a 100-event request counts as 100) | `web/web.py` `proctor_post_events` |
| CORS on proctor2 | Echoes only the configured `PROCTOR_ALLOWED_ORIGIN`; wildcard requires explicit `PROCTOR_ALLOW_WILDCARD_CORS=1` and logs a warning every boot | `proctor2/main.py` `cors_middleware` |
| Stale session memory leak in proctor2 | Background sweeper drops registry entries idle >4 hours and cleans their spool dir | `proctor2/main.py` `_ttl_sweeper` |
| Process restart loses in-flight exams | proctor2 persists `(sid, token, last_activity)` to `registry.json` on every register/finalize/abort and replays on boot | `proctor2/main.py` `_save_registry` |
| Cross-channel SSE leak | Every outbound SSE frame is parsed, run through a schema validator (`_validate_live` / `_validate_signal`), and re-serialised. Any redis publisher that emits an unknown shape is silently dropped | `web/web.py` `_sse_stream` |
| Forged signaling | `from` field is set server-side, not by the client — admin and student each use their own POST endpoint and the server stamps the role | `web/web.py` `_signal_relay` |
| Admin uploads to student endpoint | `proctor_post_snapshot` rejects requests where `g.is_admin` even if otherwise authorized | `web/web.py` |
| VM / RDP / software renderer | Client-side WebGL probe against a list of known substrings; hard gate on entry button + server refuses session creation if `client_meta.envcheck.blocked` is true or missing | `web/static/js/proctor-envcheck.js` + server-side check in `proctor_create_session` |
| Audit trail for admin viewing | Dedicated `proctor.audit` logger emits one JSON line per admin action (dashboard open, session detail view, preview started, live drill-in, config save). Operators route this to an append-only sink | `web/web.py` `_audit` |

## What's NOT hardened — operator action required

These are tractable problems that we deliberately don't solve in code
because the right answer depends on the deployment.

### 1. TLS termination

The provided `docker-compose.yml` exposes web on plain HTTP `:5080`.
The CSRF cookie is `secure=True`, so cross-origin POSTs already fail
over HTTP, but everything else (recordings, snapshots, WebRTC
signaling tokens) flows in cleartext. **You must terminate TLS in
front of web and proctor2** — typically with the same reverse proxy.
Without TLS this is not a proctoring system; it's a confession of
intent to fail compliance.

### 2. Secret rotation

Four secrets currently live as env vars:
- `PROCTOR_INTERNAL_AUTH` — web ↔ proctor2 shared bearer
- `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` — used to sign per-session
  JWTs that grant publish (student) or subscribe (admin) on the SFU.
  The same secret is configured in `docker/livekit.yaml` (the SFU
  side) and `LIVEKIT_API_SECRET` (the web side); both must match.
- `S3_ACCESS_KEY` / `S3_SECRET_KEY` — MinIO credentials
- `SCHEDULER_AUTH` — pre-existing for the judge pipeline

Generate each with `openssl rand -hex 32`, store them in your secret
manager, and rotate at least quarterly. Rotation procedure:
1. Set the new `PROCTOR_INTERNAL_AUTH` on both web and proctor2.
2. Restart proctor2 first, then web. (proctor2 will still accept
   chunks during the gap because the in-flight tokens are session
   tokens — they're independent of the internal secret.)
3. `_check_secrets` will refuse to boot on the default value when
   `PROCTOR_ENV=production`.

### 3. Encryption at rest

Snapshots and recordings are **uploaded to MinIO in cleartext**. For
deployments where the storage tier is hostile-or-shared (anything
with another tenant on the same backing disk, or any cloud where the
ops team isn't the same as the school's privacy authority) configure
MinIO SSE-S3 or SSE-KMS on the `oj-proctoring` bucket. Camera frames
are PII; treat them as such.

### 4. Data retention

There is **no automatic deletion** of recordings or snapshots. For
schools subject to GDPR / PIPL / FERPA equivalents, add a MinIO
bucket lifecycle policy on `oj-proctoring`:

```sh
mc ilm rule add --expire-days 90 local/oj-proctoring
```

90 days is a reasonable default — enough to cover an academic term
plus appeal window, short enough to limit the blast radius of a
storage breach. Confirm with your institutional review board.

### 5. WSGI worker model

Flask's dev server is threaded; production gunicorn defaults to sync
workers, which **break SSE** because a long-lived response holds the
worker. For production: use `gevent` workers (`--worker-class
gevent`) or run a dedicated SSE sidecar. The current code path is
correct for either, but the launch command must match.

### 6. Subresource integrity for `proctor-envcheck.js`

The VM detection JS lives at `/static/js/proctor-envcheck.js`. A
network attacker (in the absence of TLS — see point 1) or a CDN
compromise could swap it for a no-op. Add SRI hashes to the
`<script src=...>` tag in `proctor_setup.html` and rotate them on
every release. SRI is meaningless without HTTPS, which is another
reason point 1 is non-negotiable.

### 7. Bypass risk on VM detection

The browser-only env check catches the obvious cases — VMware,
VirtualBox, Parallels, QEMU, Hyper-V, RDP, VNC, Citrix, software
rasterizers. It **does not** catch:

- A determined student who patches their Chromium build to spoof
  `UNMASKED_RENDERER_WEBGL`.
- A VM with full GPU passthrough (VFIO/SR-IOV) — uncommon at the
  consumer level, but real.
- A student who simply ignores the rules and runs the exam under a
  bare-metal install of Ubuntu in a VM-detection-aware Live USB.

These are the cases that justify installing a **native companion
app** for high-stakes exams. The companion app would enumerate OS
processes and network connections (which a browser cannot) and is
the only complete answer. The current system is honest about this:
it sends every probe result to the server (audit trail), refuses
sessions where the probe is missing or flagged, and uses the
existing recording/event evidence stack as backup. For a graded
class exam this is sufficient; for a national board exam, it is
not.

### 8. Recording integrity / non-repudiation

The recording uploaded to MinIO is the proctor2 spool file with no
signature. A site operator with MinIO credentials could replace it.
For non-repudiation:

- Have proctor2 compute a SHA-256 of the spool file at finalize and
  store the hash in the `ContestProctorSession` row (a hash column
  would need an Alembic migration — not done here).
- Sign the hash with a per-school KMS key.
- Hand the signed hash to the student at the end of the exam so they
  can verify their own recording later.

This is the right control for adversarial-school scenarios. Not
needed for routine course exams.

### 9. Append-only audit log

The `proctor.audit` logger writes to whatever handler Python's
logging is configured with — by default that's the same handler as
the application log, which is rotated and overwritten. **For
admissibility you want an append-only sink**:

- An external syslog server with no SSH access.
- A WORM bucket (some S3 implementations support Object Lock).
- A SIEM ingestion pipeline.

Configure via `web/logging_.py`.

### 10. LiveKit SFU (current architecture)

Live observation now routes every track through a central LiveKit
server (`docker/livekit.yaml`). Students publish camera + screen
into a per-contest room (`contest:<id>`); admin dashboards join the
same room as subscribers and the SFU fans the tracks out. This
replaces the earlier browser-to-browser mesh.

What this changes for security:

- **Single trust boundary**: every byte of every student's video
  passes through the LiveKit container. Compromise of the SFU
  compromises live monitoring; recordings (still going via proctor2
  to MinIO) and event logs are unaffected.
- **TURN / NAT**: LiveKit handles ICE on the server side. For
  students outside the school LAN you must deploy a TURN server
  (coturn) and point LiveKit at it. Single-LAN deployments can skip
  TURN.
- **Tokens**: every join requires a JWT signed with
  `LIVEKIT_API_SECRET`. Tokens are scoped to a single room and
  capability (publish vs subscribe), validity 4 hours. The web
  server issues them via `/api/proctor/sessions/<sid>/livekit-
  token` (student) and `/problemset/<id>/admin/proctor/livekit-
  token` (admin).

**Limits (single LiveKit node)**: ~500–1000 publishers per process
on an 8-core host; admin browsers cap themselves at 25 concurrent
visible cards via pagination. Beyond ~1000 publishers, run a
LiveKit cluster with Redis backplane (see LiveKit docs).

## Checklist before going live

- [ ] TLS termination in front of web, proctor2 and LiveKit
      (LiveKit must serve wss:// not ws://).
- [ ] `PROCTOR_INTERNAL_AUTH` set to a random 32-byte hex string.
- [ ] `PROCTOR_ENV=production` on proctor2 (refuses default secrets).
- [ ] `PROCTOR_ALLOWED_ORIGIN` set to the public web URL (no wildcards).
- [ ] `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` rotated; the SAME
      secret value placed in `docker/livekit.yaml` ``keys:`` block
      and the `LIVEKIT_API_SECRET` env var on web.
- [ ] coturn TURN server reachable from student devices if any will
      be off-LAN; LiveKit configured with TURN credentials.
- [ ] MinIO SSE configured on `oj-proctoring`.
- [ ] MinIO lifecycle policy: 90-day expiry on `oj-proctoring`.
- [ ] `proctor.audit` logger routed to an append-only sink.
- [ ] Gunicorn `--worker-class gevent` (or equivalent) for SSE.
- [ ] Backup procedure for `proctor2`'s `registry.json` and spool dir.
- [ ] Tested: a student attempting to enter from a VM is refused
      both at the setup page UI and at the server endpoint.
- [ ] Tested: secret rotation procedure end-to-end on staging.
- [ ] Tested: 200-publisher LiveKit load test passes on production
      hardware (use `livekit-cli load-test`, see README).
