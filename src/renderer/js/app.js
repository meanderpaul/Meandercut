// MeanderCut renderer entry point: wires the store, preview, timeline, inspector and dialogs together.
import { Store, newProject, uid, splitClip, rippleDelete, detachAudio, clearRange, formatTime, sizeFor, ASPECTS, EPS } from './state.js';
import { Preview } from './preview.js';
import { Timeline } from './timeline.js';
import { Inspector } from './inspector.js';
import { exportDialog, recordDialog, shortcutsDialog, modalOpen, closeModal } from './dialogs.js';

const $ = (id) => document.getElementById(id);
const store = new Store();
window.__store = store; // handy for debugging in DevTools

// ---------- toasts ----------
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2800);
}

// ---------- core views ----------
const preview = new Preview(store, {
  canvas: $('previewCanvas'), wrap: $('canvasWrap'), stage: $('previewStage'), pool: $('mediaPool'),
  transformBox: $('transformBox'), meterL: $('meterL'), meterR: $('meterR'),
});
const ui = { toast, importPaths, onMediaDrop: dropFiles, recorderStop: null };
const timeline = new Timeline(store, preview, {
  scroll: $('tracksScroll'), inner: $('tracksInner'), ruler: $('ruler'), lanes: $('trackLanes'),
  headerList: $('trackHeaderList'), playhead: $('playhead'), snapLine: $('snapLine'),
  zoomSlider: $('zoomSlider'), trackHeight: $('trackHeight'), durationLabel: $('durationLabel'), snapBtn: $('snapBtn'),
}, ui);
new Inspector(store, $('inspector'), $('inspectorTitle'), {
  detach: () => run('detach'), extractAudio: () => run('extractAudio'), delete: () => run('delete'), toast,
});

preview.onState((playing) => { $('playBtn').textContent = playing ? '❚❚' : '▶'; });
store.on((what) => {
  if (what === 'playhead' || what === 'live' || what === 'edit' || what === 'load') {
    $('timecode').textContent = formatTime(store.playhead, store.project.settings.fps);
  }
  if (what === 'edit' || what === 'load' || what === 'media') { renderMedia(); updateTitle(); syncViewControls(); }
});

function updateTitle() {
  const name = store.filePath ? store.filePath.split(/[\\/]/).pop() : `${store.project.name}`;
  $('projectName').textContent = (store.dirty ? '● ' : '') + name;
  document.title = `${store.dirty ? '● ' : ''}${name} - MeanderCut`;
}
function syncViewControls() {
  const a = store.project.settings.aspect;
  $('aspectSelect').value = ASPECTS[a] ? a : '16:9';
}

// ---------- media bin ----------
let mediaFilter = 'all';
$('mediaTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (!b) return;
  mediaFilter = b.dataset.filter;
  for (const x of $('mediaTabs').children) x.classList.toggle('active', x === b);
  renderMedia();
});

