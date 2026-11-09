'use strict';
/**
 * MeanderCut export engine.
 * Turns a project (media + tracks + clips) into an FFmpeg command line.
 * Pure functions only, so it can be tested without Electron.
 */

const FORMATS = {
  mp4_h264: { label: 'MP4 - H.264', ext: 'mp4', video: 'h264', audio: 'aac' },
  mp4_h265: { label: 'MP4 - H.265 / HEVC', ext: 'mp4', video: 'h265', audio: 'aac' },
  mov_prores: { label: 'MOV - ProRes 422 HQ (editing master)', ext: 'mov', video: 'prores', audio: 'pcm' },
  mkv_h264: { label: 'MKV - H.264', ext: 'mkv', video: 'h264', audio: 'aac' },
  mp3: { label: 'Audio only - MP3', ext: 'mp3', video: null, audio: 'mp3' },
  wav: { label: 'Audio only - WAV', ext: 'wav', video: null, audio: 'wav' },
};

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const f = (v) => Number(num(v, 0).toFixed(6)).toString();
const even = (v) => Math.max(2, Math.round(v / 2) * 2);

function clipDefaults(c) {
  return Object.assign({
    in: 0, speed: 1, reversed: false, volume: 1, fadeIn: 0, fadeOut: 0, muted: false,
    audioDetached: false, opacity: 1, brightness: 0, contrast: 1, saturation: 1, gamma: 1,
    fit: 'fit', scale: 1, x: 0, y: 0, rotation: 0, flipH: false, flipV: false,
    crop: { l: 0, r: 0, t: 0, b: 0 },
  }, c, { crop: Object.assign({ l: 0, r: 0, t: 0, b: 0 }, c.crop || {}) });
}

function projectDuration(project) {
  let end = 0;
  for (const c of project.clips) end = Math.max(end, c.start + c.duration);
  return end;
}

/** atempo only accepts 0.5..100 per instance (older builds 0.5..2), so chain it. */
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s > 2) { parts.push('atempo=2'); s /= 2; }
  while (s < 0.5) { parts.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-6) parts.push('atempo=' + f(s));
  return parts;
}

/** Size of a clip on a W x H canvas after crop, fit mode and scale. */
function layoutClip(c, media, W, H) {
  const mw = num(media.width, W), mh = num(media.height, H);
  const cw = mw * (1 - c.crop.l - c.crop.r);
  const ch = mh * (1 - c.crop.t - c.crop.b);
  let w, h;
  if (c.fit === 'stretch') { w = W; h = H; }
  else {
    const k = c.fit === 'fill' ? Math.max(W / cw, H / ch) : Math.min(W / cw, H / ch);
    w = cw * k; h = ch * k;
  }
  return { w: even(w * c.scale), h: even(h * c.scale) };
}

function videoEncoderArgs(o) {
  const enc = o.encoder || (o.format.video === 'h265' ? 'libx265' : 'libx264');
  const a = ['-c:v', enc];
  if (o.format.video === 'prores') {
    return ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le'];
  }
  const crf = num(o.crf, 18);
  if (enc.startsWith('lib')) {
    a.push('-preset', o.preset || 'medium');
    if (o.rateControl === 'bitrate') {
      const b = Math.round(num(o.bitrateKbps, 40000));
      a.push('-b:v', b + 'k', '-maxrate', Math.round(b * 1.5) + 'k', '-bufsize', b * 2 + 'k');
    } else a.push('-crf', String(crf));
    if (enc === 'libx264') a.push('-profile:v', 'high');
  } else if (enc.includes('nvenc')) {
    a.push('-preset', 'p5');
    if (o.rateControl === 'bitrate') a.push('-rc', 'vbr', '-b:v', Math.round(num(o.bitrateKbps, 40000)) + 'k');
    else a.push('-rc', 'vbr', '-cq', String(crf), '-b:v', '0');
  } else if (enc.includes('qsv')) {
    if (o.rateControl === 'bitrate') a.push('-b:v', Math.round(num(o.bitrateKbps, 40000)) + 'k');
    else a.push('-global_quality', String(crf));
  } else if (enc.includes('amf')) {
    if (o.rateControl === 'bitrate') a.push('-rc', 'vbr_peak', '-b:v', Math.round(num(o.bitrateKbps, 40000)) + 'k');
    else a.push('-rc', 'cqp', '-qp_i', String(crf), '-qp_p', String(crf));
  }
  if (o.format.video === 'h265') a.push('-tag:v', 'hvc1');
  const pix = o.bitDepth === 10 ? (enc.includes('nvenc') || enc.includes('qsv') || enc.includes('amf') ? 'p010le' : 'yuv420p10le') : 'yuv420p';
  a.push('-pix_fmt', pix);
  return a;
}

