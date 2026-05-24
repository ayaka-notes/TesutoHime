/* proctor-envcheck.js — pre-flight VM / remote-desktop detector.
 *
 * Exposes window.ProctorEnvCheck.run() → Promise<Verdict>
 *   Verdict = {
 *     blocked: boolean,           // true → setup page must refuse entry
 *     confidence: 'high'|'medium'|'low'|'clean',
 *     reasons: Reason[],          // human-readable list for the UI
 *     details: object,            // raw probe output, attached to the
 *                                 // session client_meta on creation
 *   }
 *
 * What we detect:
 *
 *   - VMs: WebGL UNMASKED_RENDERER_WEBGL containing 'VMware', 'VirtualBox',
 *     'Parallels', 'QEMU', 'Hyper-V', or any software rasterizer
 *     (llvmpipe / SwiftShader / Mesa Offscreen / Microsoft Basic).
 *     These strings are the smoking gun — real GPUs identify themselves
 *     differently. The check loses signal only when the VM exposes a
 *     passthrough GPU, which is uncommon and itself a strong indicator
 *     the user is going to extreme lengths.
 *
 *   - RDP / VNC / virtual desktops: Renderer strings 'Microsoft Basic
 *     Render Driver' or 'Microsoft Remote Display Adapter'; sometimes
 *     'Microsoft Hyper-V Video' under Azure/AWS RDS sessions.
 *
 *   - Software rasterizer fallback: even without a VM, browsers may
 *     fall back to llvmpipe/SwiftShader when GPU drivers are missing —
 *     also a sign of a containerised / headless / RDP environment.
 *
 * What we do NOT do:
 *   - Browser-fingerprint a real machine vs a real machine. Privacy.
 *   - Timing-attack the hypervisor (unreliable, easily spoofed).
 *
 * Bypass risk: client-side detection is bypassable by a determined
 * adversary (they can spoof WebGL with a Chrome flag or a custom
 * build). The server still records the probe result, so a session
 * with a tampered probe leaves an audit trail.
 */
(function () {
  'use strict';

  // Substring matches against the lowercased WebGL renderer/vendor pair.
  // Each entry: [needle, label, severity]. severity 'block' means we
  // refuse exam entry; 'warn' means we let them in but flag the
  // session for review.
  const PATTERNS = [
    ['vmware',                        'VMware',                  'block'],
    ['virtualbox',                    'VirtualBox',              'block'],
    ['vbox',                          'VirtualBox',              'block'],
    ['parallels',                     'Parallels',               'block'],
    ['qemu',                          'QEMU',                    'block'],
    ['microsoft basic render',        'Microsoft Basic Renderer (软件渲染 / RDP)', 'block'],
    ['microsoft remote display',      'Microsoft Remote Display Adapter (远程桌面)', 'block'],
    ['hyper-v',                       'Hyper-V',                 'block'],
    ['llvmpipe',                      'llvmpipe (软件渲染)',     'block'],
    ['swiftshader',                   'Google SwiftShader (软件渲染)', 'block'],
    ['mesa offscreen',                'Mesa Offscreen (软件渲染)', 'block'],
    ['software rasterizer',           '软件光栅化器',            'block'],
    ['citrix',                        'Citrix Virtual Display',  'block'],
    ['vnc',                           'VNC',                     'block'],
    ['nomachine',                     'NoMachine',               'block'],
    ['xen',                           'Xen 虚拟机',              'block'],
    // Browsers in headless mode use SwiftShader by default, which the
    // patterns above already catch. We add explicit headless markers
    // so an admin auditing the log can tell why the probe fired.
    ['headlesschrome',                'Headless Chrome',         'block'],
  ];

  function probeWebGL() {
    const out = { renderer: null, vendor: null, version: null, extensions: null };
    let gl;
    try {
      const c = document.createElement('canvas');
      gl = c.getContext('webgl', { failIfMajorPerformanceCaveat: false })
        || c.getContext('experimental-webgl');
    } catch (e) {}
    if (!gl) {
      out.error = 'no webgl';
      return out;
    }
    try {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      if (ext) {
        out.renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || null;
        out.vendor   = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   || null;
      }
      out.version = gl.getParameter(gl.VERSION) || null;
      // List a small subset of extensions so a stripped-down VM stack
      // looks visibly different in the log from a real GPU.
      const exts = gl.getSupportedExtensions() || [];
      out.extensions = exts.slice(0, 8);
    } catch (e) {}
    return out;
  }

  function probeMisc() {
    const out = {};
    out.user_agent = navigator.userAgent;
    out.platform = navigator.platform;
    out.cores = navigator.hardwareConcurrency;
    out.memory_gb = navigator.deviceMemory || null;
    out.screen = {
      w: window.screen.width, h: window.screen.height,
      dpr: window.devicePixelRatio,
      color_depth: window.screen.colorDepth,
      is_extended: window.screen.isExtended || false,
    };
    // Battery API is gone in many browsers, but if present a virtual
    // server typically reports level=1, charging=true forever — we
    // record but don't act on it.
    out.has_touch = 'ontouchstart' in window;
    return out;
  }

  function classify(detail) {
    const reasons = [];
    const renderer = (detail.webgl && detail.webgl.renderer) || '';
    const vendor = (detail.webgl && detail.webgl.vendor) || '';
    const hay = (renderer + ' ' + vendor).toLowerCase();
    let block = false;
    for (const [needle, label, sev] of PATTERNS) {
      if (hay.includes(needle)) {
        reasons.push({ source: 'webgl', label, matched: needle, severity: sev });
        if (sev === 'block') block = true;
      }
    }
    // No GPU at all → headless / very-minimal VM → block.
    if (!renderer && !vendor) {
      reasons.push({
        source: 'webgl',
        label: '未能读取显卡信息(可能为虚拟机 / 远程桌面 / 浏览器异常)',
        severity: 'block',
      });
      block = true;
    }
    // Multi-monitor detection — `screen.isExtended` is the cheap
    // standardised signal (Chrome ≥100, Edge, Firefox 116+). True
    // means the operating system has at least one secondary display
    // attached. Proctoring policy: only one display allowed.
    if (detail.misc && detail.misc.screen && detail.misc.screen.is_extended) {
      reasons.push({
        source: 'multi-monitor',
        label: '检测到多个显示器/扩展屏。考试期间只允许使用单个显示器,请拔掉副屏后重试。',
        severity: 'block',
      });
      block = true;
    }
    let confidence = 'clean';
    if (block) {
      confidence = reasons.length >= 2 ? 'high' : 'medium';
    } else if (reasons.length > 0) {
      confidence = 'low';
    }
    return { blocked: block, confidence, reasons };
  }

  async function run() {
    const detail = {
      webgl: probeWebGL(),
      misc: probeMisc(),
    };
    const v = classify(detail);
    v.details = detail;
    return v;
  }

  window.ProctorEnvCheck = { run };
})();