function renderMedia() {
  const list = $('mediaList');
  for (const n of [...list.querySelectorAll('.media-item')]) n.remove();
  const items = store.project.media.filter((m) => mediaFilter === 'all' || m.type === mediaFilter);
  $('mediaEmpty').classList.toggle('hidden', store.project.media.length > 0);
  for (const m of items) {
    const card = document.createElement('div');
    card.className = 'media-item' + (m.missing ? ' missing' : '');
    card.draggable = !m.missing;
    card.title = `${m.name}\n${m.path}\nDouble-click to add at the playhead. Right-click to remove.`;
    const thumb = document.createElement('div');
    thumb.className = 'thumb' + (m.type === 'audio' ? ' audio' : '');
    const cache = store.mediaCache[m.id] || {};
    if (m.type === 'audio' && cache.wave) thumb.style.backgroundImage = `url("${window.mc.mediaUrl(cache.wave)}")`;
    else if (cache.thumb) thumb.style.backgroundImage = `url("${window.mc.mediaUrl(cache.thumb)}")`;
    else thumb.textContent = m.type === 'audio' ? (m.voice ? '🎙' : '♪') : m.type === 'image' ? '🖼' : '🎞';
    card.appendChild(thumb);
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = m.type === 'image' ? 'IMG' : formatTime(m.duration, 30, false);
    card.appendChild(badge);
    const add = document.createElement('button');
    add.className = 'add'; add.textContent = '+'; add.title = 'Add at playhead';
    add.onclick = (e) => { e.stopPropagation(); timeline.placeMedia(m.id, store.playhead); };
    card.appendChild(add);
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = '<div class="name"></div><div class="muted"></div>';
    meta.firstChild.textContent = m.name;
    meta.lastChild.textContent = m.type === 'audio' ? (m.voice ? 'Voice-over' : 'Audio') : m.width ? `${m.width}×${m.height}${m.type === 'video' ? ` · ${Math.round(m.fps)}fps` : ''}` : m.type;
    card.appendChild(meta);
    card.addEventListener('dragend', () => { timeline.dragMediaId = null; timeline.clearDrop(); });
    card.addEventListener('dragstart', (e) => {
      timeline.dragMediaId = m.id;
      e.dataTransfer.setData('application/x-meandercut-media', m.id);
      e.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dblclick', () => timeline.placeMedia(m.id, store.playhead));
    card.addEventListener('click', () => { if (m.missing) relink(m); });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const used = store.project.clips.filter((c) => c.mediaId === m.id).length;
      if (!confirm(`Remove "${m.name}" from the project?${used ? `\nIts ${used} clip(s) on the timeline will be removed too.` : ''}\n(The file on disk is not deleted.)`)) return;
      store.commit('Remove media', (p) => {
        p.media = p.media.filter((x) => x.id !== m.id);
        p.clips = p.clips.filter((c) => c.mediaId !== m.id);
      });
    });
    list.appendChild(card);
  }
}

async function loadCaches(m) {
  if (m.missing) return;
  const cache = store.mediaCache[m.id] = store.mediaCache[m.id] || {};
  try {
    if (m.hasVideo || m.type === 'image') cache.thumb = await window.mc.thumbnail(m.path, m.type, m.duration);
    if (m.hasAudio) cache.wave = await window.mc.waveform(m.path);
  } catch (e) { console.warn('preview cache failed', m.path, e); }
  store.emit('media');
}

/** Import files from disk. Returns the media ids (existing ids for files already in the project). */
async function importPaths(paths, extra = {}) {
  const ids = [];
  const added = [];
  for (const p of paths) {
    const existing = store.project.media.find((m) => m.path === p);
    if (existing) { ids.push(existing.id); continue; }
    try {
      const info = await window.mc.probe(p);
      if (info.missing) { toast(`File not found: ${p}`, 'error'); continue; }
      if (!info.hasVideo && !info.hasAudio) { toast(`Unsupported file: ${info.name}`, 'error'); continue; }
      const m = Object.assign({ id: uid('med') }, info, extra);
      added.push(m);
      ids.push(m.id);
    } catch (e) {
      toast(`Could not read ${p.split(/[\\/]/).pop()}: not a supported media file.`, 'error');
    }
  }
  if (added.length) {
    store.commit(added.length > 1 ? `Import ${added.length} files` : 'Import media', (proj) => { proj.media.push(...added); });
    added.forEach(loadCaches);
    // A new project takes its size and frame rate from the first video imported, like CapCut.
    const first = added.find((m) => m.type === 'video');
    if (first && store.project.clips.length === 0 && store.project.media.filter((m) => m.type === 'video').length === 1) {
      const ratio = first.width / first.height;
      const match = Object.entries(ASPECTS).find(([, [a, b]]) => Math.abs(ratio - a / b) < 0.02);
      store.commit('Match project to footage', (proj) => {
        const short = Math.min(first.width, first.height);
        const std = [720, 1080, 1440, 2160].reduce((best, s) => (Math.abs(s - short) < Math.abs(best - short) ? s : best), 1080);
        if (match) Object.assign(proj.settings, sizeFor(match[0], std), { aspect: match[0] });
        const fps = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60].reduce((b, f) => (Math.abs(f - first.fps) < Math.abs(b - first.fps) ? f : b), 30);
        proj.settings.fps = fps;
      });
    }
  }
  return ids;
}

