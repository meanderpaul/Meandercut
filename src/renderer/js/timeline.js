// Multi-track timeline UI.
import { clearRange, snapPoints, maxDuration, newClip, formatTime, uid, EPS } from './state.js';

const SNAP_PX = 8;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const h = (tag, cls, attrs = {}) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') el.textContent = v; else if (k === 'style') Object.assign(el.style, v); else el.setAttribute(k, v);
  }
  return el;
};

export class Timeline {
  constructor(store, preview, els, ui) {
    this.store = store;
    this.preview = preview;
    this.ui = ui; // { toast, onMediaDrop }
    Object.assign(this, els); // scroll, inner, ruler, lanes, headerList, playhead, snapLine, zoomSlider, durationLabel, snapBtn
    this.pps = 60; // pixels per second
    this.snapping = true;
    this.zoomFromSlider(Number(this.zoomSlider.value));

    store.on((what) => {
      if (what === 'playhead') this.updatePlayhead();
      else this.render();
    });
    this.zoomSlider.addEventListener('input', () => { this.zoomFromSlider(Number(this.zoomSlider.value), true); });
    this.scroll.addEventListener('scroll', () => { this.headerList.scrollTop = this.scroll.scrollTop; });
    this.scroll.addEventListener('wheel', (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX);
      }
    }, { passive: false });
    this.snapBtn.addEventListener('click', () => this.toggleSnap());
    this.setupRuler();
    this.setupLaneEvents();
    this.render();
  }

  // ---------- zoom ----------
  zoomFromSlider(v, keepPlayhead = false) {
    const old = this.pps;
    this.pps = 4 * Math.pow(150, v / 100);
    if (keepPlayhead) {
      const px = this.store.playhead * old - this.scroll.scrollLeft;
      this.render();
      this.scroll.scrollLeft = this.store.playhead * this.pps - px;
    } else this.render();
  }
  sliderFromPps() { this.zoomSlider.value = String(clamp(Math.log(this.pps / 4) / Math.log(150) * 100, 0, 100)); }
  zoomAt(factor, clientX) {
    const rect = this.scroll.getBoundingClientRect();
    const x = clientX - rect.left;
    const t = (this.scroll.scrollLeft + x) / this.pps;
    this.pps = clamp(this.pps * factor, 4, 600);
    this.sliderFromPps();
    this.render();
    this.scroll.scrollLeft = t * this.pps - x;
  }
  zoomIn() { this.zoomAt(1.4, this.playheadClientX()); }
  zoomOut() { this.zoomAt(1 / 1.4, this.playheadClientX()); }
  zoomFit() {
    const d = Math.max(5, this.store.duration());
    this.pps = clamp((this.scroll.clientWidth - 40) / d, 4, 600);
    this.sliderFromPps();
    this.render();
    this.scroll.scrollLeft = 0;
  }
  playheadClientX() { return this.scroll.getBoundingClientRect().left + this.store.playhead * this.pps - this.scroll.scrollLeft; }
  toggleSnap() { this.snapping = !this.snapping; this.snapBtn.classList.toggle('on', this.snapping); }

  // ---------- coordinates ----------
  timeAt(clientX) {
    const rect = this.inner.getBoundingClientRect();
    return Math.max(0, (clientX - rect.left) / this.pps);
  }
  laneAt(clientY) {
    for (const lane of this.lanes.children) {
      const r = lane.getBoundingClientRect();
      if (clientY >= r.top && clientY < r.bottom) return lane.dataset.track;
    }
    return null;
  }
  snap(t, exclude, enable = this.snapping) {
    if (!enable) return { t, hit: null };
    const pts = snapPoints(this.store.project, this.store.playhead, exclude);
    let best = null, bd = SNAP_PX / this.pps;
    for (const p of pts) { const d = Math.abs(p - t); if (d < bd) { bd = d; best = p; } }
    return best === null ? { t, hit: null } : { t: best, hit: best };
  }
  showSnap(t) {
    if (t === null || t === undefined) { this.snapLine.classList.add('hidden'); return; }
    this.snapLine.style.left = t * this.pps + 'px';
    this.snapLine.classList.remove('hidden');
  }

  // ---------- rendering ----------
  render() {
    const s = this.store;
    const p = s.project;
    const dur = s.duration();
    const width = Math.max(this.scroll.clientWidth, (dur + 30) * this.pps);
    this.inner.style.width = width + 'px';
    this.durationLabel.textContent = `Length ${formatTime(dur, p.settings.fps, false)}`;
    this.renderRuler(width);

    // headers
    this.headerList.innerHTML = '';
    this.lanes.innerHTML = '';
    for (const t of p.tracks) {
      this.headerList.appendChild(this.renderHeader(t));
      const lane = h('div', `lane ${t.kind}${t.locked ? ' locked' : ''}`);
      lane.dataset.track = t.id;
      for (const c of p.clips.filter((x) => x.trackId === t.id)) lane.appendChild(this.renderClip(c, t));
      this.lanes.appendChild(lane);
    }
    const spacer = h('div', '', { style: { height: '40px' } });
    this.lanes.appendChild(spacer);
    this.headerList.appendChild(h('div', '', { style: { height: '40px' } }));
    this.updatePlayhead();
  }

  renderRuler(width) {
    const r = this.ruler;
    r.innerHTML = '';
    const fps = this.store.project.settings.fps;
    const steps = [1 / fps, 2 / fps, 5 / fps, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((st) => st * this.pps >= 90) || 600;
    const minor = major / (major >= 1 ? 5 : 2);
    const startT = Math.floor(this.scroll.scrollLeft / this.pps / major) * major;
    const endT = (this.scroll.scrollLeft + this.scroll.clientWidth + 200) / this.pps;
    // Render only the visible part of the ruler; re-rendered on scroll.
    const frag = document.createDocumentFragment();
    const perMajor = Math.round(major / minor);
    const i0 = Math.max(0, Math.round((startT - major) / minor));
    const i1 = Math.ceil(Math.min(endT, width / this.pps) / minor);
    for (let i = i0; i <= i1; i++) {
      const t = Math.round(i * minor * fps) / fps;
      const isMajor = i % perMajor === 0;
      frag.appendChild(h('div', `tick ${isMajor ? 'major' : 'minor'}`, { style: { left: t * this.pps + 'px' } }));
      if (isMajor) {
        const lbl = major < 1 ? formatTime(t, fps, true).slice(3) : formatTime(t, fps, false);
        frag.appendChild(h('div', 'lbl', { text: lbl, style: { left: t * this.pps + 'px' } }));
      }
    }
    r.appendChild(frag);
    if (!this._rulerScrollHooked) {
      this._rulerScrollHooked = true;
      this.scroll.addEventListener('scroll', () => this.renderRuler(parseFloat(this.inner.style.width)));
    }
  }

  renderHeader(t) {
    const s = this.store;
    const el = h('div', 'track-header');
    const nameRow = h('div', 't-name');
    const name = h('input', '', { type: 'text', value: t.name, title: 'Rename track' });
    name.addEventListener('change', () => s.commit('Rename track', () => { t.name = name.value || t.name; }));
    name.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') name.blur(); });
    nameRow.appendChild(name);
    const btns = h('div', 't-btns');
    const mk = (label, title, prop, cls = '') => {
      const b = h('button', `${cls}${t[prop] ? ' on' : ''}`, { text: label, title });
      b.addEventListener('click', () => s.commit(title, () => { s.track(t.id)[prop] = !t[prop]; }));
      return b;
    };
    if (t.kind === 'video') btns.appendChild(mk('👁', 'Hide track', 'hidden', 'warn'));
    btns.appendChild(mk('M', t.kind === 'video' ? 'Mute track audio' : 'Mute track', 'muted', 'warn'));
    btns.appendChild(mk('S', 'Solo track', 'solo'));
    btns.appendChild(mk('🔒', 'Lock track', 'locked', 'warn'));
    const del = h('button', '', { text: '✕', title: 'Delete track' });
    del.addEventListener('click', () => this.deleteTrack(t.id));
    btns.appendChild(del);
    nameRow.appendChild(btns);
    el.appendChild(nameRow);
    const volRow = h('div', 'row gap4');
    volRow.appendChild(h('span', 'kind', { text: t.voice ? '🎙' : t.kind === 'video' ? '🎞' : '♪' }));
    const vol = h('input', '', { type: 'range', min: '0', max: '2', step: '0.01', value: String(t.volume ?? 1), title: 'Track volume' });
    const volLbl = h('span', 'kind', { text: Math.round((t.volume ?? 1) * 100) + '%' });
    vol.addEventListener('pointerdown', () => s.beginLive());
    vol.addEventListener('input', () => { t.volume = Number(vol.value); volLbl.textContent = Math.round(t.volume * 100) + '%'; });
    vol.addEventListener('change', () => s.endLive('Track volume'));
    vol.addEventListener('dblclick', () => s.commit('Track volume', () => { t.volume = 1; }));
    volRow.append(vol, volLbl);
    el.appendChild(volRow);
    return el;
  }

  renderClip(c, t) {
    const s = this.store;
    const m = s.media(c.mediaId);
    const kind = m ? (m.type === 'image' ? 'image' : t.kind === 'audio' ? (t.voice || m.voice ? 'voice' : 'audio') : 'video') : 'video';
    const el = h('div', `clip ${kind}${s.selection.has(c.id) ? ' selected' : ''}${c.muted ? ' muted' : ''}`);
    el.dataset.clip = c.id;
    el.style.left = c.start * this.pps + 'px';
    el.style.width = Math.max(2, c.duration * this.pps) + 'px';
    const cache = m ? s.mediaCache[m.id] || {} : {};
    if (kind === 'video' || kind === 'image') {
      if (cache.thumb) {
        const th = h('div', 'c-thumbs');
        th.style.backgroundImage = `url("${window.mc.mediaUrl(cache.thumb)}")`;
        el.appendChild(th);
      }
    }
    if (m && m.hasAudio && cache.wave && (t.kind === 'audio' || !c.audioDetached)) {
      const w = h('div', 'c-wave');
      const fullPx = (m.duration / c.speed) * this.pps;
      w.style.backgroundImage = `url("${window.mc.mediaUrl(cache.wave)}")`;
      w.style.backgroundSize = `${fullPx}px 100%`;
      w.style.backgroundPosition = `${-(c.in / c.speed) * this.pps}px 0`;
      if (c.reversed) w.style.transform = 'scaleX(-1)';
      if (t.kind === 'video') w.style.height = '40%';
      el.appendChild(w);
    }
    const label = h('div', 'c-label');
    label.appendChild(h('span', '', { text: m ? m.name : 'Missing media' }));
    if (c.speed !== 1) label.appendChild(h('span', 'tag', { text: `${+c.speed.toFixed(2)}x` }));
    if (c.reversed) label.appendChild(h('span', 'tag', { text: '⟲' }));
    if (c.audioDetached && t.kind === 'video') label.appendChild(h('span', 'tag', { text: 'audio detached' }));
    if (c.muted) label.appendChild(h('span', 'tag', { text: 'muted' }));
    el.appendChild(label);
    if (c.fadeIn > 0) el.appendChild(h('div', 'fade in', { style: { width: c.fadeIn * this.pps + 'px' } }));
    if (c.fadeOut > 0) el.appendChild(h('div', 'fade out', { style: { width: c.fadeOut * this.pps + 'px' } }));
    el.appendChild(h('div', 'trim l', { title: 'Drag to trim start' }));
    el.appendChild(h('div', 'trim r', { title: 'Drag to trim end' }));
    return el;
  }

  updatePlayhead() {
    const x = this.store.playhead * this.pps;
    this.playhead.style.left = x + 'px';
    if (this.preview.playing) {
      const left = this.scroll.scrollLeft, w = this.scroll.clientWidth;
      if (x > left + w - 40 || x < left) this.scroll.scrollLeft = x - 40;
    }
  }

  // ---------- ruler / playhead ----------
  setupRuler() {
    const scrub = (e) => {
      e.preventDefault();
      const move = (ev) => {
        let t = this.timeAt(ev.clientX);
        if (ev.shiftKey) t = this.snap(t, new Set(), true).t;
        t = Math.round(t * this.store.project.settings.fps) / this.store.project.settings.fps;
        this.store.setPlayhead(t);
        this.preview.resync();
      };
      move(e);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    };
    this.ruler.addEventListener('pointerdown', scrub);
    this.playhead.querySelector('.playhead-head').addEventListener('pointerdown', scrub);
  }

  // ---------- clip & lane interactions ----------
  setupLaneEvents() {
    this.lanes.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const clipEl = e.target.closest('.clip');
      if (clipEl) {
        const id = clipEl.dataset.clip;
        const additive = e.ctrlKey || e.metaKey || e.shiftKey;
        if (additive) this.store.select([id], true);
        else if (!this.store.selection.has(id)) this.store.select([id]);
        if (e.target.classList.contains('trim')) this.startTrim(e, id, e.target.classList.contains('l') ? 'l' : 'r');
        else if (!additive) this.startMove(e, id);
        return;
      }
      this.startMarquee(e);
    });

    // Drag & drop from the media bin
    this.lanes.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-meandercut-media') && !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      const lane = e.target.closest('.lane');
      for (const l of this.lanes.querySelectorAll('.drop-target')) if (l !== lane) l.classList.remove('drop-target');
      if (lane) lane.classList.add('drop-target');
      this.showSnap(this.timeAt(e.clientX));
    });
    this.lanes.addEventListener('dragleave', (e) => { if (!this.lanes.contains(e.relatedTarget)) this.clearDrop(); });
    this.lanes.addEventListener('drop', async (e) => {
      e.preventDefault();
      const trackId = this.laneAt(e.clientY);
      const t = this.snap(this.timeAt(e.clientX), new Set()).t;
      this.clearDrop();
      const mediaId = e.dataTransfer.getData('application/x-meandercut-media');
      if (mediaId) this.placeMedia(mediaId, t, trackId);
      else if (e.dataTransfer.files.length) {
        const ids = await this.ui.onMediaDrop([...e.dataTransfer.files]);
        let at = t;
        for (const id of ids) { const c = this.placeMedia(id, at, trackId); if (c) at = c.start + c.duration; }
      }
    });
  }
  clearDrop() {
    for (const l of this.lanes.querySelectorAll('.drop-target')) l.classList.remove('drop-target');
    this.showSnap(null);
  }

  /** Put media on the timeline. Picks a compatible track if the target doesn't fit. */
  placeMedia(mediaId, t, trackId) {
    const s = this.store;
    const m = s.media(mediaId);
    if (!m || m.missing) return null;
    const wantKind = m.type === 'audio' ? 'audio' : 'video';
    let clip = null;
    s.commit('Add clip', (p) => {
      let track = trackId && s.track(trackId);
      if (!track || track.kind !== wantKind || track.locked) {
        // No usable drop target (e.g. double-click in the media bin): use the main track if it's
        // free here, otherwise the next free track above it, so nothing gets overwritten.
        const dur = m.type === 'image' ? 5 : m.duration;
        const fits = (tr) => tr.kind === wantKind && !tr.locked && (!m.voice || tr.voice) && (m.voice || !tr.voice);
        const free = (tr) => !p.clips.some((c) => c.trackId === tr.id && c.start < t + dur - EPS && c.start + c.duration > t + EPS);
        const order = wantKind === 'video' ? [...p.tracks].reverse().filter(fits) : p.tracks.filter(fits);
        track = order.find(free) || null;
      }
      if (!track) {
        const n = p.tracks.filter((tr) => tr.kind === wantKind).length + 1;
        track = { id: uid('trk'), kind: wantKind, name: `${wantKind === 'video' ? 'Video' : 'Audio'} ${n}`, hidden: false, locked: false, muted: false, solo: false, volume: 1 };
        if (wantKind === 'video') p.tracks.unshift(track); else p.tracks.push(track);
      }
      clip = newClip(m, track.id, t);
      clearRange(p, track.id, clip.start, clip.start + clip.duration);
      p.clips.push(clip);
    });
    if (clip) s.select([clip.id]);
    return clip;
  }

  startMove(e, id) {
    const s = this.store;
    const anchor = s.clip(id);
    if (!anchor) return;
    const sel = s.selectedClips().filter((c) => !s.track(c.trackId).locked);
    if (!sel.length) return;
    const startX = e.clientX;
    const offset = this.timeAt(e.clientX) - anchor.start;
    const orig = new Map(sel.map((c) => [c.id, { start: c.start, trackId: c.trackId }]));
    const ids = new Set(sel.map((c) => c.id));
    const minStart = Math.min(...sel.map((c) => c.start));
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3 && !this.laneChanged(ev, anchor, orig)) return;
      if (!moved) { moved = true; s.beginLive(); }
      let ns = this.timeAt(ev.clientX) - offset;
      // Snap either edge of the dragged clip
      const a = this.snap(ns, ids), b = this.snap(ns + anchor.duration, ids);
      let hit = null;
      if (a.hit !== null && (b.hit === null || Math.abs(a.t - ns) <= Math.abs(b.t - ns - anchor.duration))) { ns = a.t; hit = a.hit; }
      else if (b.hit !== null) { ns = b.t - anchor.duration; hit = b.hit; }
      this.showSnap(hit);
      let delta = ns - orig.get(anchor.id).start;
      delta = Math.max(delta, -minStart);
      // Change track (single clip only, same kind)
      let targetTrack = null;
      if (sel.length === 1) {
        const tid = this.laneAt(ev.clientY);
        const tr = tid && s.track(tid);
        const cur = s.track(orig.get(anchor.id).trackId);
        if (tr && tr.kind === cur.kind && !tr.locked) targetTrack = tr.id;
      }
      for (const c of sel) {
        c.start = Math.max(0, orig.get(c.id).start + delta);
        if (targetTrack) c.trackId = targetTrack;
      }
      s.emit('live');
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.showSnap(null);
      if (!moved) {
        // A plain click on a clip also moves the playhead there, like CapCut.
        return;
      }
      for (const c of sel) clearRange(s.project, c.trackId, c.start, c.start + c.duration, ids);
      s.endLive(sel.length > 1 ? 'Move clips' : 'Move clip');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  laneChanged(ev, anchor, orig) {
    const tid = this.laneAt(ev.clientY);
    return tid && tid !== orig.get(anchor.id).trackId;
  }

  startTrim(e, id, side) {
    const s = this.store;
    const c = s.clip(id);
    if (!c || s.track(c.trackId).locked) return;
    e.stopPropagation();
    const m = s.media(c.mediaId);
    const frame = s.frame();
    const o = { start: c.start, duration: c.duration, in: c.in };
    const srcMax = m && m.type !== 'image' ? m.duration : Infinity;
    s.beginLive();
    const move = (ev) => {
      const snapped = this.snap(this.timeAt(ev.clientX), new Set([id]));
      this.showSnap(snapped.hit);
      const t = snapped.t;
      if (side === 'l') {
        let d = t - o.start;
        d = Math.min(d, o.duration - frame); // keep at least one frame
        d = Math.max(d, -o.start); // can't go before 0
        if (!c.reversed) d = Math.max(d, -o.in / c.speed); // can't go before source start
        else d = Math.max(d, -((srcMax - (o.in + o.duration * c.speed)) / c.speed));
        c.start = o.start + d;
        c.duration = o.duration - d;
        if (!c.reversed) c.in = o.in + d * c.speed;
      } else {
        let d = t - (o.start + o.duration);
        d = Math.max(d, frame - o.duration);
        if (!c.reversed) d = Math.min(d, (srcMax - (o.in + o.duration * c.speed)) / c.speed);
        else d = Math.min(d, o.in / c.speed);
        c.duration = o.duration + d;
        if (c.reversed) c.in = o.in - d * c.speed;
      }
      c.fadeIn = Math.min(c.fadeIn, c.duration);
      c.fadeOut = Math.min(c.fadeOut, c.duration);
      s.emit('live');
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      this.showSnap(null);
      clearRange(s.project, c.trackId, c.start, c.start + c.duration, new Set([c.id]));
      s.endLive('Trim clip');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  startMarquee(e) {
    const s = this.store;
    const startX = e.clientX, startY = e.clientY;
    const rect = this.inner.getBoundingClientRect();
    let box = null;
    const additive = e.ctrlKey || e.metaKey || e.shiftKey;
    const before = new Set(s.selection);
    const move = (ev) => {
      if (!box && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
      if (!box) { box = h('div', 'marquee'); this.inner.appendChild(box); }
      const x1 = Math.min(startX, ev.clientX) - rect.left, x2 = Math.max(startX, ev.clientX) - rect.left;
      const y1 = Math.min(startY, ev.clientY), y2 = Math.max(startY, ev.clientY);
      const r2 = this.inner.getBoundingClientRect();
      Object.assign(box.style, { left: x1 + 'px', width: x2 - x1 + 'px', top: y1 - r2.top + 'px', height: y2 - y1 + 'px' });
      const hits = [];
      for (const el of this.lanes.querySelectorAll('.clip')) {
        const r = el.getBoundingClientRect();
        if (r.right > Math.min(startX, ev.clientX) && r.left < Math.max(startX, ev.clientX) && r.bottom > y1 && r.top < y2) hits.push(el.dataset.clip);
      }
      s.selection = new Set(additive ? [...before, ...hits] : hits);
      for (const el of this.lanes.querySelectorAll('.clip')) el.classList.toggle('selected', s.selection.has(el.dataset.clip));
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (box) { box.remove(); s.emit('selection'); return; }
      // Plain click on empty space: clear selection and move the playhead.
      if (!additive) s.select([]);
      const fps = s.project.settings.fps;
      s.setPlayhead(Math.round(this.timeAt(ev.clientX) * fps) / fps);
      this.preview.resync();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  deleteTrack(id) {
    const s = this.store;
    const t = s.track(id);
    const n = s.project.clips.filter((c) => c.trackId === id).length;
    const sameKind = s.project.tracks.filter((x) => x.kind === t.kind).length;
    if (sameKind <= 1) { this.ui.toast(`Keep at least one ${t.kind} track.`); return; }
    if (n && !confirm(`Delete "${t.name}" and its ${n} clip(s)?`)) return;
    s.commit('Delete track', (p) => {
      p.tracks = p.tracks.filter((x) => x.id !== id);
      p.clips = p.clips.filter((c) => c.trackId !== id);
    });
  }

  /** Clamp a clip to its media after inspector edits. */
  static fitToMedia(clip, media) {
    const max = maxDuration(clip, media);
    if (clip.duration > max + EPS) clip.duration = max;
  }
}
