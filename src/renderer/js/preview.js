// Real-time timeline preview: canvas compositing + Web Audio mixing.
// The math mirrors src/main/exporter.js so what you see is what you export.
import { sourceTime } from './state.js';

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class Preview {
  constructor(store, { canvas, wrap, stage, pool, transformBox, meterL, meterR }) {
    this.store = store;
    this.canvas = canvas;
    this.ctx2d = canvas.getContext('2d');
    this.wrap = wrap;
    this.stage = stage;
    this.pool = pool;
    this.box = transformBox;
    this.meterEls = [meterL, meterR];
    this.zoom = 'fit';
    this.quality = 1;
    this.playing = false;
    this.els = new Map(); // clipId -> { el, gain, mediaId, kind }
    this.images = new Map(); // mediaId -> HTMLImageElement
    this.needsDraw = true;
    this.listeners = new Set();

    Object.assign(pool.style, { position: 'fixed', left: '-20px', top: '-20px', width: '2px', height: '2px', overflow: 'hidden', opacity: '0', pointerEvents: 'none' });
    pool.classList.remove('hidden');

    this.audio = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.audio.createGain();
    const splitter = this.audio.createChannelSplitter(2);
    this.analysers = [this.audio.createAnalyser(), this.audio.createAnalyser()];
    this.analysers.forEach((a, i) => { a.fftSize = 1024; splitter.connect(a, i); });
    this.master.connect(splitter);
    this.master.connect(this.audio.destination);
    this.meterBuf = new Float32Array(1024);

    new ResizeObserver(() => this.layout()).observe(stage);
    store.on((what) => {
      if (what === 'edit' || what === 'load') { this.syncElements(); this.layout(); }
      if (!this.playing) this.needsDraw = true;
    });
    this.setupTransformBox();
    this.tick = this.tick.bind(this);
    requestAnimationFrame(this.tick);
  }

  onState(fn) { this.listeners.add(fn); }
  emitState() { for (const fn of this.listeners) fn(this.playing); }

  // ---------- layout ----------
  layout() {
    const { width: W, height: H } = this.store.project.settings;
    const pad = 24;
    const sw = this.stage.clientWidth - pad, sh = this.stage.clientHeight - pad;
    const scale = this.zoom === 'fit' ? Math.min(sw / W, sh / H) : Number(this.zoom);
    const cssW = Math.max(16, Math.round(W * scale)), cssH = Math.max(16, Math.round(H * scale));
    this.wrap.style.width = cssW + 'px';
    this.wrap.style.height = cssH + 'px';
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min(1, (cssW * dpr) / W) * this.quality;
    this.canvas.width = Math.max(2, Math.round(W * k));
    this.canvas.height = Math.max(2, Math.round(H * k));
    this.cssScale = cssW / W;
    this.needsDraw = true;
  }
  setZoom(z) { this.zoom = z; this.layout(); }
  setQuality(q) { this.quality = Number(q); this.layout(); }

  // ---------- media elements ----------
  imageFor(media) {
    let img = this.images.get(media.id);
    if (!img) {
      img = new Image();
      img.onload = () => { this.needsDraw = true; };
      img.src = window.mc.mediaUrl(media.path);
      this.images.set(media.id, img);
    }
    return img;
  }
  syncElements() {
    const p = this.store.project;
    const keep = new Set();
    for (const c of p.clips) {
      const m = this.store.media(c.mediaId);
      const t = this.store.track(c.trackId);
      if (!m || !t || m.missing) continue;
      if (m.type === 'image') { this.imageFor(m); continue; }
      const kind = t.kind === 'video' ? 'video' : 'audio';
      let rec = this.els.get(c.id);
      if (rec && (rec.mediaId !== m.id || rec.kind !== kind)) { this.dropElement(c.id); rec = null; }
      if (!rec) rec = this.makeElement(c.id, m, kind);
      keep.add(c.id);
    }
    for (const id of [...this.els.keys()]) if (!keep.has(id)) this.dropElement(id);
  }
  makeElement(clipId, media, kind) {
    const el = document.createElement(kind === 'video' && media.type === 'video' ? 'video' : 'audio');
    el.preload = 'auto';
    el.playsInline = true;
    el.src = window.mc.mediaUrl(media.path);
    el.addEventListener('seeked', () => { this.needsDraw = true; });
    el.addEventListener('loadeddata', () => { this.needsDraw = true; });
    this.pool.appendChild(el);
    let gain = null;
    if (media.hasAudio) {
      const src = this.audio.createMediaElementSource(el);
      gain = this.audio.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(this.master);
    } else el.muted = true;
    const rec = { el, gain, mediaId: media.id, kind };
    this.els.set(clipId, rec);
    return rec;
  }
  dropElement(id) {
    const rec = this.els.get(id);
    if (!rec) return;
    rec.el.pause();
    rec.el.removeAttribute('src');
    rec.el.load();
    rec.el.remove();
    if (rec.gain) rec.gain.disconnect();
    this.els.delete(id);
  }
  /** Re-create elements for a media item after it was relinked. */
  refreshMedia(mediaId) {
    for (const [id, rec] of [...this.els]) if (rec.mediaId === mediaId) this.dropElement(id);
    this.images.delete(mediaId);
    this.syncElements();
  }

  // ---------- transport ----------
  async play() {
    if (this.playing) return;
    const dur = this.store.duration();
    if (dur <= 0) return;
    if (this.store.playhead >= dur - 0.01) this.store.setPlayhead(0);
    await this.audio.resume();
    this.playing = true;
    this.t0 = performance.now();
    this.startPos = this.store.playhead;
    this.emitState();
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const rec of this.els.values()) rec.el.pause();
    this.needsDraw = true;
    this.emitState();
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  /** Called when the user moves the playhead while playing. */
  resync() { if (this.playing) { this.t0 = performance.now(); this.startPos = this.store.playhead; } }

  tick() {
    requestAnimationFrame(this.tick);
    let t = this.store.playhead;
    if (this.playing) {
      t = this.startPos + (performance.now() - this.t0) / 1000;
      const end = this.store.duration();
      if (t >= end) { t = end; this.store.setPlayhead(t); this.pause(); }
      else this.store.setPlayhead(t);
    }
    this.syncMedia(t);
    if (this.playing || this.needsDraw) { this.draw(t); this.needsDraw = false; }
    this.updateMeters();
  }

  audibleTrack(track) {
    const tracks = this.store.project.tracks;
    const anySolo = tracks.some((x) => x.solo);
    return !track.muted && (!anySolo || track.solo);
  }

  syncMedia(t) {
    const fps = this.store.project.settings.fps;
    for (const [id, rec] of this.els) {
      const c = this.store.clip(id);
      if (!c) continue;
      const track = this.store.track(c.trackId);
      const el = rec.el;
      const active = t >= c.start && t < c.start + c.duration;
      const visibleNeeded = rec.kind === 'video' && !track.hidden;
      const audible = this.audibleTrack(track) && !c.muted && !(rec.kind === 'video' && c.audioDetached);
      if (!active) {
        if (!el.paused) el.pause();
        if (rec.gain) rec.gain.gain.value = 0;
        // Pre-roll the next clip so cuts are clean.
        if (t < c.start && c.start - t < 1.5 && el.readyState >= 1 && !el.seeking) {
          const s0 = sourceTime(c, c.start);
          if (Math.abs(el.currentTime - s0) > 0.05) el.currentTime = s0;
        }
        continue;
      }
      if (!visibleNeeded && !audible) { if (!el.paused) el.pause(); if (rec.gain) rec.gain.gain.value = 0; continue; }
      const src = sourceTime(c, t);
      if (this.playing && !c.reversed) {
        const rate = clamp(c.speed, 0.0625, 16);
        if (el.playbackRate !== rate) el.playbackRate = rate;
        el.preservesPitch = true;
        if (el.paused) { el.currentTime = src; el.play().catch(() => {}); }
        else if (Math.abs(el.currentTime - src) > 0.3) el.currentTime = src;
      } else {
        if (!el.paused) el.pause();
        if (!el.seeking && el.readyState >= 1 && Math.abs(el.currentTime - src) > 0.5 / fps) el.currentTime = src;
      }
      if (rec.gain) {
        const local = t - c.start;
        let g = c.volume * (track.volume ?? 1);
        if (c.fadeIn > 0 && local < c.fadeIn) g *= local / c.fadeIn;
        if (c.fadeOut > 0 && local > c.duration - c.fadeOut) g *= Math.max(0, (c.duration - local) / c.fadeOut);
        if (!audible || !this.playing || c.reversed || this.monitorMuted) g = 0;
        rec.gain.gain.setTargetAtTime(g, this.audio.currentTime, 0.01);
      }
    }
  }

  // ---------- drawing ----------
  sourceFor(c) {
    const m = this.store.media(c.mediaId);
    if (!m) return null;
    if (m.type === 'image') {
      const img = this.imageFor(m);
      return img.complete && img.naturalWidth ? { src: img, w: img.naturalWidth, h: img.naturalHeight } : null;
    }
    const rec = this.els.get(c.id);
    if (!rec || rec.el.readyState < 2 || !rec.el.videoWidth) return null;
    return { src: rec.el, w: rec.el.videoWidth, h: rec.el.videoHeight };
  }

  /** Same layout rules as the exporter: crop -> fit/fill/stretch -> scale. */
  layoutOf(c, w, h, W, H) {
    const cw = w * (1 - c.crop.l - c.crop.r), ch = h * (1 - c.crop.t - c.crop.b);
    let dw, dh;
    if (c.fit === 'stretch') { dw = W; dh = H; } else {
      const k = c.fit === 'fill' ? Math.max(W / cw, H / ch) : Math.min(W / cw, H / ch);
      dw = cw * k; dh = ch * k;
    }
    return { dw: dw * c.scale, dh: dh * c.scale, cx: W / 2 + c.x * W, cy: H / 2 + c.y * H, cw, ch };
  }

  activeVisualClips(t) {
    const p = this.store.project;
    const vtracks = p.tracks.filter((tr) => tr.kind === 'video' && !tr.hidden);
    const out = [];
    for (let i = vtracks.length - 1; i >= 0; i--) { // bottom track first
      for (const c of p.clips) {
        if (c.trackId === vtracks[i].id && t >= c.start && t < c.start + c.duration) out.push(c);
      }
    }
    return out;
  }

  draw(t) {
    const g = this.ctx2d;
    const W = this.canvas.width, H = this.canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.filter = 'none';
    g.fillStyle = this.store.project.settings.background || '#000';
    g.fillRect(0, 0, W, H);
    for (const c of this.activeVisualClips(t)) {
      const s = this.sourceFor(c);
      if (!s) continue;
      const L = this.layoutOf(c, s.w, s.h, W, H);
      g.save();
      g.translate(L.cx, L.cy);
      if (c.rotation) g.rotate((c.rotation * Math.PI) / 180);
      g.scale(c.flipH ? -1 : 1, c.flipV ? -1 : 1);
      g.globalAlpha = clamp(c.opacity, 0, 1);
      const f = [];
      if (c.brightness) f.push(`brightness(${clamp(1 + c.brightness * 1.6, 0, 3)})`);
      if (c.contrast !== 1) f.push(`contrast(${c.contrast})`);
      if (c.saturation !== 1) f.push(`saturate(${c.saturation})`);
      g.filter = f.length ? f.join(' ') : 'none';
      g.drawImage(s.src, s.w * c.crop.l, s.h * c.crop.t, L.cw, L.ch, -L.dw / 2, -L.dh / 2, L.dw, L.dh);
      g.restore();
    }
    this.updateTransformBox(t);
  }

  updateMeters() {
    for (let i = 0; i < 2; i++) {
      this.analysers[i].getFloatTimeDomainData(this.meterBuf);
      let peak = 0;
      for (const v of this.meterBuf) peak = Math.max(peak, Math.abs(v));
      const db = 20 * Math.log10(peak || 1e-6);
      const pct = clamp((db + 48) / 48, 0, 1);
      this.meterEls[i].style.clipPath = `inset(0 ${100 - pct * 100}% 0 0)`;
    }
  }

  // ---------- on-canvas transform (move / scale the selected clip) ----------
  selectedVisual(t) {
    const sel = this.store.selectedClips();
    if (sel.length !== 1) return null;
    const c = sel[0];
    const tr = this.store.track(c.trackId);
    if (!tr || tr.kind !== 'video' || t < c.start || t >= c.start + c.duration) return null;
    return c;
  }
  updateTransformBox(t) {
    const c = this.selectedVisual(t);
    const s = c && this.sourceFor(c);
    if (!s) { this.box.classList.add('hidden'); return; }
    const { width: W, height: H } = this.store.project.settings;
    const L = this.layoutOf(c, s.w, s.h, W, H);
    const k = this.cssScale;
    Object.assign(this.box.style, {
      left: (L.cx - L.dw / 2) * k + 'px', top: (L.cy - L.dh / 2) * k + 'px',
      width: L.dw * k + 'px', height: L.dh * k + 'px',
      transform: `rotate(${c.rotation || 0}deg)`,
    });
    this.box.classList.remove('hidden');
  }
  setupTransformBox() {
    const handle = this.box.querySelector('.handle');
    this.box.addEventListener('pointerdown', (e) => {
      const c = this.selectedVisual(this.store.playhead);
      if (!c || this.store.track(c.trackId).locked) return;
      e.preventDefault();
      e.stopPropagation();
      this.box.setPointerCapture(e.pointerId);
      const { width: W, height: H } = this.store.project.settings;
      const k = this.cssScale;
      const sx = e.clientX, sy = e.clientY;
      const start = { x: c.x, y: c.y, scale: c.scale };
      const scaling = e.target === handle;
      const rect = this.box.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const d0 = Math.hypot(sx - cx, sy - cy) || 1;
      this.store.beginLive();
      const move = (ev) => {
        if (scaling) {
          c.scale = clamp(start.scale * (Math.hypot(ev.clientX - cx, ev.clientY - cy) / d0), 0.02, 20);
        } else {
          let nx = start.x + (ev.clientX - sx) / k / W;
          let ny = start.y + (ev.clientY - sy) / k / H;
          if (!ev.altKey) { if (Math.abs(nx) < 0.01) nx = 0; if (Math.abs(ny) < 0.01) ny = 0; } // snap to centre
          c.x = nx; c.y = ny;
        }
        this.needsDraw = true;
        this.store.emit('live');
      };
      const up = () => {
        this.box.removeEventListener('pointermove', move);
        this.box.removeEventListener('pointerup', up);
        this.store.endLive(scaling ? 'Scale clip' : 'Move clip');
      };
      this.box.addEventListener('pointermove', move);
      this.box.addEventListener('pointerup', up);
    });
  }

  /** Grab the current preview frame as a data URL (used for snapshots). */
  snapshot() { return this.canvas.toDataURL('image/png'); }
}
