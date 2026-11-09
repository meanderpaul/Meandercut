// Right-hand inspector: project settings, or properties of the selected clip(s).
import { ASPECTS, sizeFor, setSpeed, maxDuration, formatTime } from './state.js';

const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const FPS_OPTIONS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120];

export class Inspector {
  constructor(store, root, titleEl, actions) {
    this.store = store;
    this.root = root;
    this.titleEl = titleEl;
    this.actions = actions; // { detach, extractAudio, reverse, toast }
    this.tab = 'video';
    this.updaters = [];
    store.on((what) => {
      if (what === 'playhead') return;
      if (what === 'live') { this.refresh(); return; }
      this.render();
    });
    this.render();
  }

  refresh() { for (const u of this.updaters) u(); }

  render() {
    this.updaters = [];
    this.root.innerHTML = '';
    const sel = this.store.selectedClips();
    if (sel.length === 0) return this.renderProject();
    if (sel.length > 1) return this.renderMulti(sel);
    return this.renderClip(sel[0]);
  }

  // ---------- building blocks ----------
  group(title, resetFn) {
    const g = h('div', 'group');
    const t = h('h4', '', title);
    if (resetFn) { const b = h('button', '', 'Reset'); b.onclick = resetFn; t.appendChild(b); }
    g.appendChild(t);
    this.root.appendChild(g);
    return g;
  }
  /** Slider + number box bound to a value. `set` runs inside a live edit. */
  slider(parent, label, { get, set, min, max, step = 0.01, scale = 1, unit = '', undo }) {
    const row = h('div', 'field');
    row.appendChild(h('label', '', label));
    const r = h('input'); Object.assign(r, { type: 'range', min, max, step });
    const n = h('input'); Object.assign(n, { type: 'number', step: step * scale });
    n.title = unit;
    const show = () => {
      const v = get();
      if (document.activeElement !== r) r.value = v;
      if (document.activeElement !== n) n.value = +(v * scale).toFixed(3);
    };
    show();
    this.updaters.push(show);
    let live = false;
    const start = () => { if (!live) { live = true; this.store.beginLive(); } };
    const end = () => { if (live) { live = false; this.store.endLive(undo || label); } };
    r.addEventListener('pointerdown', start);
    r.addEventListener('input', () => { start(); set(Number(r.value)); n.value = +(Number(r.value) * scale).toFixed(3); this.store.emit('live'); });
    r.addEventListener('change', end);
    n.addEventListener('keydown', (e) => e.stopPropagation());
    n.addEventListener('change', () => {
      const v = Math.min(max, Math.max(min, Number(n.value) / scale));
      this.store.beginLive(); set(v); this.store.endLive(undo || label);
    });
    row.append(r, n);
    parent.appendChild(row);
    return row;
  }
  seg(parent, label, options, get, set) {
    const row = h('div', 'field two');
    row.appendChild(h('label', '', label));
    const s = h('div', 'seg');
    for (const [val, text] of options) {
      const b = h('button', get() === val ? 'on' : '', text);
      b.onclick = () => set(val);
      s.appendChild(b);
    }
    row.appendChild(s);
    parent.appendChild(row);
  }
  check(parent, label, get, set) {
    const l = h('label', 'check');
    const c = h('input'); c.type = 'checkbox'; c.checked = get();
    c.onchange = () => set(c.checked);
    l.append(c, document.createTextNode(label));
    parent.appendChild(l);
  }
  info(parent, k, v) {
    const r = h('div', 'info-line');
    r.append(h('span', '', k), h('span', '', v));
    r.lastChild.title = v;
    parent.appendChild(r);
  }
  button(parent, text, fn, cls = 'btn small') {
    const b = h('button', cls, text);
    b.onclick = fn;
    parent.appendChild(b);
    return b;
  }