function audioEncoderArgs(o) {
  const sr = String(num(o.sampleRate, 48000));
  const ch = String(num(o.channels, 2));
  const br = Math.round(num(o.audioBitrateKbps, 320)) + 'k';
  switch (o.format.audio) {
    case 'pcm': return ['-c:a', 'pcm_s24le', '-ar', sr, '-ac', ch];
    case 'wav': return ['-c:a', o.wavDepth === 16 ? 'pcm_s16le' : 'pcm_s24le', '-ar', sr, '-ac', ch];
    case 'mp3': return ['-c:a', 'libmp3lame', '-b:a', br, '-ar', sr, '-ac', ch];
    default: return ['-c:a', 'aac', '-b:a', br, '-ar', sr, '-ac', ch];
  }
}

/**
 * @returns {{args: string[], filter: string, duration: number}}
 * The filter graph is returned separately; the caller writes it to a file and
 * passes -filter_complex_script so long projects don't hit Windows' command-line limit.
 */
function buildExport(project, opts) {
  const format = FORMATS[opts.formatId] || FORMATS.mp4_h264;
  const o = Object.assign({}, opts, { format });
  const W = even(num(o.width, project.settings.width));
  const H = even(num(o.height, project.settings.height));
  const FPS = num(o.fps, project.settings.fps);
  const total = projectDuration(project);
  if (total <= 0) throw new Error('The timeline is empty.');

  const media = new Map(project.media.map((m) => [m.id, m]));
  const tracks = new Map(project.tracks.map((t, i) => [t.id, Object.assign({ index: i }, t)]));
  const inputs = [];
  const chains = [];
  const audioLabels = [];
  const wantVideo = !!format.video;

  // Video tracks: the first video track in the list is the top layer.
  const videoTracks = project.tracks.filter((t) => t.kind === 'video');
  const layerOf = (trackId) => videoTracks.length - videoTracks.findIndex((t) => t.id === trackId);

  const clips = project.clips.map(clipDefaults)
    .filter((c) => tracks.has(c.trackId) && media.has(c.mediaId) && c.duration > 0)
    .sort((a, b) => {
      const ta = tracks.get(a.trackId), tb = tracks.get(b.trackId);
      if (ta.kind !== tb.kind) return ta.kind === 'video' ? -1 : 1;
      return ta.kind === 'video' ? layerOf(a.trackId) - layerOf(b.trackId) || a.start - b.start : a.start - b.start;
    });

  let base = '[base]';
  if (wantVideo) chains.push(`color=c=${(project.settings.background || '#000000').replace('#', '0x')}:s=${W}x${H}:r=${f(FPS)}:d=${f(total)},format=yuv420p[base]`);

  let ov = 0;
  for (const c of clips) {
    const t = tracks.get(c.trackId);
    const m = media.get(c.mediaId);
    const srcDur = m.type === 'image' ? c.duration : c.duration * c.speed;
    const visual = t.kind === 'video' && !t.hidden && (m.type === 'video' || m.type === 'image') && wantVideo;
    const audible = !t.muted && !c.muted && m.hasAudio && m.type !== 'image' &&
      (t.kind === 'audio' || !c.audioDetached) && c.volume > 0 && num(t.volume, 1) > 0;
    if (!visual && !audible) continue;

    const idx = inputs.length;
    if (m.type === 'image') inputs.push(['-loop', '1', '-framerate', f(FPS), '-t', f(srcDur), '-i', m.path]);
    else inputs.push(['-ss', f(c.in), '-t', f(srcDur), '-i', m.path]);

    if (visual) {
      const L = layoutClip(c, m, W, H);
      const v = [];
      if (c.reversed && m.type !== 'image') v.push('reverse');
      v.push(m.type === 'image' ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${f(c.speed)}`);
      v.push(`fps=${f(FPS)}`);
      const { l, r, t: ct, b } = c.crop;
      if (l || r || ct || b) v.push(`crop=iw*${f(1 - l - r)}:ih*${f(1 - ct - b)}:iw*${f(l)}:ih*${f(ct)}`);
      v.push(`scale=${L.w}:${L.h}:flags=lanczos`, 'setsar=1');
      if (c.flipH) v.push('hflip');
      if (c.flipV) v.push('vflip');
      if (c.brightness || c.contrast !== 1 || c.saturation !== 1 || c.gamma !== 1) {
        v.push(`eq=brightness=${f(c.brightness)}:contrast=${f(c.contrast)}:saturation=${f(c.saturation)}:gamma=${f(c.gamma)}`);
      }
      v.push('format=rgba');
      if (c.rotation) {
        const a = `${f(c.rotation)}*PI/180`;
        v.push(`rotate=${a}:ow=rotw(${a}):oh=roth(${a}):c=none`);
      }
      if (c.opacity < 1) v.push(`colorchannelmixer=aa=${f(Math.max(0, c.opacity))}`);
      v.push(`setpts=PTS+${f(c.start)}/TB`);
      chains.push(`[${idx}:v]${v.join(',')}[v${ov}]`);
      const x = `(main_w-overlay_w)/2+${f(c.x)}*main_w`;
      const y = `(main_h-overlay_h)/2+${f(c.y)}*main_h`;
      chains.push(`${base}[v${ov}]overlay=x='${x}':y='${y}':eof_action=pass:enable='between(t,${f(c.start)},${f(c.start + c.duration)})'[o${ov}]`);
      base = `[o${ov}]`;
      ov++;
    }

    if (audible) {
      const a = ['asetpts=PTS-STARTPTS'];
      if (c.reversed) a.push('areverse');
      a.push(...atempoChain(c.speed));
      a.push(`atrim=0:${f(c.duration)}`);
      a.push(`volume=${f(c.volume * num(t.volume, 1))}`);
      if (c.fadeIn > 0) a.push(`afade=t=in:st=0:d=${f(c.fadeIn)}`);
      if (c.fadeOut > 0) a.push(`afade=t=out:st=${f(Math.max(0, c.duration - c.fadeOut))}:d=${f(c.fadeOut)}`);
      a.push(`aresample=${num(o.sampleRate, 48000)}`, 'aformat=sample_fmts=fltp:channel_layouts=stereo');
      const ms = Math.round(c.start * 1000);
      if (ms > 0) a.push(`adelay=${ms}:all=1`);
      const lbl = `[a${audioLabels.length}]`;
      chains.push(`[${idx}:a]${a.join(',')}${lbl}`);
      audioLabels.push(lbl);
    }
  }

  if (wantVideo) chains.push(`${base}format=yuv420p[vout]`);
  const sr = num(o.sampleRate, 48000);
  if (audioLabels.length) {
    chains.push(`${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0,apad,atrim=0:${f(total)}[aout]`);
  } else {
    chains.push(`anullsrc=r=${sr}:cl=stereo,atrim=0:${f(total)}[aout]`);
  }

  const args = ['-hide_banner', '-y'];
  for (const i of inputs) args.push(...i);
  args.push('-filter_complex_script', '__FILTER__');
  if (wantVideo) args.push('-map', '[vout]', ...videoEncoderArgs(o), '-r', f(FPS));
  args.push('-map', '[aout]', ...audioEncoderArgs(o));
  if (format.ext === 'mp4' || format.ext === 'mov') args.push('-movflags', '+faststart');
  args.push('-t', f(total), '-progress', 'pipe:1', '-nostats', o.outPath);

  return { args, filter: chains.join(';\n'), duration: total, width: W, height: H };
}

module.exports = { buildExport, projectDuration, atempoChain, layoutClip, FORMATS, clipDefaults };