async function dropFiles(files) {
  const paths = files.map((f) => window.mc.pathForFile(f)).filter(Boolean);
  return importPaths(paths);
}

// Drop anywhere outside the timeline imports into the bin
const mediaList = $('mediaList');
document.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); mediaList.classList.add('drop'); } });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) mediaList.classList.remove('drop'); });
document.addEventListener('drop', async (e) => {
  mediaList.classList.remove('drop');
  if (e.defaultPrevented || !e.dataTransfer.files.length) return;
  e.preventDefault();
  const ids = await dropFiles([...e.dataTransfer.files]);
  if (ids.length) toast(`Imported ${ids.length} file(s).`);
});

async function relink(m) {
  const p = await window.mc.relink(m.name);
  if (!p) return;
  const info = await window.mc.probe(p);
  if (info.missing) return;
  store.commit('Relink media', (proj) => {
    const target = proj.media.find((x) => x.id === m.id);
    Object.assign(target, info, { id: m.id, voice: m.voice, missing: false });
  });
  preview.refreshMedia(m.id);
  loadCaches(store.media(m.id));
}

// ---------- project files ----------
async function confirmDiscard() {
  if (!store.dirty) return true;
  const r = confirm('You have unsaved changes. Save them first?\n\nOK = Save, Cancel = keep going without saving');
  if (r) return !!(await saveProject());
  return confirm('Discard unsaved changes?');
}
async function saveProject(as = false) {
  const path = await window.mc.saveProject(store.project, as ? null : store.filePath);
  if (!path) return null;
  store.filePath = path;
  store.dirty = false;
  updateTitle();
  window.mc.clearAutosave();
  toast('Project saved.');
  return path;
}
async function loadProjectData(data, path) {
  preview.pause();
  // Check every file is still where it was (this also lets the app serve it to the preview).
  for (const m of data.media) {
    try {
      const info = await window.mc.probe(m.path);
      m.missing = !!info.missing;
    } catch (_) { m.missing = true; }
  }
  store.mediaCache = {};
  store.load(data, path);
  data.media.forEach(loadCaches);
  const missing = data.media.filter((m) => m.missing);
  if (missing.length) toast(`${missing.length} file(s) are missing. Click them in the media bin to relink.`, 'error');
  store.emit('edit');
  store.dirty = false;
  updateTitle();
  timeline.zoomFit();
}
async function openProject() {
  if (!(await confirmDiscard())) return;
  const r = await window.mc.openProject();
  if (!r) return;
  if (!r.data || !Array.isArray(r.data.clips)) { toast('That file is not a MeanderCut project.', 'error'); return; }
  await loadProjectData(r.data, r.path);
}
async function newProj() {
  if (!(await confirmDiscard())) return;
  preview.pause();
  store.load(newProject());
  store.mediaCache = {};
  updateTitle();
}

// ---------- commands ----------
function editable(c) { const t = store.track(c.trackId); return t && !t.locked; }

