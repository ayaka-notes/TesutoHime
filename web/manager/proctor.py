"""Proctoring control plane.

The browser talks to two backends during a proctored exam:
- This web service for low-rate control traffic (start a session, log an
  event, end the session) — single source of truth for the DB.
- proctor2 (separate aiohttp service) for high-rate media chunks, which
  never touch this process.

When a session is created we mint a per-session opaque token, persist a
row in ContestProctorSession, and ``register`` the session with proctor2
so that subsequent chunk uploads bearing that token are accepted.
"""
__all__ = ('ProctorManager',)

import json
import secrets
from datetime import datetime
from logging import getLogger
from typing import Any, Dict, List, Optional, Tuple

import requests
from flask import abort, g
from sqlalchemy import select

from commons.models import (Contest, ContestProctorEvent,
                            ContestProctorSession, User)
from web.config import ProctorConfig, RedisConfig
from web.utils import db, redis_connect

logger = getLogger(__name__)


def _live_channel(contest_id: int) -> str:
    """Redis pub/sub channel that the admin dashboard subscribes to."""
    return f'{RedisConfig.prefix}proctor:live:{contest_id}'


def _publish(contest_id: int, payload: Dict[str, Any]) -> None:
    """Fire-and-forget broadcast for the admin live dashboard.

    Failure is logged but never propagates — a missing Redis must not
    break the underlying student request.
    """
    try:
        redis_connect().publish(_live_channel(contest_id),
                                json.dumps(payload, default=str))
    except Exception:
        logger.warning('proctor publish failed for contest %s',
                       contest_id, exc_info=True)


# Recognised severities. Anything else from the client is rejected.
_SEVERITIES = {'info', 'warning', 'violation'}

# A whitelist of event types the client may submit. Keeping this closed
# means a leaked token can't pollute the log with arbitrary strings.
_EVENT_TYPES = {
    # Lifecycle / heartbeat
    'session_start', 'session_end', 'heartbeat',
    # Visibility & focus
    'visibility_hidden', 'visibility_visible', 'window_blur', 'window_focus',
    # Fullscreen
    'fullscreen_enter', 'fullscreen_exit',
    # Page lifecycle
    'pagehide', 'pageshow', 'beforeunload',
    # Keyboard (informational; we do NOT treat ctrl-s as a violation)
    'key_combo',
    # Media stream changes
    'screen_share_stopped', 'camera_track_ended', 'mic_track_ended',
    # Clipboard / paste — recorded for review, NEVER auto-flagged as
    # violation. Students legitimately paste their own code.
    'paste_detected',
    # Multi-monitor plugged in mid-exam.
    'multi_monitor_detected', 'multi_monitor_resolved',
    # Screen-share content changed mid-exam (eg. student tried to
    # downgrade from "整个屏幕" to a single window).
    'screen_surface_changed',
    # Environment fingerprint (one-shot at session start). Stored so an
    # admin can later spot dual-monitor setups, virtual cameras, etc.
    'environment_info',
    # Misc
    'client_error', 'client_warning',
}

# Default ``proctor_config`` for a contest where the column is set but
# fields are missing. ``None`` (no proctoring) is handled separately.
_DEFAULTS = {
    'require_camera': False,
    'require_mic': False,
    'require_screen': True,
    'record_camera': True,
    'record_screen': True,
    'fullscreen_required': True,
    'max_tab_switches': 3,
    # Pre-flight VM / remote-desktop / software-renderer detection. Off
    # is meant as a development / staging escape hatch — do NOT disable
    # this on real proctored exams or students can join from VMs.
    'require_envcheck': True,
}


