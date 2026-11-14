// Project model, editing operations and undo history. No DOM code here.

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
export const EPS = 1e-4;
export const IMAGE_DEFAULT_DURATION = 5;

export function newProject() {
  return {
    version: 1,
    name: 'Untitled',
    settings: { width: 1920, height: 1080, fps: 30, aspect: '16:9', background: '#000000' },
    media: [],
    tracks: [
      { id: uid('trk'), kind: 'video', name: 'Video 1', hidden: false, locked: false, muted: false, solo: false, volume: 1 },
      { id: uid('trk'), kind: 'audio', name: 'Audio 1', hidden: false, locked: false, muted: false, solo: false, volume: 1 },
      { id: uid('trk'), kind: 'audio', name: 'Voice-over', hidden: false, locked: false, muted: false, solo: false, volume: 1, voice: true },
    ],
    clips: [],
  };
}

export function newClip(media, trackId, start, extra = {}) {
  const dur = media.type === 'image' ? IMAGE_DEFAULT_DURATION : Math.max(0.05, media.duration || 0);
  return Object.assign({
    id: uid('clip'), trackId, mediaId: media.id, start, duration: dur, in: 0,
    speed: 1, reversed: false,
    volume: 1, fadeIn: 0, fadeOut: 0, muted: false, audioDetached: false,
    opacity: 1, brightness: 0, contrast: 1, saturation: 1, gamma: 1,
    fit: 'fit', scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false,
    crop: { l: 0, r: 0, t: 0, b: 0 },
  }, extra);
}

export const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1], '4:5': [4, 5], '4:3': [4, 3], '21:9': [21, 9] };
/** Resolution for an aspect ratio, where `short` is the length of the shorter side. */
export function sizeFor(aspect, short) {
  const [a, b] = ASPECTS[aspect] || [16, 9];
  const even = (v) => Math.round(v / 2) * 2;
  return a >= b ? { width: even(short * a / b), height: short } : { width: short, height: even(short * b / a) };
}

export class Store {
  constructor() {
    this.project = newProject();
    this.filePath = null;
    this.dirty = false;
    this.selection = new Set();
    this.playhead = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.mediaCache = {}; // id -> { thumb, wave }
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what = 'all') { for (const fn of this.listeners) fn(what); }

  // ----- lookups -----
  media(id) { return this.project.media.find((m) => m.id === id); }
  track(id) { return this.project.tracks.find((t) => t.id === id); }
  clip(id) { return this.project.clips.find((c) => c.id === id); }
  clipsOn(trackId) { return this.project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start); }
  duration() { return this.project.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0); }
  selectedClips() { return [...this.selection].map((id) => this.clip(id)).filter(Boolean); }
  frame() { return 1 / this.project.settings.fps; }

  // ----- history -----
  snapshot() { return JSON.stringify(this.project); }
  /** Wrap every edit: records undo state, marks dirty, re-renders. */
  commit(label, fn) {
    const before = this.snapshot();
    const r = fn(this.project);
    if (this.snapshot() === before) return r;
    this.undoStack.push({ label, data: before });
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.dirty = true;
    this.pruneSelection();
    this.emit('edit');
    return r;
  }
  /** For drags: take one snapshot at the start, apply live changes, then finish. */
  beginLive() { this._live = this.snapshot(); }
  endLive(label) {
    if (this._live && this._live !== this.snapshot()) {
      this.undoStack.push({ label, data: this._live });
      this.redoStack = [];
      this.dirty = true;
      this.emit('edit');
    }
    this._live = null;
  }
  undo() {
    const s = this.undoStack.pop();
    if (!s) return null;
    this.redoStack.push({ label: s.label, data: this.snapshot() });
    this.project = JSON.parse(s.data);
    this.dirty = true;
    this.pruneSelection();
    this.emit('edit');
    return s.label;
  }
  redo() {
    const s = this.redoStack.pop();
    if (!s) return null;
    this.undoStack.push({ label: s.label, data: this.snapshot() });
    this.project = JSON.parse(s.data);
    this.dirty = true;
    this.pruneSelection();
    this.emit('edit');
    return s.label;
  }
  load(project, filePath = null) {
    this.project = project;
    this.filePath = filePath;
    this.dirty = false;
    this.selection.clear();
    this.playhead = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.emit('load');
  }
  pruneSelection() { for (const id of [...this.selection]) if (!this.clip(id)) this.selection.delete(id); }
  select(ids, additive = false) {
    if (!additive) this.selection.clear();
    for (const id of ids) {
      if (additive && this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    }
    this.emit('selection');
  }
  setPlayhead(t) {
    this.playhead = Math.max(0, t);
    this.emit('playhead');
  }
}

