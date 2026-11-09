// Editing-operation tests. Run: node test/state.test.mjs
import assert from 'node:assert/strict';
import { Store, newClip, splitClip, clearRange, rippleDelete, detachAudio, setSpeed, sourceTime, sizeFor } from '../src/renderer/js/state.js';

const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`);
const media = { id: 'm', type: 'video', duration: 20, hasAudio: true, hasVideo: true, width: 1920, height: 1080 };

function fresh() {
  const s = new Store();
  s.project.media.push(media);
  return s;
}

// Split keeps every frame in place
{
  const s = fresh();
  const v = s.project.tracks[0].id;
  const c = newClip(media, v, 2, { in: 3, duration: 10 });
  s.project.clips.push(c);
  const r = splitClip(s.project, c, 6);
  near(c.duration, 4, 'left duration'); near(r.start, 6, 'right start'); near(r.in, 7, 'right in');
  for (const t of [2.5, 5.9]) near(sourceTime(c, t), t - 2 + 3, 'left source time');
  for (const t of [6, 11]) near(sourceTime(r, t), t - 2 + 3, 'right source time');
}

// Split a reversed, sped-up clip: what you see must not change
{
  const s = fresh();
  const v = s.project.tracks[0].id;
  const c = newClip(media, v, 0, { in: 2, duration: 4, speed: 2, reversed: true });
  s.project.clips.push(c);
  const before = [0.5, 1.5, 2.5, 3.5].map((t) => sourceTime(c, t));
  const r = splitClip(s.project, c, 2);
  const after = [0.5, 1.5].map((t) => sourceTime(c, t)).concat([2.5, 3.5].map((t) => sourceTime(r, t)));
  before.forEach((b, i) => near(after[i], b, 'reversed split source time ' + i));
}

// Overwrite in the middle of a reversed clip keeps both sides correct
{
  const s = fresh();
  const v = s.project.tracks[0].id;
  const c = newClip(media, v, 0, { in: 1, duration: 10, reversed: true });
  s.project.clips.push(c);
  const before = { 1: sourceTime(c, 1), 8: sourceTime(c, 8) };
  clearRange(s.project, v, 3, 6);
  const [left, right] = s.project.clips.sort((a, b) => a.start - b.start);
  near(left.duration, 3, 'left dur'); near(right.start, 6, 'right start'); near(right.duration, 4, 'right dur');
  near(sourceTime(left, 1), before[1], 'left keeps picture');
  near(sourceTime(right, 8), before[8], 'right keeps picture');
}

// Ripple delete closes the gap on that track only
{
  const s = fresh();
  const [v, a] = s.project.tracks;
  s.project.clips.push(
    newClip(media, v.id, 0, { id: 'x', duration: 3 }),
    newClip(media, v.id, 3, { id: 'y', duration: 2 }),
    newClip(media, v.id, 5, { id: 'z', duration: 4 }),
    newClip(media, a.id, 6, { id: 'w', duration: 1 }),
  );
  rippleDelete(s.project, new Set(['y']));
  near(s.clip('z').start, 3, 'z pulled left'); near(s.clip('w').start, 6, 'other track untouched');
}

// Detach audio creates a matching clip and silences the video's own audio
{
  const s = fresh();
  const v = s.project.tracks[0].id;
  const c = newClip(media, v, 1, { in: 2, duration: 5, speed: 1.5, volume: 0.7 });
  s.project.clips.push(c);
  const a = detachAudio(s.project, c, media);
  assert.ok(a && c.audioDetached, 'detached');
  assert.equal(s.track(a.trackId).kind, 'audio');
  assert.ok(!s.track(a.trackId).voice, 'not placed on the voice-over track');
  near(a.start, 1, 'same start'); near(a.in, 2, 'same in'); near(a.speed, 1.5, 'same speed'); near(a.volume, 0.7, 'same volume');
  assert.equal(detachAudio(s.project, c, media), null, 'cannot detach twice');
}

// Speed keeps the same source span
{
  const c = newClip(media, 't', 0, { duration: 8 });
  setSpeed(c, 2); near(c.duration, 4, '2x halves length');
  setSpeed(c, 0.5); near(c.duration, 16, '0.5x doubles length');
}

// Undo / redo
{
  const s = fresh();
  const v = s.project.tracks[0].id;
  s.commit('add', (p) => p.clips.push(newClip(media, v, 0)));
  assert.equal(s.project.clips.length, 1);
  s.undo(); assert.equal(s.project.clips.length, 0);
  s.redo(); assert.equal(s.project.clips.length, 1);
}

// Aspect sizes
assert.deepEqual(sizeFor('16:9', 2160), { width: 3840, height: 2160 });
assert.deepEqual(sizeFor('9:16', 1080), { width: 1080, height: 1920 });
assert.deepEqual(sizeFor('1:1', 1080), { width: 1080, height: 1080 });

console.log('ok  editing operations (split, overwrite, reverse, ripple, detach, speed, undo, aspect)');