class ProctorManager:

    # ----- config inspection ------------------------------------------

    @staticmethod
    def config_for(contest: Contest) -> Optional[Dict[str, Any]]:
        """Return the resolved proctor config dict, or None if disabled."""
        cfg = contest.proctor_config
        if not cfg:
            return None
        resolved = dict(_DEFAULTS)
        resolved.update({k: v for k, v in cfg.items() if k in _DEFAULTS})
        # A contest is "proctored" iff at least one constraint is active.
        if not any((resolved['require_camera'], resolved['require_mic'],
                    resolved['require_screen'],
                    resolved['fullscreen_required'])):
            return None
        return resolved

    # ----- session lifecycle ------------------------------------------

    @staticmethod
    def get_active_session(contest: Contest, user: User) \
            -> Optional[ContestProctorSession]:
        return db.scalar(
            select(ContestProctorSession)
            .where(ContestProctorSession.contest_id == contest.id,
                   ContestProctorSession.user_id == user.id,
                   ContestProctorSession.status == 'active')
            .order_by(ContestProctorSession.id.desc())
            .limit(1)
        )

    @staticmethod
    def get_finished_session(contest: Contest, user: User) \
            -> Optional[ContestProctorSession]:
        """A session that the student has already turned in (status
        'ended') OR that was administratively closed ('aborted').
        Either way the student is done with this contest and must not
        be allowed to re-enter; their score is locked in by whatever
        submissions they had before close.
        """
        return db.scalar(
            select(ContestProctorSession)
            .where(ContestProctorSession.contest_id == contest.id,
                   ContestProctorSession.user_id == user.id,
                   ContestProctorSession.status.in_(['ended', 'aborted']))
            .order_by(ContestProctorSession.id.desc())
            .limit(1)
        )

    @staticmethod
    def start_session(contest: Contest, user: User,
                      client_meta: Optional[Dict[str, Any]] = None) \
            -> Tuple[ContestProctorSession, str]:
        """Return (session, fresh_token).

        If an active session already exists for (contest, user) we keep
        it — only the chunk-upload token is rotated. This makes browser
        refresh a no-op for the participant and avoids losing the event
        history of the attempt-in-progress.
        """
        cfg = ProctorManager.config_for(contest)
        if cfg is None:
            abort(400, '本场比赛未启用监考')

        sess = ProctorManager.get_active_session(contest, user)
        if sess is None:
            sess = ContestProctorSession(
                contest_id=contest.id,
                user_id=user.id,
                client_meta=client_meta or {},
            )
            db.add(sess)
            try:
                db.flush()              # need sess.id for proctor2 register
            except Exception:
                # The partial unique index ux_proctor_active_unique
                # raised IntegrityError because another request just
                # created the active session for this (contest, user).
                # Roll back the conflict and re-fetch the winner.
                db.rollback()
                sess = ProctorManager.get_active_session(contest, user)
                if sess is None:
                    raise   # genuine error, not a race
        elif client_meta:
            # Merge in a fresh client_meta so admin can see what the
            # student's browser looks like on each (re)entry.
            merged = dict(sess.client_meta or {})
            merged.update(client_meta)
            sess.client_meta = merged
        token = secrets.token_urlsafe(32)

        _publish(contest.id, {
            'type': 'session_status',
            'session_id': sess.id,
            'user_id': sess.user_id,
            'user_name': user.friendly_name,
            'user_login': user.username,
            'status': 'active',
        })

        # Register with proctor2 so it'll accept subsequent chunk uploads.
        # If proctor2 is unreachable we *still* succeed — the session is
        # usable for events/visibility tracking, just without video.
        try:
            requests.post(
                f'{ProctorConfig.base_url.rstrip("/")}/internal/sessions/{sess.id}',
                headers={'Authorization': ProctorConfig.internal_auth},
                json={'token': token, 'meta': client_meta or {}},
                timeout=2.0,
            ).raise_for_status()
        except Exception:
            # Best-effort; failure here is logged but not fatal.
            from logging import getLogger
            getLogger(__name__).warning('proctor2 register failed for session %s',
                                        sess.id, exc_info=True)
        return sess, token

    @staticmethod
    def end_session(sess: ContestProctorSession, status: str = 'ended') -> None:
        if sess.status != 'active':
            return
        sess.status = status
        sess.ended_at = datetime.now()
        _publish(sess.contest_id, {
            'type': 'session_status',
            'session_id': sess.id,
            'user_id': sess.user_id,
            'status': status,
        })
        try:
            endpoint = ('finalize' if status == 'ended' else 'abort')
            requests.post(
                f'{ProctorConfig.base_url.rstrip("/")}'
                f'/internal/sessions/{sess.id}/{endpoint}',
                headers={'Authorization': ProctorConfig.internal_auth},
                timeout=10.0,
            )
        except Exception:
            from logging import getLogger
            getLogger(__name__).warning(
                'proctor2 %s failed for session %s', status, sess.id, exc_info=True)
        else:
            if status == 'ended':
                # proctor2 uploads each segment as
                # <sid>/<kind>/<n>.webm — admin detail enumerates by
                # this prefix. Storing the prefix (not a single key)
                # makes the segmented layout transparent to the
                # rest of the app.
                sess.screen_object_key = f'{sess.id}/screen/'
                sess.camera_object_key = f'{sess.id}/camera/'

    @staticmethod
    def reopen_session(sess: ContestProctorSession) -> None:
        """Admin override: lift the once-and-done lockout for a finished
        session so the student can re-enter the contest.

        We revive the SAME row (status='active', ended_at cleared) rather
        than spawning a fresh session — that preserves the violation /
        tab-switch counts and the already-uploaded recording segments,
        so the student returns to the exact state they were in before
        accidentally submitting. proctor2 will be re-registered on the
        student's next ``start_session`` call, which mints a fresh
        chunk-upload token automatically.
        """
        if sess.status == 'active':
            return
        sess.status = 'active'
        sess.ended_at = None
        _publish(sess.contest_id, {
            'type': 'session_status',
            'session_id': sess.id,
            'user_id': sess.user_id,
            'status': 'active',
        })

    # ----- events -----------------------------------------------------

    @staticmethod
    def log_event(sess: ContestProctorSession, event_type: str,
                  severity: str = 'info',
                  detail: Optional[Dict[str, Any]] = None) -> ContestProctorEvent:
        if event_type not in _EVENT_TYPES:
            abort(400, f'未知事件类型：{event_type}')
        if severity not in _SEVERITIES:
            abort(400, f'未知严重度：{severity}')

        ev = ContestProctorEvent(
            session_id=sess.id,
            event_type=event_type,
            severity=severity,
            detail=detail or {},
        )
        db.add(ev)
        db.flush()                       # populate ev.id for the response

        _publish(sess.contest_id, {
            'type': 'event',
            'session_id': sess.id,
            'user_id': sess.user_id,
            'event_id': ev.id,
            'event_type': event_type,
            'severity': severity,
            'tab_switch_count': sess.tab_switch_count,
            'violation_count': sess.violation_count,
            'occurred_at': ev.occurred_at.isoformat() if ev.occurred_at else None,
            'detail': detail or {},
        })
        # Counters used in admin overview. Tab-switch counts every loss of
        # visibility / focus; violation_count tallies the harder violations.
        # ``fullscreen_exit`` counts as a tab switch — leaving fullscreen
        # is functionally indistinguishable from minimizing the window in
        # terms of letting the student look at other things on screen.
        if event_type in ('visibility_hidden', 'window_blur', 'fullscreen_exit'):
            sess.tab_switch_count += 1
        if severity == 'violation':
            sess.violation_count += 1
        return ev

    @staticmethod
    def list_events(sess: ContestProctorSession,
                    limit: int = 500) -> List[ContestProctorEvent]:
        return list(db.scalars(
            select(ContestProctorEvent)
            .where(ContestProctorEvent.session_id == sess.id)
            .order_by(ContestProctorEvent.occurred_at.desc(),
                      ContestProctorEvent.id.desc())
            .limit(limit)
        ).all())

    # ----- admin queries ----------------------------------------------

    @staticmethod
    def sessions_for_contest(contest: Contest) -> List[ContestProctorSession]:
        return list(db.scalars(
            select(ContestProctorSession)
            .where(ContestProctorSession.contest_id == contest.id)
            .order_by(ContestProctorSession.id.desc())
        ).all())
