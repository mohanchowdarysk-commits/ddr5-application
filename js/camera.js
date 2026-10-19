// Camera scanning: high-resolution video, the phone's built-in barcode reader
// when it has one (Android Chrome, macOS Chrome), otherwise ZXing-C++ compiled
// to WebAssembly (bundled in ./vendor, works offline). Also decodes still photos.

import { loadScript } from './load.js';
import { pickCodes } from './codepick.js';
import { parseScan } from './parser.js';

// The codes found on memory module labels. Fewer formats = faster, fewer false reads.
const FORMATS = ['data_matrix', 'qr_code', 'code_128', 'code_93', 'code_39'];

// Part of the frame we read: the centre, matching the guide box drawn on screen.
const CROP = { x: 0.08, y: 0.12, w: 0.84, h: 0.76 };

let zxingPromise = null;
function getZxing() {
  if (!zxingPromise) {
    zxingPromise = (async () => {
      const api = await loadScript('vendor/barcode-detector.js', 'BarcodeDetectionAPI');
      api.prepareZXingModule({
        overrides: {
          locateFile: (path, prefix) => (path.endsWith('.wasm') ? new URL('vendor/' + path, location.href).href : prefix + path),
        },
      });
      const supported = await api.BarcodeDetector.getSupportedFormats();
      return new api.BarcodeDetector({ formats: FORMATS.filter((f) => supported.includes(f)) });
    })().catch((e) => {
      zxingPromise = null;
      throw e;
    });
  }
  return zxingPromise;
}

async function getNative() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const supported = await window.BarcodeDetector.getSupportedFormats();
    const formats = FORMATS.filter((f) => supported.includes(f));
    if (!formats.includes('data_matrix') || !formats.includes('code_128')) return null;
    return new window.BarcodeDetector({ formats });
  } catch {
    return null;
  }
}

export function inAppBrowser() {
  return /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|LinkedInApp|Twitter|; wv\)|GSA\//i.test(navigator.userAgent || '');
}

// Why the camera can't start here, before even asking: null when it can.
export function cameraProblem() {
  if (!window.isSecureContext) return 'insecure';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return inAppBrowser() ? 'inapp' : 'unsupported';
  return null;
}