  // ---------- project ----------
  renderProject() {
    const s = this.store;
    const st = s.project.settings;
    this.titleEl.textContent = 'Project settings';
    const g = this.group('Canvas');
    const nameRow = h('div', 'field two');
    nameRow.appendChild(h('label', '', 'Name'));
    const name = h('input'); name.type = 'text'; name.value = s.project.name;
    name.onkeydown = (e) => e.stopPropagation();
    name.onchange = () => s.commit('Rename project', (p) => { p.name = name.value || 'Untitled'; });
    nameRow.appendChild(name);
    g.appendChild(nameRow);

    const short = Math.min(st.width, st.height);
    const aspectRow = h('div', 'field two');
    aspectRow.appendChild(h('label', '', 'Aspect ratio'));
    const asel = h('select');
    for (const a of Object.keys(ASPECTS)) asel.appendChild(new Option(`${a}${a === '16:9' ? '  YouTube' : a === '9:16' ? '  Shorts / TikTok' : ''}`, a));
    asel.appendChild(new Option('Custom', 'custom'));
    asel.value = ASPECTS[st.aspect] ? st.aspect : 'custom';
    asel.onchange = () => {
      if (asel.value === 'custom') return;
      s.commit('Change aspect ratio', (p) => Object.assign(p.settings, sizeFor(asel.value, short), { aspect: asel.value }));
    };
    aspectRow.appendChild(asel);
    g.appendChild(aspectRow);

    const resRow = h('div', 'field two');
    resRow.appendChild(h('label', '', 'Resolution'));
    const rsel = h('select');
    for (const [v, t] of [[720, '720p HD'], [1080, '1080p Full HD'], [1440, '1440p 2K'], [2160, '2160p 4K UHD']]) rsel.appendChild(new Option(t, v));
    rsel.value = String(short);
    rsel.onchange = () => s.commit('Change resolution', (p) => Object.assign(p.settings, sizeFor(ASPECTS[p.settings.aspect] ? p.settings.aspect : '16:9', Number(rsel.value))));
    resRow.appendChild(rsel);
    g.appendChild(resRow);

    const sizeRow = h('div', 'field two');
    sizeRow.appendChild(h('label', '', 'Width × height'));
    const wrap = h('div', 'row gap4');
    const w = h('input'), hh = h('input');
    for (const [el, v] of [[w, st.width], [hh, st.height]]) { el.type = 'number'; el.value = v; el.style.width = '70px'; el.onkeydown = (e) => e.stopPropagation(); }
    const applySize = () => s.commit('Custom size', (p) => {
      p.settings.width = Math.max(16, Math.round(Number(w.value) / 2) * 2);
      p.settings.height = Math.max(16, Math.round(Number(hh.value) / 2) * 2);
      const match = Object.entries(ASPECTS).find(([, [a, b]]) => Math.abs(p.settings.width / p.settings.height - a / b) < 0.01);
      p.settings.aspect = match ? match[0] : 'custom';
    });
    w.onchange = applySize; hh.onchange = applySize;
    wrap.append(w, h('span', 'muted', '×'), hh);
    sizeRow.appendChild(wrap);
    g.appendChild(sizeRow);

    const fpsRow = h('div', 'field two');
    fpsRow.appendChild(h('label', '', 'Frame rate'));
    const fsel = h('select');
    for (const f of FPS_OPTIONS) fsel.appendChild(new Option(`${f} fps`, f));
    fsel.value = String(st.fps);
    fsel.onchange = () => s.commit('Change frame rate', (p) => { p.settings.fps = Number(fsel.value); });
    fpsRow.appendChild(fsel);
    g.appendChild(fpsRow);

    const bgRow = h('div', 'field two');
    bgRow.appendChild(h('label', '', 'Background'));
    const bg = h('input'); bg.type = 'color'; bg.value = st.background || '#000000';
    bg.onchange = () => s.commit('Background colour', (p) => { p.settings.background = bg.value; });
    bgRow.appendChild(bg);
    g.appendChild(bgRow);

    const g2 = this.group('Timeline');
    const dur = s.duration();
    this.info(g2, 'Length', formatTime(dur, st.fps));
    this.info(g2, 'Clips', String(s.project.clips.length));
    this.info(g2, 'Tracks', String(s.project.tracks.length));
    this.info(g2, 'Media files', String(s.project.media.length));

    const g3 = this.group('Tips');
    g3.appendChild(h('div', 'muted small', 'Select a clip to edit its picture, sound and speed. Drag media from the left onto the timeline. Press F1 for keyboard shortcuts.'));
  }

  // ---------- multiple clips ----------
  renderMulti(sel) {
    const s = this.store;
    this.titleEl.textContent = `${sel.length} clips selected`;
    const g = this.group('Audio');
    this.slider(g, 'Volume', {
      get: () => sel[0].volume, set: (v) => sel.forEach((c) => { c.volume = v; }),
      min: 0, max: 2, step: 0.01, scale: 100, unit: '%', undo: 'Volume',
    });
    this.check(g, 'Mute', () => sel.every((c) => c.muted), (v) => s.commit('Mute', () => sel.forEach((c) => { c.muted = v; })));
    const g2 = this.group('Speed');
    this.slider(g2, 'Speed', {
      get: () => sel[0].speed, set: (v) => sel.forEach((c) => setSpeed(c, v)),
      min: 0.1, max: 8, step: 0.05, unit: 'x', undo: 'Speed',
    });
    const g3 = this.group('Actions');
    const row = h('div', 'row gap4');
    this.button(row, 'Detach audio', () => this.actions.detach());
    this.button(row, 'Delete', () => this.actions.delete());
    g3.appendChild(row);
  }

