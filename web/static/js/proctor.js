/* proctor.js — in-exam runtime for proctored contests.
 *
 * Reads window.PROCTOR_BOOT injected by the contest/problem template:
 *   { sessionId: int, proctorUrl: str, config: {...} }
 *
 * The chunk-upload token is read from sessionStorage under
 *   proctor:<sessionId>=<token>
 * which the setup page (proctor_setup.html) puts there after creating
 * the session. If the token is missing we bounce to setup.
 *
 * Responsibilities (in order of activation):
 *   1. Confirm session token; if missing, redirect to setup.
 *   2. Show a "click to start" modal that gates the rest until the user
 *      grants camera / screen permissions (getDisplayMedia requires a
 *      user gesture, so we cannot start recording on page-load alone).
 *   3. Start MediaRecorder for each enabled track; POST chunks to
 *      proctor2 as they arrive.
 *   4. Enforce fullscreen if configured; record exits as violations.
 *   5. Track visibility / blur / fullscreen-exit / informational key
 *      combos and POST them to /api/proctor/sessions/<id>/events in
 *      batches (flushed on a heartbeat and on each violation).
 *   6. Warn the student once tab_switch_count exceeds the configured
 *      max_tab_switches.  We *do not* end the session or block
 *      submissions — admin reviews after the fact.
 */