const commands = {
  new: newProj,
  open: openProject,
  save: () => saveProject(false),
  saveAs: () => saveProject(true),
  import: async () => { const paths = await window.mc.importMedia(); if (paths.length) { const ids = await importPaths(paths); if (ids.length) toast(`Imported ${ids.length} file(s).`); } },
  record: () => { preview.pause(); recordDialog(store, preview, ui); },
  export: () => { preview.pause(); exportDialog(store, toast); },
  shortcuts: shortcutsDialog,
  undo: () => { const l = store.undo(); if (l) toast(`Undo: ${l}`); },
  redo: () => { const l = store.redo(); if (l) toast(`Redo: ${l}`); },
  play: () => preview.toggle(),
  toStart: () => { store.setPlayhead(0); preview.resync(); },
  toEnd: () => { store.setPlayhead(store.duration()); preview.resync(); },
  prevFrame: () => step(-1), nextFrame: () => step(1),
  split: () => {
    const t = store.playhead;
    let targets = store.selectedClips().filter((c) => editable(c) && t > c.start + EPS && t < c.start + c.duration - EPS);
    if (!targets.length) {
      // Nothing selected: split the main track (lowest video track with a clip here), like CapCut.
      const under = store.project.clips.filter((c) => editable(c) && t > c.start + EPS && t < c.start + c.duration - EPS);
      const order = [...store.project.tracks].reverse().sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'video' ? -1 : 1));
      const main = order.find((tr) => under.some((c) => c.trackId === tr.id));
      targets = main ? under.filter((c) => c.trackId === main.id) : [];
    }
    if (!targets.length) { toast('Move the playhead over a clip to split it.'); return; }
    const ids = targets.map((c) => c.id);
    const right = [];
    store.commit('Split', (p) => { for (const id of ids) { const r = splitClip(p, p.clips.find((c) => c.id === id), t); if (r) right.push(r.id); } });
    store.select(right);
  },
  delete: () => {
    const ids = new Set(store.selectedClips().filter(editable).map((c) => c.id));
    if (!ids.size) return;
    store.commit('Delete', (p) => { p.clips = p.clips.filter((c) => !ids.has(c.id)); });
  },
  rippleDelete: () => {
    const ids = new Set(store.selectedClips().filter(editable).map((c) => c.id));
    if (!ids.size) return;
    store.commit('Ripple delete', (p) => rippleDelete(p, ids));
  },
  duplicate: () => {
    const sel = store.selectedClips().filter(editable);
    if (!sel.length) return;
    const copies = [];
    store.commit('Duplicate', (p) => {
      const end = Math.max(...sel.map((c) => c.start + c.duration));
      const begin = Math.min(...sel.map((c) => c.start));
      for (const c of sel) {
        const copy = Object.assign(JSON.parse(JSON.stringify(c)), { id: uid('clip'), start: c.start + (end - begin) });
        clearRange(p, copy.trackId, copy.start, copy.start + copy.duration);
        p.clips.push(copy);
        copies.push(copy.id);
      }
    });
    store.select(copies);
  },
  detach: () => {
    const sel = store.selectedClips().filter((c) => editable(c) && store.track(c.trackId).kind === 'video');
    const ok = sel.filter((c) => { const m = store.media(c.mediaId); return m && m.hasAudio && !c.audioDetached; });
    if (!ok.length) { toast(sel.length ? 'That clip has no audio to detach (or it is already detached).' : 'Select a video clip first.'); return; }
    const created = [];
    store.commit('Detach audio', (p) => {
      for (const c of ok) {
        const clip = p.clips.find((x) => x.id === c.id);
        const a = detachAudio(p, clip, p.media.find((m) => m.id === clip.mediaId));
        if (a) created.push(a.id);
      }
    });
    store.select(created);
    toast(`Audio separated onto its own track.`);
  },
  extractAudio: async () => {
    const sel = store.selectedClips();
    const c = sel[0];
    const m = c && store.media(c.mediaId);
    if (!m || !m.hasAudio) { toast('Select a clip that has audio.'); return; }
    try {
      const out = await window.mc.extractAudio(m.path, c.in, c.duration * c.speed);
      if (out) { await importPaths([out]); toast('Audio saved and added to the media bin.'); }
    } catch (e) { toast('Could not extract audio: ' + e.message, 'error'); }
  },
  addVideoTrack: () => store.commit('Add video track', (p) => {
    const n = p.tracks.filter((t) => t.kind === 'video').length + 1;
    p.tracks.unshift({ id: uid('trk'), kind: 'video', name: `Video ${n}`, hidden: false, locked: false, muted: false, solo: false, volume: 1 });
  }),
  addAudioTrack: () => store.commit('Add audio track', (p) => {
    const n = p.tracks.filter((t) => t.kind === 'audio').length + 1;
    p.tracks.push({ id: uid('trk'), kind: 'audio', name: `Audio ${n}`, hidden: false, locked: false, muted: false, solo: false, volume: 1 });
  }),
  zoomIn: () => timeline.zoomIn(), zoomOut: () => timeline.zoomOut(), zoomFit: () => timeline.zoomFit(),
  selectAll: () => store.select(store.project.clips.map((c) => c.id)),
};
function step(frames) {
  const fps = store.project.settings.fps;
  preview.pause();
  store.setPlayhead(Math.round((store.playhead + frames / fps) * fps) / fps);
}
function run(cmd) {
  const fn = commands[cmd];
  if (!fn) return;
  Promise.resolve(fn()).catch((e) => { console.error(e); toast(String(e.message || e), 'error'); });
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-cmd]');
  if (b) run(b.dataset.cmd);
});
window.mc.onMenu(run);