// ----- editing operations (operate on a project object, called inside commit) -----

/** Longest the clip can be, given its source media and speed. */
export function maxDuration(clip, media) {
  if (!media || media.type === 'image') return Infinity;
  return Math.max(0.05, (media.duration - clip.in) / clip.speed);
}

/** Overwrite: make room on a track between start and end by trimming, splitting or removing clips. */
export function clearRange(project, trackId, start, end, exceptIds = new Set()) {
  const out = [];
  for (const c of project.clips) {
    if (c.trackId !== trackId || exceptIds.has(c.id)) { out.push(c); continue; }
    const cEnd = c.start + c.duration;
    if (cEnd <= start + EPS || c.start >= end - EPS) { out.push(c); continue; }
    if (c.start >= start - EPS && cEnd <= end + EPS) continue; // fully covered: remove
    if (c.start < start && cEnd > end) { // covers the range: split into two
      const right = Object.assign(JSON.parse(JSON.stringify(c)), { id: uid('clip') });
      c.duration = start - c.start;
      const cut = end - right.start;
      right.start = end;
      right.in += right.reversed ? 0 : cut * right.speed;
      right.duration -= cut;
      // Reversed clips play their source backwards, so the left piece keeps the later source span.
      if (c.reversed) c.in += ((end - start) + right.duration) * c.speed;
      out.push(c, right);
      continue;
    }
    if (c.start < start) { // overlaps on the right: trim tail
      const cut = cEnd - start;
      if (c.reversed) c.in += cut * c.speed;
      c.duration -= cut;
    } else { // overlaps on the left: trim head
      const cut = end - c.start;
      if (!c.reversed) c.in += cut * c.speed;
      c.start = end;
      c.duration -= cut;
    }
    out.push(c);
  }
  project.clips = out.filter((c) => c.duration > EPS);
}

/** Split a clip at timeline time t. Returns the new right-hand clip, or null. */
export function splitClip(project, clip, t) {
  if (t <= clip.start + EPS || t >= clip.start + clip.duration - EPS) return null;
  const right = Object.assign(JSON.parse(JSON.stringify(clip)), { id: uid('clip') });
  const leftDur = t - clip.start;
  right.start = t;
  right.duration = clip.duration - leftDur;
  if (clip.reversed) {
    // Reversed clips play their source backwards, so the left half uses the later source span.
    clip.in = clip.in + right.duration * clip.speed;
  } else {
    right.in = clip.in + leftDur * clip.speed;
  }
  clip.duration = leftDur;
  right.fadeIn = 0;
  clip.fadeOut = 0;
  project.clips.push(right);
  return right;
}

/** Ripple delete: remove clips and pull everything after them on the same track left. */
export function rippleDelete(project, ids) {
  const removed = project.clips.filter((c) => ids.has(c.id));
  project.clips = project.clips.filter((c) => !ids.has(c.id));
  // Process from the right so shifts don't interfere.
  removed.sort((a, b) => b.start - a.start);
  for (const r of removed) {
    for (const c of project.clips) {
      if (c.trackId === r.trackId && c.start >= r.start + r.duration - EPS) c.start = Math.max(0, c.start - r.duration);
    }
  }
}

