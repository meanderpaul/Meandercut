'use strict';
// Renders a small multi-track project with the real export engine.
// Run: npm test   (needs ffmpeg + ffprobe on PATH, or the bundled ffmpeg-static)
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildExport } = require('../src/main/exporter');

const tryReq = (m, f) => { try { const r = require(m); return f ? r[f] : r; } catch (_) { return null; } };
const ffmpeg = process.env.FFMPEG || tryReq('ffmpeg-static') || 'ffmpeg';
const ffprobe = process.env.FFPROBE || tryReq('ffprobe-static', 'path') || 'ffprobe';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meandercut-test-'));
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();

// Test media
const vid = path.join(dir, 'clip.mp4');
const tone = path.join(dir, 'tone.wav');
const img = path.join(dir, 'pic.png');
run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:d=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', vid]);
run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'sine=f=880:d=4', tone]);
run(ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=red:s=400x400', '-frames:v', '1', img]);

const project = {
  settings: { width: 1920, height: 1080, fps: 30, background: '#000000' },
  media: [
    { id: 'm1', path: vid, type: 'video', duration: 6, width: 1280, height: 720, hasAudio: true, hasVideo: true },
    { id: 'm2', path: tone, type: 'audio', duration: 4, hasAudio: true },
    { id: 'm3', path: img, type: 'image', width: 400, height: 400 },
  ],
  tracks: [
    { id: 'v2', kind: 'video', name: 'Video 2' },
    { id: 'v1', kind: 'video', name: 'Video 1' },
    { id: 'a1', kind: 'audio', name: 'Audio 1', volume: 0.8 },
    { id: 'a2', kind: 'audio', name: 'Voice-over' },
  ],
  clips: [
    { id: 'c1', trackId: 'v1', mediaId: 'm1', start: 0, duration: 3, in: 1, brightness: 0.05 },
    { id: 'c2', trackId: 'v1', mediaId: 'm1', start: 3, duration: 2, in: 0, speed: 2, reversed: true, audioDetached: true },
    { id: 'c3', trackId: 'a1', mediaId: 'm1', start: 3, duration: 2, in: 0, speed: 2, fadeIn: 0.3 },
    { id: 'c4', trackId: 'v2', mediaId: 'm3', start: 1, duration: 2, scale: 0.3, x: 0.3, y: -0.3, opacity: 0.7, rotation: 15 },
    { id: 'c5', trackId: 'a2', mediaId: 'm2', start: 0.5, duration: 3, volume: 0.5, fadeOut: 1 },
  ],
};

function render(name, opts) {
  const out = path.join(dir, name);
  const job = buildExport(project, Object.assign({ outPath: out }, opts));
  const script = path.join(dir, name + '.filter.txt');
  fs.writeFileSync(script, job.filter);
  const args = job.args.map((a) => (a === '__FILTER__' ? script : a));
  const t0 = Date.now();
  run(ffmpeg, args);
  const info = JSON.parse(run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', out]));
  const dur = Number(info.format.duration);
  if (Math.abs(dur - job.duration) > 0.15) throw new Error(`${name}: duration ${dur} != ${job.duration}`);
  console.log(`ok  ${name.padEnd(16)} ${info.streams.map((s) => s.codec_name + (s.width ? ` ${s.width}x${s.height}` : '')).join(' + ')}  ${dur.toFixed(2)}s  (${Date.now() - t0}ms)`);
  return out;
}

render('hd.mp4', { formatId: 'mp4_h264', crf: 23, preset: 'ultrafast' });
render('uhd-4k.mp4', { formatId: 'mp4_h264', width: 3840, height: 2160, fps: 30, rateControl: 'bitrate', bitrateKbps: 45000, preset: 'ultrafast' });
render('hevc.mp4', { formatId: 'mp4_h265', width: 1280, height: 720, crf: 28, preset: 'ultrafast' });
render('master.mov', { formatId: 'mov_prores', width: 1280, height: 720 });
render('mix.wav', { formatId: 'wav', sampleRate: 48000 });
render('mix.mp3', { formatId: 'mp3', audioBitrateKbps: 192 });

// Frame check: the semi-transparent red picture-in-picture must be over the frame at t=2 and gone after t=3.
// Compare the same pixel against a render with that clip removed.
const pixel = (file, t) => [...execFileSync(ffmpeg, ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
  '-vf', 'crop=20:20:1430:250,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])];
const withPip = path.join(dir, 'hd.mp4');
project.clips = project.clips.filter((c) => c.id !== 'c4');
const noPip = render('no-pip.mp4', { formatId: 'mp4_h264', crf: 23, preset: 'ultrafast' });
const diff = (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0);
if (diff(pixel(withPip, 2), pixel(noPip, 2)) < 30) throw new Error('overlay missing at t=2');
if (diff(pixel(withPip, 4), pixel(noPip, 4)) > 30) throw new Error('overlay still visible at t=4');
console.log('ok  overlay timing');
console.log('\nAll exports passed. Output in', dir);