// ---------- keyboard ----------
document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' && !['range', 'checkbox'].includes(e.target.type) || tag === 'textarea' || tag === 'select') return;
  if (modalOpen()) {
    if (e.key === 'Escape') closeModal();
    if (e.code === 'Space' && ui.recorderStop) { e.preventDefault(); ui.recorderStop(); }
    return;
  }
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  const map = [
    [e.code === 'Space', 'play'],
    [k === 'arrowleft' && !e.shiftKey, 'prevFrame'], [k === 'arrowright' && !e.shiftKey, 'nextFrame'],
    [k === 'home', 'toStart'], [k === 'end', 'toEnd'],
    [(k === 's' && !ctrl) || (ctrl && k === 'b'), 'split'],
    [(k === 'delete' || k === 'backspace') && e.shiftKey, 'rippleDelete'],
    [(k === 'delete' || k === 'backspace') && !e.shiftKey, 'delete'],
    [ctrl && k === 'a', 'selectAll'],
  ];
  if (k === 'arrowleft' && e.shiftKey) { e.preventDefault(); preview.pause(); store.setPlayhead(store.playhead - 1); return; }
  if (k === 'arrowright' && e.shiftKey) { e.preventDefault(); preview.pause(); store.setPlayhead(store.playhead + 1); return; }
  if (k === 'n' && !ctrl) { timeline.toggleSnap(); toast(`Snapping ${timeline.snapping ? 'on' : 'off'}`); return; }
  if (k === 'escape') { store.select([]); return; }
  for (const [cond, cmd] of map) if (cond) { e.preventDefault(); run(cmd); return; }
});

// ---------- view controls ----------
$('aspectSelect').addEventListener('change', (e) => {
  const a = e.target.value;
  const st = store.project.settings;
  store.commit('Change aspect ratio', (p) => Object.assign(p.settings, sizeFor(a, Math.min(st.width, st.height)), { aspect: a }));
});
$('zoomSelect').addEventListener('change', (e) => preview.setZoom(e.target.value));
$('qualitySelect').addEventListener('change', (e) => preview.setQuality(e.target.value));
$('guidesBtn').addEventListener('click', () => {
  const on = $('guides').classList.toggle('on');
  $('guidesBtn').classList.toggle('on', on);
});

// Resize the timeline by dragging its top edge
$('timelineArea').addEventListener('pointerdown', (e) => {
  const rect = $('timelineArea').getBoundingClientRect();
  if (e.clientY > rect.top + 4) return;
  e.preventDefault();
  const move = (ev) => {
    const hgt = Math.min(window.innerHeight - 260, Math.max(180, window.innerHeight - ev.clientY));
    document.documentElement.style.setProperty('--timeline-h', hgt + 'px');
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); timeline.render(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ---------- autosave & close ----------
setInterval(() => { if (store.dirty && store.project.clips.length) window.mc.autosave({ filePath: store.filePath, project: store.project }); }, 45000);
window.mc.onRequestClose(async () => {
  if (await confirmDiscard()) { await window.mc.clearAutosave(); window.mc.closeNow(); }
});

(async function start() {
  updateTitle();
  renderMedia();
  const saved = await window.mc.readAutosave();
  if (saved && saved.project && saved.project.clips && saved.project.clips.length &&
      confirm('MeanderCut closed before your last changes were saved. Recover them?')) {
    await loadProjectData(saved.project, saved.filePath || null);
    store.dirty = true;
    updateTitle();
  } else if (saved) window.mc.clearAutosave();
})();