export function errorKind(e) {
  const n = (e && e.name) || '';
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return inAppBrowser() ? 'inapp' : 'denied';
  if (n === 'NotFoundError' || n === 'DevicesNotFoundError' || n === 'OverconstrainedError') return 'nocamera';
  if (n === 'NotReadableError' || n === 'TrackStartError' || n === 'AbortError') return 'busy';
  // In-app browsers fail in many different ways; the fix is always the same.
  if (inAppBrowser()) return 'inapp';
  if (n === 'NotSupportedError') return 'unsupported';
  return 'other';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class CameraScanner {
  constructor({ video, overlay, rules, onPick, onStatus }) {
    this.video = video;
    this.overlay = overlay;
    this.rules = rules;
    this.onPick = onPick;
    this.onStatus = onStatus || (() => {});
    this.stream = null;
    this.track = null;
    this.running = false;
    this.engine = '';
    this.seen = new Map(); // text -> { first, last }
    this.used = new Map(); // text -> last seen while blocked
    this.canvas = document.createElement('canvas');
    this.lastAsk = '';
  }

  async open(deviceId) {
    const base = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const tries = deviceId
      ? [{ video: { ...base, deviceId: { exact: deviceId } } }, { video: { deviceId: { exact: deviceId } } }]
      : [{ video: { ...base, facingMode: { ideal: 'environment' } } }, { video: { facingMode: { ideal: 'environment' } } }, { video: true }];
    let last;
    for (const c of tries) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: false, ...c });
      } catch (e) {
        last = e;
        if (!['OverconstrainedError', 'ConstraintNotSatisfiedError', 'TypeError', 'NotFoundError'].includes(e.name)) throw e;
      }
    }
    throw last;
  }

  async start(deviceId) {
    this.stream = await this.open(deviceId);
    this.track = this.stream.getVideoTracks()[0];
    const v = this.video;
    v.setAttribute('playsinline', '');
    v.muted = true;
    v.srcObject = this.stream;
    await v.play().catch(() => {});
    await this.focus('continuous');
    // Phones can't focus closer than ~10–20 cm; a 2× zoom lets you hold the phone there and still
    // get a big, sharp code (the trick dedicated barcode apps use).
    const caps = this.capabilities();
    if (caps.zoom && caps.zoom.max >= 1.5) {
      const want = Number(localStorage.getItem('ddr.camZoom')) || Math.min(2, caps.zoom.max);
      await this.setZoom(Math.max(caps.zoom.min, Math.min(caps.zoom.max, want)));
    }
    this.native = await getNative();
    this.engine = this.native ? 'built-in reader' : 'ZXing';
    if (!this.native) await getZxing();
    this.running = true;
    this.loop();
    return this.engine;
  }

  capabilities() {
    try {
      return (this.track && this.track.getCapabilities && this.track.getCapabilities()) || {};
    } catch {
      return {};
    }
  }

  settings() {
    try {
      return (this.track && this.track.getSettings && this.track.getSettings()) || {};
    } catch {
      return {};
    }
  }

  async focus(mode) {
    const caps = this.capabilities();
    if (caps.focusMode && caps.focusMode.includes(mode)) {
      await this.track.applyConstraints({ advanced: [{ focusMode: mode }] }).catch(() => {});
    }
  }

  async refocus() {
    await this.focus('single-shot');
    setTimeout(() => this.focus('continuous'), 800);
  }

  async setZoom(z) {
    await this.track.applyConstraints({ advanced: [{ zoom: z }] }).catch(() => {});
  }

  async setTorch(on) {
    await this.track.applyConstraints({ advanced: [{ torch: !!on }] }).catch(() => {});
  }

  async detect(source) {
    let found = [];
    if (this.native) {
      found = await this.native.detect(source).catch(() => []);
      // The built-in reader occasionally misses tiny 2D codes; give ZXing a turn now and then.
      if (!found.length && ++this.frame % 4 === 0) found = await (await getZxing()).detect(source).catch(() => []);
    } else {
      found = await (await getZxing()).detect(source).catch(() => []);
    }
    return found;
  }

  async loop() {
    this.frame = 0;
    while (this.running) {
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) {
        const W = v.videoWidth;
        const H = v.videoHeight;
        const cx = Math.round(W * CROP.x);
        const cy = Math.round(H * CROP.y);
        const cw = Math.round(W * CROP.w);
        const ch = Math.round(H * CROP.h);
        this.canvas.width = cw;
        this.canvas.height = ch;
        const g = this.canvas.getContext('2d', { willReadFrequently: true });
        g.drawImage(v, cx, cy, cw, ch, 0, 0, cw, ch);
        const found = await this.detect(this.canvas);
        if (!this.running) break;
        this.draw(found, cx, cy, W, H);
        this.consider(found.map((f) => f.rawValue).filter(Boolean));
      }
      await sleep(this.native ? 60 : 90);
    }
  }

  draw(found, ox, oy, W, H) {
    const o = this.overlay;
    if (!o) return;
    if (o.width !== W || o.height !== H) {
      o.width = W;
      o.height = H;
    }
    const g = o.getContext('2d');
    g.clearRect(0, 0, W, H);
    g.lineWidth = Math.max(3, W / 300);
    g.strokeStyle = '#1baf7a';
    for (const f of found) {
      const p = f.cornerPoints;
      if (!p || !p.length) continue;
      g.beginPath();
      g.moveTo(p[0].x + ox, p[0].y + oy);
      for (let i = 1; i < p.length; i++) g.lineTo(p[i].x + ox, p[i].y + oy);
      g.closePath();
      g.stroke();
    }
  }

  // Combine what is visible over the last moment into one decision.
  consider(texts) {
    const now = Date.now();
    // One label = one scan, like a checkout: after adding, ignore everything on this label until
    // the view is clear for a moment, or a different module's full code shows up.
    if (this.lock) {
      const fresh = texts.find((t) => /\(S\)/i.test(t) && !this.used.has(t) && parseScan(t, this.rules).serial !== this.lock.serial);
      if (fresh) this.lock = null;
      else if (texts.length) this.lock.clearSince = 0;
      else if (!this.lock.clearSince) this.lock.clearSince = now;
      else if (now - this.lock.clearSince > 450) this.lock = null;
      if (this.lock) {
        for (const t of texts) this.used.set(t, now);
        this.onStatus('added');
        return;
      }
    }
    for (const t of texts) {
      const s = this.seen.get(t);
      if (s && now - s.last < 700) s.last = now;
      else this.seen.set(t, { first: now, last: now });
      if (this.used.has(t)) this.used.set(t, now);
    }
    for (const [t, s] of this.seen) if (now - s.last > 700) this.seen.delete(t);
    // A code stays blocked after it was added until it has been out of view for a moment.
    for (const [t, last] of this.used) if (now - last > 1500) this.used.delete(t);

    const visible = [...this.seen.keys()].filter((t) => !this.used.has(t));
    if (!visible.length) {
      this.onStatus(this.used.size ? 'added' : 'looking');
      this.lastAsk = '';
      return;
    }
    const firstSeen = Math.min(...visible.map((t) => this.seen.get(t).first));
    const d = pickCodes(visible, { rules: this.rules, aloneMs: now - firstSeen });
    if (d.action === 'add') {
      for (const t of visible) this.used.set(t, now);
      this.lastAsk = '';
      this.lock = { serial: parseScan(d.raw, this.rules).serial, clearSince: 0 };
      this.seen.clear();
      this.onPick(d.raw, d.how);
    } else if (d.action === 'ask') {
      const key = visible.join('|');
      if (key !== this.lastAsk) {
        this.lastAsk = key;
        this.onStatus('ask', { raw: d.raw, reason: d.reason, codes: visible });
      }
    } else {
      this.onStatus(d.reason === 'part-only' ? 'part-only' : 'reading');
    }
  }

  // Treat the codes currently in view as handled (after "Add anyway" / "Ignore").
  dismiss(codes) {
    const now = Date.now();
    for (const t of codes) this.used.set(t, now);
    this.lastAsk = '';
  }

  async cameras() {
    try {
      return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch {
      return [];
    }
  }

  stop() {
    this.running = false;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.track = null;
    if (this.video) this.video.srcObject = null;
    if (this.overlay) this.overlay.getContext('2d').clearRect(0, 0, this.overlay.width, this.overlay.height);
  }
}

// Decode every code in a photo taken with the phone's camera app.
export async function decodePhoto(file) {
  const bmp = await createImageBitmap(file);
  const tries = [];
  // Full size first (tiny codes), then a smaller copy (huge photos can be slow or blurry at 1:1).
  for (const max of [3000, 1400]) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (tries.some((t) => t === scale)) continue;
    tries.push(scale);
  }
  const native = await getNative();
  const zx = await getZxing();
  const texts = new Set();
  for (const scale of tries) {
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    for (const d of [native, zx]) {
      if (!d) continue;
      const found = await d.detect(c).catch(() => []);
      for (const f of found) if (f.rawValue) texts.add(f.rawValue);
    }
    if (texts.size) break;
  }
  return [...texts];
}