/** Separate audio from a video clip onto an audio track. Returns the new audio clip. */
export function detachAudio(project, clip, media) {
  if (!media || !media.hasAudio || clip.audioDetached) return null;
  let track = project.tracks.find((t) => t.kind === 'audio' && !t.voice && !t.locked &&
    !project.clips.some((c) => c.trackId === t.id && c.start < clip.start + clip.duration - EPS && c.start + c.duration > clip.start + EPS));
  if (!track) {
    const n = project.tracks.filter((t) => t.kind === 'audio').length + 1;
    track = { id: uid('trk'), kind: 'audio', name: `Audio ${n}`, hidden: false, locked: false, muted: false, solo: false, volume: 1 };
    const lastVideo = project.tracks.map((t) => t.kind).lastIndexOf('video');
    project.tracks.splice(lastVideo + 1, 0, track);
  }
  const a = newClip(media, track.id, clip.start, {
    in: clip.in, duration: clip.duration, speed: clip.speed, reversed: clip.reversed,
    volume: clip.volume, fadeIn: clip.fadeIn, fadeOut: clip.fadeOut, muted: clip.muted, detachedFrom: clip.id,
  });
  project.clips.push(a);
  clip.audioDetached = true;
  return a;
}

/** Change speed while keeping the same source span. */
export function setSpeed(clip, speed) {
  speed = Math.min(16, Math.max(0.1, speed));
  const span = clip.duration * clip.speed;
  clip.speed = speed;
  clip.duration = span / speed;
}

/** All snap points (seconds) on the timeline, excluding some clips. */
export function snapPoints(project, playhead, exclude = new Set()) {
  const pts = [0, playhead];
  for (const c of project.clips) {
    if (exclude.has(c.id)) continue;
    pts.push(c.start, c.start + c.duration);
  }
  return pts;
}

export function formatTime(sec, fps = 30, withFrames = true) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = Math.floor(sec) % 60;
  const fr = Math.floor((sec - Math.floor(sec)) * fps + 1e-6);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return withFrames ? `${p(h)}:${p(m)}:${p(s)}:${p(fr)}` : (h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`);
}

/** Source time (seconds into the media file) shown at timeline time t. */
export function sourceTime(clip, t) {
  const local = Math.min(Math.max(0, t - clip.start), clip.duration);
  return clip.reversed ? clip.in + (clip.duration - local) * clip.speed : clip.in + local * clip.speed;
}

/**
 * Magnetic drop: where a new clip of length `dur` dropped at time `t` should land on a track,
 * so it sits flush against its neighbours instead of leaving a gap or covering another clip.
 *  - dropped on a clip: goes before or after it, whichever edge is nearer
 *  - dropped in a gap: butts up against the previous clip's end, or the next clip's start if that is closer
 *  - empty track: stays at `t`
 * Returns { start, push }: later clips on the track move right by `push` seconds to make room.
 */
export function magneticDrop(project, trackId, t, dur) {
  const clips = project.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start);
  if (!clips.length) return { start: Math.max(0, t), push: 0 };
  let start;
  const hit = clips.find((c) => t >= c.start && t < c.start + c.duration);
  if (hit) {
    start = t - hit.start < hit.duration / 2 ? hit.start : hit.start + hit.duration;
  } else {
    const prev = [...clips].reverse().find((c) => c.start + c.duration <= t + EPS);
    const next = clips.find((c) => c.start > t);
    const left = prev ? prev.start + prev.duration : 0;
    start = left;
    if (next) {
      const right = Math.max(left, next.start - dur);
      if (Math.abs(right - t) < Math.abs(left - t)) start = right;
    }
  }
  const blocker = clips.find((c) => c.start >= start - EPS && c.start < start + dur - EPS);
  return { start, push: blocker ? start + dur - blocker.start : 0 };
}

/** Apply a magnetic drop's push: move every clip on the track that starts at or after `from` right by `push`. */
export function pushClips(project, trackId, from, push) {
  if (push <= EPS) return;
  for (const c of project.clips) if (c.trackId === trackId && c.start >= from - EPS) c.start += push;
}