  // ---------- single clip ----------
  renderClip(c) {
    const s = this.store;
    const m = s.media(c.mediaId);
    const track = s.track(c.trackId);
    if (!m || !track) return;
    this.titleEl.textContent = m.name;
    const visual = track.kind === 'video';
    const hasAudio = m.hasAudio && (track.kind === 'audio' || !c.audioDetached);
    const tabs = [];
    if (visual) tabs.push(['video', 'Video']);
    if (hasAudio || (visual && m.hasAudio)) tabs.push(['audio', 'Audio']);
    if (m.type !== 'image') tabs.push(['speed', 'Speed']);
    tabs.push(['info', 'Info']);
    if (!tabs.some(([k]) => k === this.tab)) this.tab = tabs[0][0];
    const tabBar = h('div', 'insp-tabs');
    for (const [k, t] of tabs) {
      const b = h('button', `tab${this.tab === k ? ' active' : ''}`, t);
      b.onclick = () => { this.tab = k; this.render(); };
      tabBar.appendChild(b);
    }
    this.root.appendChild(tabBar);

    const live = (fn) => (v) => fn(v);
    if (this.tab === 'video') {
      const g = this.group('Fit to canvas');
      this.seg(g, 'Mode', [['fit', 'Fit'], ['fill', 'Fill'], ['stretch', 'Stretch']], () => c.fit, (v) => s.commit('Fit mode', () => { c.fit = v; }));

      const tr = this.group('Transform', () => s.commit('Reset transform', () => Object.assign(c, { scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false })));
      this.slider(tr, 'Scale', { get: () => c.scale, set: live((v) => { c.scale = v; }), min: 0.05, max: 5, step: 0.01, scale: 100, unit: '%' });
      this.slider(tr, 'Position X', { get: () => c.x, set: live((v) => { c.x = v; }), min: -1, max: 1, step: 0.001, scale: 100, unit: '% of width' });
      this.slider(tr, 'Position Y', { get: () => c.y, set: live((v) => { c.y = v; }), min: -1, max: 1, step: 0.001, scale: 100, unit: '% of height' });
      this.slider(tr, 'Rotation', { get: () => c.rotation, set: live((v) => { c.rotation = v; }), min: -180, max: 180, step: 0.5, unit: '°' });
      const flips = h('div', 'row gap8');
      this.check(flips, 'Flip horizontal', () => c.flipH, (v) => s.commit('Flip', () => { c.flipH = v; }));
      this.check(flips, 'Flip vertical', () => c.flipV, (v) => s.commit('Flip', () => { c.flipV = v; }));
      tr.appendChild(flips);
      tr.appendChild(h('div', 'muted small', 'Tip: drag the clip in the preview to move it; drag the corner to resize. Hold Alt to turn off centre snapping.'));

      const cr = this.group('Crop', () => s.commit('Reset crop', () => { c.crop = { l: 0, r: 0, t: 0, b: 0 }; }));
      for (const [k, label] of [['l', 'Left'], ['r', 'Right'], ['t', 'Top'], ['b', 'Bottom']]) {
        this.slider(cr, label, {
          get: () => c.crop[k], min: 0, max: 0.9, step: 0.001, scale: 100, unit: '%', undo: 'Crop',
          set: (v) => { const other = { l: 'r', r: 'l', t: 'b', b: 't' }[k]; c.crop[k] = Math.min(v, 0.95 - c.crop[other]); },
        });
      }

      const adj = this.group('Adjust', () => s.commit('Reset adjustments', () => Object.assign(c, { brightness: 0, contrast: 1, saturation: 1, gamma: 1, opacity: 1 })));
      this.slider(adj, 'Opacity', { get: () => c.opacity, set: live((v) => { c.opacity = v; }), min: 0, max: 1, step: 0.01, scale: 100, unit: '%' });
      this.slider(adj, 'Brightness', { get: () => c.brightness, set: live((v) => { c.brightness = v; }), min: -0.5, max: 0.5, step: 0.005, scale: 100 });
      this.slider(adj, 'Contrast', { get: () => c.contrast, set: live((v) => { c.contrast = v; }), min: 0, max: 2, step: 0.01, scale: 100, unit: '%' });
      this.slider(adj, 'Saturation', { get: () => c.saturation, set: live((v) => { c.saturation = v; }), min: 0, max: 3, step: 0.01, scale: 100, unit: '%' });
      this.slider(adj, 'Gamma', { get: () => c.gamma, set: live((v) => { c.gamma = v; }), min: 0.2, max: 3, step: 0.01 });
      adj.appendChild(h('div', 'muted small', 'Gamma shows in the export only.'));
    }

    if (this.tab === 'audio') {
      const g = this.group('Volume', () => s.commit('Reset audio', () => Object.assign(c, { volume: 1, fadeIn: 0, fadeOut: 0, muted: false })));
      if (visual && c.audioDetached) {
        g.appendChild(h('div', 'muted small', 'This clip\'s audio has been detached to an audio track. Select that clip to edit its sound.'));
      } else {
        this.slider(g, 'Volume', { get: () => c.volume, set: (v) => { c.volume = v; }, min: 0, max: 2, step: 0.01, scale: 100, unit: '%' });
        const dB = h('div', 'muted small');
        const upd = () => { dB.textContent = c.volume > 0 ? `${(20 * Math.log10(c.volume)).toFixed(1)} dB` : '-∞ dB'; };
        upd(); this.updaters.push(upd);
        g.appendChild(dB);
        this.check(g, 'Mute this clip', () => c.muted, (v) => s.commit('Mute clip', () => { c.muted = v; }));
        const f = this.group('Fades');
        this.slider(f, 'Fade in', { get: () => c.fadeIn, set: (v) => { c.fadeIn = Math.min(v, c.duration - c.fadeOut); }, min: 0, max: Math.min(10, c.duration), step: 0.05, unit: 's' });
        this.slider(f, 'Fade out', { get: () => c.fadeOut, set: (v) => { c.fadeOut = Math.min(v, c.duration - c.fadeIn); }, min: 0, max: Math.min(10, c.duration), step: 0.05, unit: 's' });
      }
      const g2 = this.group('Separate');
      const row = h('div', 'row gap4');
      if (visual && !c.audioDetached) this.button(row, '♪ Detach audio to track', () => this.actions.detach());
      this.button(row, '⇩ Save audio as file…', () => this.actions.extractAudio());
      g2.appendChild(row);
    }

    if (this.tab === 'speed') {
      const g = this.group('Speed', () => s.commit('Reset speed', () => setSpeed(c, 1)));
      this.slider(g, 'Speed', {
        get: () => c.speed, min: 0.1, max: 8, step: 0.05, unit: 'x', undo: 'Speed',
        set: (v) => { setSpeed(c, v); },
      });
      const presets = h('div', 'row gap4');
      presets.style.flexWrap = 'wrap';
      for (const v of [0.25, 0.5, 0.75, 1, 1.5, 2, 4]) this.button(presets, `${v}x`, () => s.commit('Speed', () => setSpeed(c, v)));
      g.appendChild(presets);
      const durLine = h('div', 'info-line');
      const upd = () => { durLine.innerHTML = ''; durLine.append(h('span', '', 'Clip length'), h('span', '', formatTime(c.duration, s.project.settings.fps))); };
      upd(); this.updaters.push(upd);
      g.appendChild(durLine);
      g.appendChild(h('div', 'muted small', 'Audio keeps its pitch when sped up or slowed down.'));
      const g2 = this.group('Direction');
      this.check(g2, 'Reverse (play backwards)', () => c.reversed, (v) => s.commit('Reverse', () => { c.reversed = v; }));
      g2.appendChild(h('div', 'muted small', 'Reversed audio is heard in the export; the preview plays it silent.'));
    }

    if (this.tab === 'info') {
      const g = this.group('Clip');
      const fps = s.project.settings.fps;
      this.info(g, 'Starts at', formatTime(c.start, fps));
      this.info(g, 'Length', formatTime(c.duration, fps));
      this.info(g, 'Source in', formatTime(c.in, fps));
      this.info(g, 'Track', track.name);
      const g2 = this.group('Source file');
      this.info(g2, 'File', m.path);
      this.info(g2, 'Type', m.type);
      if (m.width) this.info(g2, 'Resolution', `${m.width} × ${m.height}`);
      if (m.type === 'video') this.info(g2, 'Frame rate', `${+m.fps.toFixed(3)} fps`);
      if (m.duration) this.info(g2, 'Duration', formatTime(m.duration, fps));
      if (m.videoCodec) this.info(g2, 'Video codec', m.videoCodec);
      if (m.audioCodec) this.info(g2, 'Audio', `${m.audioCodec}, ${m.sampleRate} Hz, ${m.channels} ch`);
      if (m.size) this.info(g2, 'Size', `${(m.size / 1048576).toFixed(1)} MB`);
      const row = h('div', 'row gap4');
      row.style.marginTop = '8px';
      this.button(row, 'Show in folder', () => window.mc.showItem(m.path));
      g2.appendChild(row);
      void maxDuration;
    }
  }
}