(function () {
  'use strict';

  if (!window.PROCTOR_BOOT) return;
  // Setup page hosts its own envcheck + media-probe UI; running the
  // in-exam proctor on top of it would also try to redirect back to
  // setup, producing an infinite refresh loop. Detect and skip.
  if (window.location.pathname.indexOf('/proctor/setup') !== -1) return;
  const BOOT = window.PROCTOR_BOOT;
  const CFG = BOOT.config || {};
  // Mutable so we can mint a session inline on the contest page when
  // the student arrives without one.
  let SID = BOOT.session_id;
  const PROCTOR_URL = (BOOT.proctor_url || '').replace(/\/$/, '');
  const CONTEST_SETUP_URL = BOOT.setup_url;

  function tokenKey() { return 'proctor:' + SID; }

  /** Resolve a per-session URL. Pre-existing sessions ship concrete
   * URLs in BOOT.<key>; freshly-minted ones use BOOT.<key>_template
   * with a {sid} placeholder we substitute now that SID is known. */
  function urlFor(key) {
    if (BOOT[key]) return BOOT[key];
    const tmpl = BOOT[key + '_template'];
    if (!tmpl || SID == null) return null;
    return tmpl.replace('{sid}', SID);
  }

  // Mutable so we can rotate during a device-reacquire flow without
  // forcing the student to leave the exam page.
  let token = SID == null ? null : sessionStorage.getItem(tokenKey());
  // No token in this tab means either:
  //   (a) the student opened the exam in a fresh window and hasn't
  //       run the gesture overlay yet, or
  //   (b) sessionStorage was cleared on refresh.
  // The gesture overlay below handles both by minting a session
  // inline when the student clicks "开始考试" — no redirect away
  // from the contest page.

  // ------------------------------- event buffer ------------------------
  const eventQueue = [];
  let flushing = false;
  let flushTimer = null;

  function queueEvent(type, severity, detail) {
    eventQueue.push({
      event_type: type,
      severity: severity || 'info',
      detail: detail || null,
      client_ts: Date.now(),
    });
    if (severity === 'violation') {
      // Flush immediately so the server records the violation even if
      // the page is about to unload.
      flushEvents();
    } else {
      scheduleFlush();
    }
  }

  function scheduleFlush() {
    if (flushTimer != null) return;
    flushTimer = setTimeout(flushEvents, 1500);
  }

  async function flushEvents() {
    if (flushTimer != null) { clearTimeout(flushTimer); flushTimer = null; }
    if (flushing || eventQueue.length === 0) return;
    flushing = true;
    const batch = eventQueue.splice(0, eventQueue.length);
    try {
      const r = await fetch(urlFor('events_url'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Acmoj-Is-Csrf': 'no',
        },
        body: JSON.stringify({ events: batch }),
      });
      if (r.ok) {
        const data = await r.json();
        updateTabSwitchUi(data.tab_switch_count, data.violation_count);
      } else {
        // Re-queue the batch for the next flush.
        eventQueue.unshift(...batch);
      }
    } catch (e) {
      eventQueue.unshift(...batch);
    } finally {
      flushing = false;
      if (eventQueue.length > 0) scheduleFlush();
    }
  }

  // Heartbeat every 30s also doubles as a flush.
  setInterval(() => {
    queueEvent('heartbeat', 'info');
    flushEvents();
  }, 30000);

  // Best-effort flush on page unload.
  window.addEventListener('pagehide', () => {
    queueEvent('pagehide', 'info');
    // sendBeacon is more reliable than fetch during unload.
    if (eventQueue.length && navigator.sendBeacon) {
      const body = new Blob([JSON.stringify({ events: eventQueue })],
                            { type: 'application/json' });
      navigator.sendBeacon(urlFor('events_url') + '?via=beacon', body);
      eventQueue.length = 0;
    }
  });

  // -------------------------- chunk uploader ---------------------------
  //
  // Each chunk is retried up to MAX_ATTEMPTS times with exponential
  // backoff before the chunk is dropped. While a chunk is in-flight
  // the next one waits in a bounded buffer — MediaRecorder fires
  // dataavailable serially so the buffer stays small in normal
  // operation; we cap to RETRY_BUFFER_MAX as defense against an
  // unreachable upstream that would otherwise grow memory unbounded.
  function makeUploader(kind) {
    const RETRY_BUFFER_MAX = 16;
    const MAX_ATTEMPTS = 4;
    let seq = 0;
    let pending = [];
    let working = false;

    async function attemptOne(item) {
      const url = PROCTOR_URL + '/chunk/' + SID + '/' + kind + '/' + item.mySeq;
      const ctrl = new AbortController();
      const tm = setTimeout(() => ctrl.abort(), 20000);
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/octet-stream',
          },
          body: item.blob,
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return true;
      } catch (e) {
        item.lastError = e && (e.message || String(e));
        return false;
      } finally {
        clearTimeout(tm);
      }
    }

    async function drain() {
      if (working) return;
      working = true;
      while (pending.length > 0) {
        const item = pending[0];
        const ok = await attemptOne(item);
        if (ok) { pending.shift(); continue; }
        item.attempt += 1;
        if (item.attempt >= MAX_ATTEMPTS) {
          // Drop the chunk: better to lose one segment than to
          // backpressure recording forever. Drop is logged.
          queueEvent('client_warning', 'warning', {
            kind, dropped_seq: item.mySeq,
            message: '录像切片重试 ' + MAX_ATTEMPTS +
                     ' 次后丢弃: ' + (item.lastError || ''),
          });
          pending.shift();
          continue;
        }
        // Exponential backoff: 1s, 2s, 4s.
        const delay = 1000 * Math.pow(2, item.attempt - 1);
        await new Promise((r) => setTimeout(r, delay));
      }
      working = false;
    }

    return function (blob) {
      if (!PROCTOR_URL) return;            // misconfigured; skip silently
      if (!blob || !blob.size) return;
      if (pending.length >= RETRY_BUFFER_MAX) {
        // Buffer full → drop the oldest pending. New chunks are
        // more useful for live observation; old ones already had
        // their share of retry attempts.
        pending.shift();
        queueEvent('client_warning', 'warning', {
          kind, message: '上传缓冲区满,丢弃最旧切片',
        });
      }
      pending.push({ blob, attempt: 0, mySeq: seq++ });
      drain();
    };
  }

  // -------------------------- recorder boot ----------------------------
  const recorders = [];

  function pickMime(candidates) {
    for (const m of candidates) {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
  }

  async function startRecorders(cameraStream, screenStream) {
    const camMime = pickMime([
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]);
    const scrMime = pickMime([
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ]);

    if (cameraStream && CFG.record_camera) {
      const rec = new MediaRecorder(cameraStream,
        camMime ? { mimeType: camMime, videoBitsPerSecond: 250000,
                    audioBitsPerSecond: 32000 } : {});
      const up = makeUploader('camera');
      rec.ondataavailable = (e) => up(e.data);
      rec.start(5000);                     // 5s chunks
      recorders.push(rec);
    }
    if (screenStream && CFG.record_screen) {
      // Screen recording target: up to 4K at ~2 Mbps. VP9 compresses
      // screen content (mostly text/code) far better than VP8, so an
      // hour at 4K typically lands around 0.9 GiB; a full 3-hour exam
      // stays comfortably under the 12 GiB per-session cap on proctor2.
      const rec = new MediaRecorder(screenStream,
        scrMime ? { mimeType: scrMime, videoBitsPerSecond: 2_000_000 } : {});
      const up = makeUploader('screen');
      rec.ondataavailable = (e) => up(e.data);
      rec.start(5000);
      recorders.push(rec);
    }

    // If the user stops the screen share via Chrome's "Stop sharing" button,
    // every track on the screen stream will end.
    if (screenStream) {
      for (const t of screenStream.getTracks()) {
        t.addEventListener('ended', () => {
          queueEvent('screen_share_stopped', 'violation');
          showOverlay('screen-stopped');
        });
      }
    }
    if (cameraStream) {
      for (const t of cameraStream.getTracks()) {
        t.addEventListener('ended', () => {
          const kind = t.kind === 'audio' ? 'mic_track_ended' : 'camera_track_ended';
          queueEvent(kind, 'warning');
          // Auto-reacquire. If the device is permanently gone (eg.
          // student unplugged the webcam), reconnectStreams will
          // surface a violation event and the admin will see the
          // session has no camera in the live dashboard.
          reconnectStreams(false, true);
        });
      }
    }
  }

  // -------------------------- visibility / focus -----------------------
  let tabSwitchCount = Number(BOOT.tab_switch_count) || 0;
  let violationCount = Number(BOOT.violation_count) || 0;
  let lastWarnAt = 0;

  function updateTabSwitchUi(serverCount, serverViolations) {
    if (typeof serverCount === 'number') tabSwitchCount = serverCount;
    if (typeof serverViolations === 'number') violationCount = serverViolations;
    const el = document.getElementById('proctor-status');
    if (el) {
      const max = CFG.max_tab_switches;
      el.textContent = '切屏次数 ' + tabSwitchCount +
        (max != null ? '/' + max : '') +
        '   违规 ' + violationCount;
    }
    if (CFG.max_tab_switches != null && tabSwitchCount > CFG.max_tab_switches) {
      // Soft cap exceeded: warn (but don't lock out).
      const now = Date.now();
      if (now - lastWarnAt > 8000) {
        lastWarnAt = now;
        showOverlay('over-limit');
      }
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      queueEvent('visibility_hidden', 'violation');
    } else {
      queueEvent('visibility_visible', 'info');
    }
  });
  window.addEventListener('blur', () => {
    queueEvent('window_blur', 'violation');
  });
  window.addEventListener('focus', () => {
    queueEvent('window_focus', 'info');
  });

  // Informational key combos. We deliberately do NOT count these as
  // violations — Ctrl+S in particular is a no-op the student probably
  // pressed reflexively from another IDE.
  window.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = (e.key || '').toLowerCase();
    if (k === 's' || k === 'p' || k === 'u' || k === 'c' || k === 'v') {
      queueEvent('key_combo', 'info', { combo: (e.ctrlKey ? 'ctrl+' : 'meta+') + k });
      if (k === 's' || k === 'p' || k === 'u') {
        // Suppress browser default for save/print/view-source so the
        // student doesn't accidentally save the page.
        e.preventDefault();
      }
    }
  }, true);

  // -------------------------- paste tracking ----------------------------
  //
  // Recorded for review only — NEVER auto-flagged as violation. A
  // student pasting their own code is normal behaviour; an admin
  // looking at the event log later can decide whether the size or
  // content is suspicious.
  window.addEventListener('paste', (e) => {
    let txt = '';
    try {
      txt = (e.clipboardData || window.clipboardData).getData('text') || '';
    } catch (_) {}
    if (!txt) return;
    queueEvent('paste_detected', 'info', {
      length: txt.length,
      // Keep a small preview so admin can review without reading the
      // whole clipboard. Truncate to 200 chars to bound storage.
      preview: txt.slice(0, 200),
    });
  }, true);

  // -------------------------- fullscreen enforcement --------------------
  let fullscreenWanted = !!CFG.fullscreen_required;

  document.addEventListener('fullscreenchange', () => {
    const inFs = !!document.fullscreenElement;
    queueEvent(inFs ? 'fullscreen_enter' : 'fullscreen_exit',
               inFs ? 'info' : 'violation');
    if (!inFs && fullscreenWanted) showOverlay('fullscreen-required');
  });

  async function requestFullscreen() {
    try { await document.documentElement.requestFullscreen(); } catch (e) {}
  }

  // -------------------------- overlay ----------------------------------
  function ensureOverlay() {
    let el = document.getElementById('proctor-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'proctor-overlay';
    el.style.cssText = [
      'position:fixed', 'inset:0',
      // Soft pink wash (the site brand) over a translucent backdrop —
      // friendlier than the dark grey "modal" look that read as
      // alarming. Still opaque enough to gate interaction.
      'background:linear-gradient(135deg,rgba(231,124,142,0.93),rgba(214,108,128,0.93))',
      'color:#fff', 'z-index:2147483646', 'display:none',
      'flex-direction:column', 'align-items:center', 'justify-content:center',
      'font:16px/1.5 -apple-system,Segoe UI,Helvetica,sans-serif',
      'padding:24px', 'text-align:center',
    ].join(';');
    el.innerHTML = `
      <div id="proctor-overlay-icon" style="font-size:48px;margin-bottom:16px"></div>
      <div id="proctor-overlay-title" style="font-size:22px;font-weight:600;margin-bottom:8px"></div>
      <div id="proctor-overlay-body"  style="max-width:560px;margin-bottom:24px;color:rgba(255,255,255,0.92)"></div>
      <button id="proctor-overlay-action" style="
        padding:10px 28px;font-size:16px;border:0;border-radius:6px;
        background:#fff;color:#e77c8e;font-weight:600;cursor:pointer;
        box-shadow:0 2px 6px rgba(0,0,0,0.15)">操作</button>
    `;
    document.body.appendChild(el);
    return el;
  }

  function showOverlay(reason) {
    const el = ensureOverlay();
    const icon = document.getElementById('proctor-overlay-icon');
    const title = document.getElementById('proctor-overlay-title');
    const body  = document.getElementById('proctor-overlay-body');
    const btn   = document.getElementById('proctor-overlay-action');
    let cfg;
    if (reason === 'fullscreen-required') {
      cfg = {
        icon: '🖥️',
        title: '请保持全屏',
        body: '本场比赛要求全程全屏。点击下方按钮重新进入全屏。',
        button: '重新进入全屏',
        action: async () => { await requestFullscreen(); el.style.display = 'none'; },
      };
    } else if (reason === 'screen-stopped') {
      cfg = {
        icon: '🛑',
        title: '屏幕共享已结束',
        body: '你停止了屏幕共享。请点击按钮重新开始,否则录像记录将中断,本场比赛可能被判定违规。',
        button: '重新开始屏幕共享',
        action: async () => { el.style.display = 'none'; await rebootScreen(); },
      };
    } else if (reason === 'over-limit') {
      const max = CFG.max_tab_switches;
      cfg = {
        icon: '⚠️',
        title: '切屏次数超出限制',
        body: '本场比赛要求切屏不超过 ' + max + ' 次,你目前已切屏 ' +
              tabSwitchCount + ' 次。请回到考试页面,继续切屏将被记录为违规。',
        button: '我知道了',
        action: () => { el.style.display = 'none'; },
      };
    } else if (reason === 'gesture-needed') {
      cfg = {
        icon: '🎥',
        title: '准备开始考试',
        body: '本场比赛启用监考。点击下方按钮授权摄像头和屏幕共享,授权后比赛会立即开始。',
        button: '开始考试',
        action: async () => {
          btn.disabled = true; btn.textContent = '正在请求权限…';
          try {
            await bootMediaAndEnterExam();
            el.style.display = 'none';
          } catch (err) {
            btn.disabled = false; btn.textContent = '重试';
            // err.message may contain attacker-controlled chars (it
            // comes from getUserMedia / API responses). Build the
            // node tree with textContent so HTML is never parsed.
            const msg = err && err.message ? err.message : String(err);
            body.textContent = '';
            body.appendChild(document.createTextNode('权限请求失败:'));
            body.appendChild(document.createElement('br'));
            body.appendChild(document.createTextNode(msg));
            body.appendChild(document.createElement('br'));
            body.appendChild(document.createTextNode(
                '请允许浏览器访问摄像头/屏幕后再点击重试。'));
          }
        },
      };
    } else {
      return;
    }
    icon.textContent = cfg.icon;
    title.textContent = cfg.title;
    // All cfg.body strings are currently static, but using
    // textContent ensures any future dynamic value (e.g. a server-
    // returned reason) can't inject HTML.
    body.textContent = cfg.body;
    btn.textContent = cfg.button;
    btn.onclick = cfg.action;
    btn.disabled = false;
    el.style.display = 'flex';
  }

  // -------------------------- media boot -------------------------------
  let cameraStream = null, screenStream = null;

  // Generic device-reacquire flow. Triggered when a track ends mid-
  // exam — camera unplugged, headphones with built-in mic removed,
  // student stopped screen sharing via Chrome's "Stop sharing" button.
  //
  // Steps:
  //   1. Ask web side to refresh the session — same DB row, new chunk
  //      token, new proctor2 segment counter (so the new MediaRecorder
  //      doesn't corrupt the previous WebM file).
  //   2. Stop the affected recorder(s).
  //   3. Re-call getUserMedia / getDisplayMedia for the dead kinds.
  //   4. Start fresh MediaRecorder(s) on the new stream(s).
  let reconnecting = false;
  async function reconnectStreams(needScreen, needCamera) {
    if (reconnecting) return;
    reconnecting = true;
    try {
      const r = await fetch(BOOT.create_session_url, {
        method: 'POST', credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Acmoj-Is-Csrf': 'no',
        },
        body: JSON.stringify({
          contest_id: BOOT.contest_id,
          client_meta: BOOT.client_meta || {},
        }),
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      token = data.token;
      sessionStorage.setItem(TOKEN_KEY, token);
      // Tear down old recorders for whichever kinds we're reacquiring.
      // Recorders keep streaming chunks until told otherwise, so we
      // explicitly stop them; chunks already pushed during this step
      // land in the previous segment, which is correct.
      for (const rec of recorders) {
        try { rec.stop(); } catch (_) {}
      }
      recorders.length = 0;

      let newCam = needCamera ? null : cameraStream;
      let newScr = needScreen ? null : screenStream;
      if (needCamera && (CFG.require_camera || CFG.record_camera)) {
        try {
          newCam = await navigator.mediaDevices.getUserMedia({
            video: CFG.require_camera ? { width: 320, height: 240, frameRate: 10 } : false,
            audio: !!CFG.require_mic,
          });
        } catch (e) {
          queueEvent('client_error', 'violation',
                     { kind: 'camera', message: 'reacquire failed: ' + e });
        }
      }
      if (needScreen && (CFG.require_screen || CFG.record_screen)) {
        try {
          newScr = await navigator.mediaDevices.getDisplayMedia({
            video: {
              displaySurface: 'monitor',
              width:  { ideal: 3840, max: 3840 },
              height: { ideal: 2160, max: 2160 },
              frameRate: { ideal: 10, max: 15 },
            },
            audio: false,
          });
        } catch (e) {
          queueEvent('client_error', 'violation',
                     { kind: 'screen', message: 'reacquire failed: ' + e });
        }
      }
      cameraStream = newCam;
      screenStream = newScr;
      await startRecorders(cameraStream, screenStream);
      // Re-publish to LiveKit with the fresh tracks; cheaper than
      // diffing individual track replacements and avoids the corner
      // case where a track id changed but the device is the same.
      publishToLiveKit().catch(() => {});
      // Swap remote-view tracks live if an admin is currently watching.
      if (livePeer && livePeer.connectionState !== 'closed') {
        const senders = livePeer.getSenders();
        const replaceFromStream = async (stream) => {
          if (!stream) return;
          for (const t of stream.getTracks()) {
            const sender = senders.find(s => s.track && s.track.kind === t.kind);
            if (sender) { try { await sender.replaceTrack(t); } catch (_) {} }
          }
        };
        await replaceFromStream(cameraStream);
        await replaceFromStream(screenStream);
      }
    } catch (e) {
      queueEvent('client_error', 'violation',
                 { message: 'reconnect failed: ' + (e.message || e) });
    } finally {
      reconnecting = false;
    }
  }

  async function rebootScreen() {
    await reconnectStreams(true, false);
  }

  async function ensureSession() {
    // Already have an active session and a token? Nothing to do.
    if (SID != null && token) return;
    // Run the env check (VM / RDP / software-renderer block) on
    // first entry. On a real student machine this completes in <10
    // ms; on a headless or virtualised one it returns blocked=true
    // and we surface the error before asking for camera permission.
    let envcheck = { blocked: false };
    if (typeof window.ProctorEnvCheck !== 'undefined') {
      try { envcheck = await window.ProctorEnvCheck.run(); }
      catch (e) {
        envcheck = { blocked: true, reasons: [{ label: '环境检测异常: ' + e.message }] };
      }
    }
    if (envcheck.blocked) {
      const labels = (envcheck.reasons || []).map(r => r.label).join('; ');
      throw new Error('环境检测未通过:' + labels +
                      ' — 请在物理机(非虚拟机/远程桌面)上参加考试');
    }
    // Create-or-rejoin: the server treats a POST for a contest that
    // already has an active session as a rotate-token rejoin, so
    // this single call handles both first entry and refresh-after-
    // loss-of-sessionStorage.
    const r = await fetch(BOOT.create_session_url, {
      method: 'POST', credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-Acmoj-Is-Csrf': 'no',
      },
      body: JSON.stringify({
        contest_id: BOOT.contest_id,
        client_meta: {
          userAgent: navigator.userAgent,
          screen: { w: screen.width, h: screen.height, dpr: devicePixelRatio },
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          envcheck,
        },
      }),
    });
    if (!r.ok) throw new Error('创建监考会话失败: HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const data = await r.json();
    SID = data.session_id;
    token = data.token;
    sessionStorage.setItem(tokenKey(), token);
  }

  async function bootMediaAndEnterExam() {
    // First, mint or rejoin the session — this attaches the chunk-
    // upload bearer that the recorder needs.
    await ensureSession();
    // Build media constraints based on what the contest requires.
    const wantsCamera = CFG.require_camera || CFG.record_camera;
    const wantsMic = CFG.require_mic;
    const wantsScreen = CFG.require_screen || CFG.record_screen;

    if (wantsCamera || wantsMic) {
      cameraStream = await navigator.mediaDevices.getUserMedia({
        video: wantsCamera ? { width: 320, height: 240, frameRate: 10 } : false,
        audio: wantsMic,
      });
    }
    if (wantsScreen) {
      // Ask for up to 4K at ~10 fps. Browsers treat these as hints and
      // will return the native resolution if the monitor is smaller —
      // setting an explicit ceiling avoids accidental 8K capture on
      // high-DPI Retina-class displays which would blow the bitrate
      // budget. Low frame-rate is fine for a proctoring stream of
      // mostly-static text and is much friendlier to the encoder.
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',
          width:  { ideal: 3840, max: 3840 },
          height: { ideal: 2160, max: 2160 },
          frameRate: { ideal: 10, max: 15 },
        },
        audio: false,
      });
    }
    await startRecorders(cameraStream, screenStream);
    // Best-effort: also join the LiveKit room so admins can watch live.
    publishToLiveKit().catch(() => {});
    if (fullscreenWanted) await requestFullscreen();

    // Small floating camera preview in the corner so the student can
    // confirm they're being recorded. Wrapped in a collapsible shell —
    // long contests on small laptops, the 160×120 panel sits over the
    // submit button, so let the student tuck it out of the way. State
    // is mirrored to localStorage so it survives page refresh inside
    // the kiosk.
    if (cameraStream && cameraStream.getVideoTracks().length) {
      const wrap = document.createElement('div');
      wrap.id = 'proctor-camera-preview-wrap';
      wrap.style.cssText = [
        'position:fixed', 'right:12px', 'bottom:12px',
        'z-index:2147483645',
        'display:flex', 'flex-direction:column', 'align-items:flex-end',
        'transition:transform .2s ease',
      ].join(';');

      const v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true;
      v.srcObject = cameraStream;
      v.style.cssText = [
        'width:160px', 'height:120px', 'object-fit:cover',
        'border:2px solid #e77c8e', 'border-top:none',
        'border-radius:0 0 6px 6px',
        'background:#000', 'display:block',
      ].join(';');
      v.id = 'proctor-camera-preview';

      const tab = document.createElement('button');
      tab.type = 'button';
      tab.id = 'proctor-camera-preview-toggle';
      tab.style.cssText = [
        'all:unset',
        'background:#e77c8e', 'color:#fff',
        'font:12px/1.4 -apple-system,Segoe UI,Helvetica,sans-serif',
        'padding:3px 10px', 'border-radius:6px 6px 0 0',
        'cursor:pointer', 'user-select:none',
        'box-shadow:0 -1px 4px rgba(0,0,0,.15)',
      ].join(';');
      const STORAGE_KEY = 'proctorCamPreviewCollapsed';
      function applyCollapsed(collapsed) {
        v.style.display = collapsed ? 'none' : 'block';
        tab.textContent = collapsed ? '▴ 自检画面' : '▾ 收起画面';
        tab.style.borderRadius = collapsed ? '6px' : '6px 6px 0 0';
      }
      let collapsed = false;
      try { collapsed = localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) {}
      applyCollapsed(collapsed);
      tab.addEventListener('click', () => {
        collapsed = !collapsed;
        try { localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0'); } catch (e) {}
        applyCollapsed(collapsed);
      });

      wrap.appendChild(tab);
      wrap.appendChild(v);
      document.body.appendChild(wrap);
    }
    openSignalingChannel();
    startSnapshotLoop();
    void captureEnvironmentFingerprint();
  }

  // -------------------------- snapshot loop -----------------------------
  //
  // Every 30 s we snap a JPEG of whichever streams we have and POST
  // the raw bytes to web.py. The server stashes them under
  // oj-proctoring/<sid>/snapshots/. Admins browse them on the session
  // detail page; future work can OCR them offline to look for known
  // forbidden tools (ChatGPT, Cursor, Copilot panels, etc.).
  //
  // We deliberately keep frame rate low (every 30 s, JPEG quality 60)
  // — the live recording is the *primary* evidence; snapshots are
  // just a fast-to-load gallery for the post-exam reviewer.
  const SNAPSHOT_INTERVAL_MS = 30000;
  const SNAPSHOT_MAX_WIDTH = 1280;     // downscale 4K to bound bandwidth

  async function snapshotStream(stream, kind) {
    if (!stream) return;
    const v = stream.getVideoTracks()[0];
    if (!v || v.readyState !== 'live') return;
    let bitmap;
    try {
      const ic = new ImageCapture(v);
      bitmap = await ic.grabFrame();
    } catch (e) {
      // Some browsers/streams don't expose ImageCapture. Fall back to
      // drawing the current frame of an attached <video> element to a
      // canvas — slightly more expensive but works everywhere.
      const tmp = document.createElement('video');
      tmp.muted = true; tmp.playsInline = true;
      tmp.srcObject = new MediaStream([v]);
      await tmp.play().catch(() => {});
      if (!tmp.videoWidth) return;
      const c = document.createElement('canvas');
      const ratio = Math.min(1, SNAPSHOT_MAX_WIDTH / tmp.videoWidth);
      c.width = Math.round(tmp.videoWidth * ratio);
      c.height = Math.round(tmp.videoHeight * ratio);
      c.getContext('2d').drawImage(tmp, 0, 0, c.width, c.height);
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.6));
      tmp.srcObject = null;
      if (blob) postSnapshot(kind, blob);
      return;
    }
    const ratio = Math.min(1, SNAPSHOT_MAX_WIDTH / bitmap.width);
    const w = Math.round(bitmap.width * ratio);
    const h = Math.round(bitmap.height * ratio);
    let blob;
    if (typeof OffscreenCanvas !== 'undefined') {
      const oc = new OffscreenCanvas(w, h);
      oc.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      blob = await oc.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
    } else {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.6));
    }
    if (blob) postSnapshot(kind, blob);
  }

  async function postSnapshot(kind, blob) {
    try {
      await fetch(urlFor('snapshot_url') + '?kind=' + kind, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'image/jpeg',
          'X-Acmoj-Is-Csrf': 'no',
        },
        body: blob,
      });
    } catch (_) {}
  }

  function startSnapshotLoop() {
    setInterval(() => {
      if (screenStream) void snapshotStream(screenStream, 'screen');
      if (cameraStream) void snapshotStream(cameraStream, 'camera');
    }, SNAPSHOT_INTERVAL_MS);
  }

  // -------------------------- environment fingerprint --------------------
  //
  // One-shot scrape on session start; gives admin a snapshot of the
  // student's hardware setup so dual-monitor / virtual-camera setups
  // stand out in the event log.
  async function captureEnvironmentFingerprint() {
    const env = {
      navigator: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        languages: navigator.languages,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory || null,
      },
      screen: {
        w: window.screen.width,
        h: window.screen.height,
        avail_w: window.screen.availWidth,
        avail_h: window.screen.availHeight,
        color_depth: window.screen.colorDepth,
        dpr: window.devicePixelRatio,
        is_extended: window.screen.isExtended || false,
      },
      window: {
        inner_w: window.innerWidth,
        inner_h: window.innerHeight,
        outer_w: window.outerWidth,
        outer_h: window.outerHeight,
      },
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    // Multi-monitor details (Chrome Window Management API). Requires
    // user permission, so we only get it if the user grants — but it
    // tells us exactly how many displays they have.
    if (typeof window.getScreenDetails === 'function') {
      try {
        const perm = await navigator.permissions.query(
          { name: 'window-management' });
        if (perm && perm.state === 'granted') {
          const d = await window.getScreenDetails();
          env.screens = d.screens.map((s) => ({
            w: s.width, h: s.height, primary: s.isPrimary,
            internal: s.isInternal, label: s.label,
          }));
        }
      } catch (_) {}
    }
    // Active video tracks' settings — the screen track's
    // displaySurface tells you whether the student shared a window,
    // a tab, or the entire monitor. label sometimes leaks the
    // application name on Linux/macOS.
    env.media = [];
    for (const [name, stream] of [['camera', cameraStream], ['screen', screenStream]]) {
      if (!stream) continue;
      for (const t of stream.getTracks()) {
        const s = t.getSettings ? t.getSettings() : {};
        env.media.push({
          kind: name, track: t.kind,
          label: t.label, settings: s,
        });
      }
    }
    queueEvent('environment_info', 'info', env);
  }

  // -------------------------- status chip ------------------------------
  function installStatusChip() {
    const el = document.createElement('div');
    el.id = 'proctor-status';
    el.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:12px',
      'background:rgba(231,124,142,0.92)', 'color:#fff',
      'padding:6px 12px', 'border-radius:14px',
      'font:12px/1.4 -apple-system,Segoe UI,Helvetica,sans-serif',
      'z-index:2147483645',
    ].join(';');
    document.body.appendChild(el);
    updateTabSwitchUi();
  }

  // -------------------------- WebRTC: live admin view -------------------
  //
  // The student keeps a single SSE connection to the signaling channel
  // for the lifetime of the session. When an admin opens the live
  // dashboard and clicks "实时观察" on this card, the admin's browser
  // posts {kind:'request_view'} to the signaling channel; we respond
  // by setting up an RTCPeerConnection that re-publishes the existing
  // camera+screen MediaStream tracks. Negotiation is admin-as-offerer
  // (admin starts the SDP exchange) — that way ICE candidates flow
  // either direction without a chicken-and-egg over who knows the
  // other's media constraints first.
  //
  // We never expose this publicly: signaling is gated by the same
  // login that gates /api/proctor/sessions/<id>/events.
  const ICE_CONFIG = {
    iceServers: [
      // School LAN deployments don't need TURN; a free STUN is fine.
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  };
  // session_id of the connection (we have at most one viewer per
  // student in V1 — re-requesting "kicks" the previous viewer).
  let livePeer = null;
  let liveSignalSrc = null;

  async function sendSignal(payload) {
    try {
      await fetch(urlFor('signal_url'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-Acmoj-Is-Csrf': 'no',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {}
  }

  function teardownLivePeer() {
    if (livePeer) {
      try { livePeer.close(); } catch {}
      livePeer = null;
    }
  }

  async function handleAdminSignal(data) {
    // Admin can either request a brand-new connection or push SDP/ICE
    // for the existing one. A 'request_view' tears down the old peer
    // and starts fresh — the admin will then send the SDP offer.
    if (data.kind === 'request_view') {
      teardownLivePeer();
      livePeer = new RTCPeerConnection(ICE_CONFIG);
      livePeer.onicecandidate = (e) => {
        if (e.candidate) sendSignal({ kind: 'ice', candidate: e.candidate });
      };
      livePeer.onconnectionstatechange = () => {
        if (!livePeer) return;
        const s = livePeer.connectionState;
        if (s === 'failed' || s === 'closed' || s === 'disconnected') {
          teardownLivePeer();
        }
      };
      // Add every currently-active track from the streams we already
      // captured for recording. Track IDs do NOT survive WebRTC
      // transmission, but MediaStream IDs do (browsers carry them in
      // the SDP msid attribute). So we tell the admin which stream id
      // is camera and which is screen; the admin matches on
      // e.streams[0].id in its ontrack handler.
      const streamMap = [];
      if (cameraStream) {
        for (const t of cameraStream.getTracks()) {
          livePeer.addTrack(t, cameraStream);
        }
        streamMap.push({ stream_id: cameraStream.id, kind_of: 'camera' });
      }
      if (screenStream) {
        for (const t of screenStream.getTracks()) {
          livePeer.addTrack(t, screenStream);
        }
        streamMap.push({ stream_id: screenStream.id, kind_of: 'screen' });
      }
      await sendSignal({ kind: 'tracks_info', streams: streamMap });
      await sendSignal({ kind: 'ready_to_negotiate' });
    } else if (data.kind === 'sdp' && data.sdp) {
      if (!livePeer) return;
      await livePeer.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        const answer = await livePeer.createAnswer();
        await livePeer.setLocalDescription(answer);
        await sendSignal({ kind: 'sdp', sdp: livePeer.localDescription });
      }
    } else if (data.kind === 'ice' && data.candidate) {
      if (!livePeer) return;
      try { await livePeer.addIceCandidate(data.candidate); } catch (e) {}
    } else if (data.kind === 'end_view') {
      teardownLivePeer();
    }
  }

  function openSignalingChannel() {
    if (liveSignalSrc) return;
    liveSignalSrc = new EventSource(urlFor('signal_stream_url'));
    liveSignalSrc.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      // Ignore our own echoes.
      if (msg.from === 'student') return;
      if (!msg.data) return;
      handleAdminSignal(msg.data).catch(() => {});
    };
    liveSignalSrc.onerror = () => {
      // EventSource auto-reconnects; on persistent failure (session
      // ended, for example) we just give up silently.
    };
  }

  // -------------------------- LiveKit SFU publish ---------------------
  //
  // The admin live page subscribes to the LiveKit room ``contest:<id>``
  // and renders one tile per publisher. Without this code path no one
  // ever joins that room and the dashboard stays black. We mirror the
  // tracks the recorder already holds (cameraStream + screenStream).
  let lkRoom = null;
  let lkClientPromise = null;

  function loadLiveKitClient() {
    if (window.LivekitClient) return Promise.resolve(window.LivekitClient);
    if (lkClientPromise) return lkClientPromise;
    lkClientPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/livekit-client@2.5.10/dist/livekit-client.umd.min.js';
      s.onload = () => resolve(window.LivekitClient);
      s.onerror = (e) => reject(new Error('livekit-client CDN load failed'));
      document.head.appendChild(s);
    });
    return lkClientPromise;
  }

  async function publishToLiveKit() {
    if (!BOOT.livekit_url) return;
    const tokenUrl = urlFor('livekit_token_url');
    if (!tokenUrl) return;
    try {
      const lk = await loadLiveKitClient();
      // Fresh publisher token; the server signs it for canPublish=true.
      const tokResp = await fetch(tokenUrl, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'X-Acmoj-Is-Csrf': 'no' },
      });
      if (!tokResp.ok) throw new Error('token http ' + tokResp.status);
      const tokJson = await tokResp.json();
      const token = tokJson.token;
      const wsUrl = tokJson.url || BOOT.livekit_url;
      if (lkRoom) { try { await lkRoom.disconnect(); } catch (_) {} lkRoom = null; }
      lkRoom = new lk.Room({
        adaptiveStream: true,
        dynacast: true,
        publishDefaults: { simulcast: false },
      });
      await lkRoom.connect(wsUrl, token);
      // Publish every active track from both streams. Tagging the
      // ``source`` field lets the admin tile pick the right thumbnail.
      const pubs = [];
      if (cameraStream) {
        for (const t of cameraStream.getTracks()) {
          pubs.push(lkRoom.localParticipant.publishTrack(t, {
            source: t.kind === 'video' ? lk.Track.Source.Camera : lk.Track.Source.Microphone,
            simulcast: false,
          }));
        }
      }
      if (screenStream) {
        for (const t of screenStream.getTracks()) {
          pubs.push(lkRoom.localParticipant.publishTrack(t, {
            source: lk.Track.Source.ScreenShare,
            simulcast: false,
          }));
        }
      }
      await Promise.all(pubs);
    } catch (e) {
      // Non-fatal: chunk uploads + mesh fallback still work; we just
      // won't be in the LiveKit room. Log to the event stream so it's
      // visible to admins inspecting why a tile is blank.
      queueEvent('client_error', 'warning',
                 { message: 'livekit publish failed: ' + (e.message || e) });
    }
  }

  // -------------------------- bootstrap --------------------------------
  function init() {
    installStatusChip();
    // Show the gesture modal — the actual permission prompts and
    // fullscreen request must originate from the user clicking.
    showOverlay('gesture-needed');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
