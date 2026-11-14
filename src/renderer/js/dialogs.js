// Modal dialogs: export, voice-over recorder, shortcuts.
import { sizeFor, ASPECTS, formatTime, newClip, clearRange, uid } from './state.js';

const backdrop = document.getElementById('modalBackdrop');
const modal = document.getElementById('modal');
let onCloseFn = null;
let closable = true;

export function openModal(title, { wide = false, onClose = null } = {}) {
  modal.innerHTML = '';
  modal.style.width = wide ? '680px' : '560px';
  const head = document.createElement('h2');
  head.textContent = title;
  const x = document.createElement('button');
  x.textContent = '✕';
  x.onclick = () => closeModal();
  head.appendChild(x);
  const body = document.createElement('div'); body.className = 'body';
  const foot = document.createElement('div'); foot.className = 'foot';
  modal.append(head, body, foot);
  backdrop.classList.remove('hidden');
  onCloseFn = onClose;
  closable = true;
  return { body, foot, head };
}
export function closeModal(force = false) {
  if (!closable && !force) return;
  backdrop.classList.add('hidden');
  const fn = onCloseFn; onCloseFn = null;
  if (fn) fn();
}
export const modalOpen = () => !backdrop.classList.contains('hidden');
backdrop.addEventListener('pointerdown', (e) => { if (e.target === backdrop) closeModal(); });

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
function field(body, label, control, extra) {
  const r = el('div', extra ? 'field' : 'field two');
  r.append(el('label', '', label), control);
  if (extra) r.appendChild(extra);
  body.appendChild(r);
  return r;
}
function select(options, value) {
  const s = el('select');
  for (const [v, t] of options) s.appendChild(new Option(t, v));
  if (value !== undefined) s.value = String(value);
  return s;
}
function btn(text, cls = 'btn') { return el('button', cls, text); }

// ---------------------------------------------------------------- Export
let encoderCache = null;
const lastExport = {};

export async function exportDialog(store, toast) {
  const p = store.project;
  if (store.duration() <= 0) { toast('Add something to the timeline first.'); return; }
  const missing = p.media.filter((m) => m.missing && p.clips.some((c) => c.mediaId === m.id));
  if (missing.length) { toast(`Relink missing media first: ${missing.map((m) => m.name).join(', ')}`, 'error'); return; }

  const { body, foot } = openModal('Export', { wide: true });
  const formats = await window.mc.exportFormats();
  const st = p.settings;
  const aspect = ASPECTS[st.aspect] ? st.aspect : null;

  body.appendChild(el('h3', '', 'Video'));
  const fmt = select(Object.entries(formats).map(([k, v]) => [k, v.label]), lastExport.formatId || 'mp4_h264');
  field(body, 'Format', fmt);

  const resOptions = [['project', `Project size (${st.width} × ${st.height})`]];
  const resMap = { project: { width: st.width, height: st.height } };
  for (const [short, label] of [[720, '720p HD'], [1080, '1080p Full HD'], [1440, '1440p 2K'], [2160, '2160p 4K UHD']]) {
    const sz = aspect ? sizeFor(aspect, short) : { width: Math.round(short * st.width / Math.min(st.width, st.height) / 2) * 2, height: Math.round(short * st.height / Math.min(st.width, st.height) / 2) * 2 };
    resMap[short] = sz;
    resOptions.push([String(short), `${label} (${sz.width} × ${sz.height})`]);
  }
  if (!aspect || st.width >= st.height) { resMap.dci = { width: 4096, height: 2160 }; resOptions.push(['dci', 'DCI 4K (4096 × 2160)']); }
  const res = select(resOptions, lastExport.res || 'project');
  const resRow = field(body, 'Resolution', res);

  const fpsSel = select([23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120].map((f) => [f, `${f} fps`]), lastExport.fps || st.fps);
  const fpsRow = field(body, 'Frame rate', fpsSel);

  if (!encoderCache) encoderCache = await window.mc.exportEncoders();
  const encSel = select([]);
  const encRow = field(body, 'Encoder', encSel);

  const mode = select([['crf', 'Constant quality (recommended)'], ['bitrate', 'Target bitrate']], lastExport.rateControl || 'crf');
  const modeRow = field(body, 'Rate control', mode);

  const crf = el('input'); Object.assign(crf, { type: 'range', min: 0, max: 40, step: 1, value: lastExport.crf ?? 18 });
  const crfVal = el('span', 'muted small');
  const crfRow = field(body, 'Quality', crf, crfVal);

  const br = el('input'); Object.assign(br, { type: 'number', min: 500, max: 400000, step: 500 });
  br.onkeydown = (e) => e.stopPropagation();
  const brRow = field(body, 'Bitrate (kbps)', br, el('span', 'muted small', 'kbps'));

  const preset = select(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'].map((x) => [x, x]), lastExport.preset || 'medium');
  const presetRow = field(body, 'Encode speed', preset);

  const tenBit = el('input'); tenBit.type = 'checkbox'; tenBit.checked = !!lastExport.tenBit;
  const tenRow = field(body, '10-bit colour', tenBit);

  body.appendChild(el('h3', '', 'Audio'));
  const sr = select([[44100, '44.1 kHz'], [48000, '48 kHz (video standard)'], [96000, '96 kHz']], lastExport.sampleRate || 48000);
  field(body, 'Sample rate', sr);
  const abr = select([[128, '128 kbps'], [192, '192 kbps'], [256, '256 kbps'], [320, '320 kbps']], lastExport.audioBitrateKbps || 320);
  const abrRow = field(body, 'Audio bitrate', abr);
  const ch = select([[2, 'Stereo'], [1, 'Mono']], lastExport.channels || 2);
  field(body, 'Channels', ch);
  const wavDepth = select([[24, '24-bit'], [16, '16-bit']], lastExport.wavDepth || 24);
  const wavRow = field(body, 'Bit depth', wavDepth);

  const summary = el('div', 'left');
  const go = btn('Export…', 'btn primary');
  const cancel = btn('Cancel');
  cancel.onclick = () => closeModal();
  foot.append(summary, cancel, go);

  const suggestedBitrate = () => {
    const sz = resMap[res.value];
    const px = sz.width * sz.height;
    const fps = Number(fpsSel.value);
    const base = px >= 3840 * 2160 * 0.9 ? 45000 : px >= 2560 * 1440 * 0.9 ? 24000 : px >= 1920 * 1080 * 0.9 ? 12000 : 7500;
    return Math.round(base * (fps > 31 ? 1.5 : 1) / 500) * 500;
  };
  br.value = lastExport.bitrateKbps || suggestedBitrate();
  let userBitrate = !!lastExport.bitrateKbps;
  br.oninput = () => { userBitrate = true; update(); };

  const update = () => {
    const f = formats[fmt.value];
    const isVideo = !!f.video;
    for (const r of [resRow, fpsRow, encRow, modeRow, crfRow, brRow, presetRow, tenRow]) r.classList.toggle('hidden', !isVideo);
    abrRow.classList.toggle('hidden', ['wav', 'pcm'].includes(f.audio));
    wavRow.classList.toggle('hidden', f.audio !== 'wav');
    if (isVideo) {
      const isProres = f.video === 'prores';
      const want = f.video === 'h265' ? ['libx265', 'hevc_nvenc', 'hevc_qsv', 'hevc_amf'] : ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf'];
      const names = { libx264: 'Software (x264, best quality)', libx265: 'Software (x265, best quality)', h264_nvenc: 'NVIDIA GPU (NVENC)', hevc_nvenc: 'NVIDIA GPU (NVENC)', h264_qsv: 'Intel GPU (Quick Sync)', hevc_qsv: 'Intel GPU (Quick Sync)', h264_amf: 'AMD GPU (AMF)', hevc_amf: 'AMD GPU (AMF)' };
      const avail = want.filter((e) => encoderCache.includes(e));
      const prev = encSel.value || lastExport.encoder;
      encSel.innerHTML = '';
      for (const e of (avail.length ? avail : [want[0]])) encSel.appendChild(new Option(names[e], e));
      if ([...encSel.options].some((o) => o.value === prev)) encSel.value = prev;
      for (const r of [encRow, modeRow, crfRow, brRow, presetRow]) if (isProres) r.classList.add('hidden');
      tenRow.classList.toggle('hidden', f.video !== 'h265');
      const sw = encSel.value.startsWith('lib');
      presetRow.classList.toggle('hidden', isProres || !sw);
      crfRow.classList.toggle('hidden', isProres || mode.value !== 'crf');
      brRow.classList.toggle('hidden', isProres || mode.value !== 'bitrate');
      if (!userBitrate) br.value = suggestedBitrate();
      const q = Number(crf.value);
      crfVal.textContent = `${q} · ${q <= 14 ? 'near lossless' : q <= 20 ? 'high' : q <= 26 ? 'good' : q <= 32 ? 'small file' : 'low'}`;
      const sz = resMap[res.value];
      const dur = store.duration();
      let text = `${sz.width} × ${sz.height} · ${fpsSel.value} fps · ${formatTime(dur, st.fps, false)}`;
      if (mode.value === 'bitrate' && !isProres) text += ` · about ${((Number(br.value) + Number(abr.value)) * dur / 8 / 1024).toFixed(0)} MB`;
      summary.textContent = text;
    } else summary.textContent = `Audio only · ${formatTime(store.duration(), st.fps, false)}`;
  };
  for (const c of [fmt, res, fpsSel, encSel, mode, crf, preset]) c.addEventListener('input', update);
  update();

  go.onclick = async () => {
    const f = formats[fmt.value];
    const out = await window.mc.chooseExportPath(p.name || 'Untitled', f.ext);
    if (!out) return;
    const sz = resMap[res.value];
    const opts = {
      formatId: fmt.value, outPath: out, width: sz.width, height: sz.height, fps: Number(fpsSel.value),
      encoder: encSel.value, rateControl: mode.value, crf: Number(crf.value), bitrateKbps: Number(br.value),
      preset: preset.value, bitDepth: tenBit.checked ? 10 : 8, sampleRate: Number(sr.value),
      audioBitrateKbps: Number(abr.value), channels: Number(ch.value), wavDepth: Number(wavDepth.value),
    };
    Object.assign(lastExport, opts, { res: res.value, tenBit: tenBit.checked, bitrateKbps: userBitrate ? opts.bitrateKbps : undefined });
    runExport(store, opts, toast);
  };
}

async function runExport(store, opts, toast) {
  const { body, foot } = openModal('Exporting…');
  closable = false;
  body.appendChild(el('div', '', opts.outPath));
  const bar = el('div', 'progress'); const fill = el('div'); bar.appendChild(fill);
  const status = el('div', 'muted small', 'Starting FFmpeg…');
  body.append(bar, status);
  const cancel = btn('Cancel export', 'btn danger');
  foot.appendChild(cancel);
  cancel.onclick = () => { status.textContent = 'Cancelling…'; window.mc.cancelExport(); };
  const off = window.mc.onExportProgress(({ progress, eta }) => {
    fill.style.width = (progress * 100).toFixed(1) + '%';
    status.textContent = `${(progress * 100).toFixed(1)}%` + (eta != null ? ` · about ${Math.ceil(eta)}s left` : '');
  });
  try {
    const project = JSON.parse(JSON.stringify(store.project));
    const r = await window.mc.startExport(project, opts);
    off();
    closable = true;
    if (r.cancelled) { closeModal(); toast('Export cancelled.'); return; }
    fill.style.width = '100%';
    status.textContent = `Done in ${r.seconds.toFixed(1)}s.`;
    foot.innerHTML = '';
    const show = btn('Show in folder', 'btn primary');
    show.onclick = () => window.mc.showItem(r.path);
    const close = btn('Close');
    close.onclick = () => closeModal();
    foot.append(close, show);
  } catch (e) {
    off();
    closable = true;
    status.textContent = '';
    const pre = el('pre', 'small');
    pre.style.cssText = 'white-space:pre-wrap;max-height:240px;overflow:auto;background:#0b0c0f;padding:8px;border-radius:6px;user-select:text';
    pre.textContent = String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    body.appendChild(pre);
    foot.innerHTML = '';
    const close = btn('Close');
    close.onclick = () => closeModal();
    foot.appendChild(close);
  }
}

// ---------------------------------------------------------------- Voice-over recorder
export async function recordDialog(store, preview, ui) {
  const { body, foot } = openModal('Record voice-over', { onClose: () => cleanup() });
  let stream = null, recorder = null, chunks = [], meterCtx = null, raf = 0, timer = 0, startAt = 0, startPlayhead = 0;
  const state = { recording: false, countdown: false };

  // Saved recorder preferences: default microphone and the checkboxes below.
  const settings = await window.mc.getSettings().catch(() => ({}));
  const prefs = Object.assign({ micId: '', micLabel: '' }, settings.recorder || {});
  const savePrefs = (patch) => { Object.assign(prefs, patch); window.mc.setSettings({ recorder: prefs }).catch(() => {}); };

  const deviceSel = select([['', 'System default microphone']]);
  const micWrap = el('div', 'row gap4');
  const makeDefault = btn('Set as default', 'btn small');
  makeDefault.title = 'Use this microphone every time you record';
  deviceSel.style.flex = '1';
  micWrap.append(deviceSel, makeDefault);
  field(body, 'Microphone', micWrap);
  const opt = (key, label, on) => {
    const l = el('label', 'check'); const c = el('input'); c.type = 'checkbox';
    c.checked = prefs[key] ?? on;
    c.addEventListener('change', () => savePrefs({ [key]: c.checked }));
    l.append(c, document.createTextNode(label)); body.appendChild(l); return c;
  };
  const playAlong = opt('playAlong', 'Play the timeline while recording (narrate over your video)', true);
  const autoStop = opt('autoStop', 'Stop recording when the timeline reaches the end', true);
  const muteMonitor = opt('muteMonitor', 'Mute timeline sound while recording (avoids echo without headphones)', true);
  const countdown = opt('countdown', '3-second countdown', true);
  const noise = opt('noise', 'Noise suppression', true);
  const echo = opt('echo', 'Echo cancellation', false);
  const agc = opt('agc', 'Auto gain', false);

  const panel = el('div', 'rec-panel');
  const level = el('div', 'level'); const levelFill = el('div'); level.appendChild(levelFill);
  const big = el('button', 'rec-big'); big.title = 'Start recording';
  const time = el('div', 'rec-time', '00:00.0');
  const hint = el('div', 'muted small', `Recording starts at the playhead (${formatTime(store.playhead, store.project.settings.fps)}) and lands on the Voice-over track.`);
  panel.append(level, big, time, hint);
  body.appendChild(panel);
  const close = btn('Close');
  close.onclick = () => closeModal();
  foot.appendChild(close);

  const constraints = (id) => ({
    audio: {
      deviceId: id ? { exact: id } : undefined,
      noiseSuppression: noise.checked, echoCancellation: echo.checked, autoGainControl: agc.checked,
      channelCount: 1, sampleRate: 48000,
    },
  });
  async function openStream(wantId = deviceSel.value) {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints(wantId));
    } catch (e) {
      if (wantId) {
        // The chosen mic is unplugged or renamed: fall back to the system default.
        try {
          stream = await navigator.mediaDevices.getUserMedia(constraints(''));
          wantId = '';
          hint.textContent = 'Your default microphone was not found, so the system default is being used.';
        } catch (_) { /* reported below */ }
      }
      if (!stream) {
        hint.textContent = 'Could not open the microphone: ' + e.message + '. Check Windows Settings → Privacy → Microphone.';
        return;
      }
    }
    if (meterCtx) meterCtx.close();
    meterCtx = new AudioContext();
    const an = meterCtx.createAnalyser(); an.fftSize = 1024;
    meterCtx.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(1024);
    cancelAnimationFrame(raf);
    const loop = () => {
      an.getFloatTimeDomainData(buf);
      let peak = 0; for (const v of buf) peak = Math.max(peak, Math.abs(v));
      const pct = Math.max(0, Math.min(1, (20 * Math.log10(peak || 1e-6) + 50) / 50));
      levelFill.style.width = pct * 100 + '%';
      if (state.recording) time.textContent = fmtRec((performance.now() - startAt) / 1000);
      raf = requestAnimationFrame(loop);
    };
    loop();
    await fillDevices(wantId);
  }
  // Device names are only available after microphone permission is granted.
  async function fillDevices(selectId) {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
    deviceSel.innerHTML = '';
    deviceSel.appendChild(new Option(`System default microphone${prefs.micId ? '' : '  ★ default'}`, ''));
    for (const d of devices) {
      const label = d.label || 'Microphone';
      deviceSel.appendChild(new Option(label + (d.deviceId === prefs.micId ? '  ★ default' : ''), d.deviceId));
    }
    if ([...deviceSel.options].some((o) => o.value === selectId)) deviceSel.value = selectId;
    makeDefault.disabled = deviceSel.value === prefs.micId;
    return devices;
  }
  /** The saved default mic's current id. Matches by name too, in case Windows gave it a new id. */
  async function savedMicId() {
    if (!prefs.micId) return '';
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    if (devices.some((d) => d.deviceId === prefs.micId)) return prefs.micId;
    const byName = prefs.micLabel && devices.find((d) => d.label === prefs.micLabel);
    if (byName) { savePrefs({ micId: byName.deviceId }); return byName.deviceId; }
    return prefs.micId; // ids may be hidden until permission is granted; try it anyway
  }
  makeDefault.onclick = async () => {
    const o = deviceSel.selectedOptions[0];
    savePrefs({ micId: deviceSel.value, micLabel: deviceSel.value ? o.textContent.replace(/\s+★ default$/, '') : '' });
    await fillDevices(deviceSel.value);
    ui.toast(deviceSel.value ? 'Default microphone saved.' : 'Using the system default microphone.');
  };
  deviceSel.addEventListener('change', () => { makeDefault.disabled = deviceSel.value === prefs.micId; });
  const fmtRec = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`;

  for (const c of [deviceSel, noise, echo, agc]) c.addEventListener('change', () => { if (!state.recording) openStream(); });
  await openStream(await savedMicId());

  big.onclick = async () => {
    if (state.countdown) return;
    if (state.recording) { stop(); return; }
    if (!stream) { await openStream(); if (!stream) return; }
    startPlayhead = store.playhead;
    if (countdown.checked) {
      state.countdown = true;
      for (let n = 3; n > 0; n--) { time.innerHTML = ''; time.appendChild(el('span', 'rec-count', String(n))); await new Promise((r) => setTimeout(r, 1000)); }
      state.countdown = false;
      if (!modalOpen()) return;
    }
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 256000 });
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = () => save(mime);
    recorder.start(250);
    startAt = performance.now();
    state.recording = true;
    closable = false;
    big.classList.add('recording'); big.title = 'Stop recording';
    hint.textContent = 'Recording… click the square (or press Space) to stop.';
    if (playAlong.checked && startPlayhead < preview.contentEnd() - 0.05) {
      store.setPlayhead(startPlayhead);
      preview.monitorMuted = muteMonitor.checked;
      preview.onEnd = () => { if (state.recording && autoStop.checked) stop(); };
      preview.play();
    }
    clearInterval(timer);
  };
  function stop() {
    if (!recorder || recorder.state === 'inactive') return;
    recorder.stop();
    state.recording = false;
    big.classList.remove('recording'); big.title = 'Start recording';
    preview.onEnd = null;
    preview.pause();
    preview.monitorMuted = false;
    hint.textContent = 'Saving…';
  }
  ui.recorderStop = () => { if (state.recording) { stop(); return true; } return false; };

  async function save(mime) {
    try {
      const blob = new Blob(chunks, { type: mime });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const path = await window.mc.saveRecording(bytes, mime);
      const [mediaId] = await ui.importPaths([path], { voice: true });
      const m = store.media(mediaId);
      if (m) {
        store.commit('Record voice-over', (p) => {
          let track = p.tracks.find((t) => t.voice && !t.locked);
          if (!track) {
            track = { id: uid('trk'), kind: 'audio', name: 'Voice-over', hidden: false, locked: false, muted: false, solo: false, volume: 1, voice: true };
            p.tracks.push(track);
          }
          const c = newClip(m, track.id, startPlayhead);
          clearRange(p, track.id, c.start, c.start + c.duration);
          p.clips.push(c);
        });
      }
      hint.textContent = `Saved ${m ? m.name : ''}. Record another take, or close this window.`;
      ui.toast('Voice-over added to the timeline.');
    } catch (e) {
      hint.textContent = 'Could not save the recording: ' + e.message;
    } finally {
      closable = true;
      time.textContent = '00:00.0';
    }
  }
  function cleanup() {
    if (state.recording) stop();
    preview.onEnd = null;
    cancelAnimationFrame(raf);
    if (stream) stream.getTracks().forEach((t) => t.stop());
    if (meterCtx) meterCtx.close();
    ui.recorderStop = null;
  }
}

// ---------------------------------------------------------------- Shortcuts
export function shortcutsDialog() {
  const { body, foot } = openModal('Keyboard shortcuts');
  const list = [
    ['Play / pause', 'Space'], ['Previous / next frame', '← / →'], ['Jump 1 second', 'Shift + ← / →'],
    ['Go to start / end', 'Home / End'], ['Split at playhead', 'S or Ctrl+B'], ['Delete', 'Delete'],
    ['Ripple delete (close gap)', 'Shift+Delete'], ['Duplicate', 'Ctrl+D'], ['Detach audio', 'Ctrl+Shift+D'],
    ['Select all clips', 'Ctrl+A'], ['Undo / redo', 'Ctrl+Z / Ctrl+Y'], ['Import media', 'Ctrl+I'],
    ['Record voice-over', 'Ctrl+R'], ['Export', 'Ctrl+E'], ['Save / Save as', 'Ctrl+S / Ctrl+Shift+S'],
    ['Toggle snapping', 'N'], ['Zoom timeline in / out', 'Ctrl + mouse wheel, Ctrl+= / Ctrl+-'], ['Fit whole timeline', 'Shift+Z'],
    ['Taller / shorter tracks', 'Alt + mouse wheel'], ['Scroll timeline sideways', 'Shift + mouse wheel, or wheel over the ruler'],
    ['Drop exactly at the mouse (no snapping)', 'hold Alt while dropping'],
    ['Snap playhead while scrubbing', 'hold Shift'], ['Free move in preview (no centre snap)', 'hold Alt'],
  ];
  const g = el('div', 'shortcuts');
  for (const [a, k] of list) { g.appendChild(el('span', '', a)); const kb = el('kbd', '', k); g.appendChild(kb); }
  body.appendChild(g);
  const close = btn('Close'); close.onclick = () => closeModal();
  foot.appendChild(close);
}
