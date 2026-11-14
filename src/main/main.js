'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, Menu, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { Readable } = require('stream');
const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const { buildExport, FORMATS } = require('./exporter');

// ---------- FFmpeg location ----------
function resolveBinary(modName, field, fallback) {
  try {
    let p = require(modName);
    if (field) p = p[field];
    if (typeof p === 'object' && p.path) p = p.path;
    if (p) {
      p = p.replace('app.asar', 'app.asar.unpacked');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* not installed */ }
  return fallback; // falls back to whatever is on PATH
}
const FFMPEG = process.env.MEANDERCUT_FFMPEG || resolveBinary('ffmpeg-static', null, 'ffmpeg');
const FFPROBE = process.env.MEANDERCUT_FFPROBE || resolveBinary('ffprobe-static', 'path', 'ffprobe');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const allowedMedia = new Set(); // only files the user imported/recorded/opened can be served
let win = null;
let allowClose = false;

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
}]);

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg',
  '.flac': 'audio/flac', '.opus': 'audio/ogg',
};

/** Serves a file with HTTP Range support so <video> can seek. */
async function serveFile(filePath, request) {
  const stat = await fsp.stat(filePath);
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (!m || !m[1] && m[2]) { start = Math.max(0, stat.size - parseInt(m[2], 10)); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
      status: 206,
      headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${stat.size}` },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    status: 200, headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(stat.size) },
  });
}

function registerProtocol() {
  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/media') {
        const p = url.searchParams.get('p');
        if (!p || !allowedMedia.has(path.resolve(p))) return new Response('Forbidden', { status: 403 });
        return await serveFile(p, request);
      }
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const full = path.normalize(path.join(RENDERER_DIR, rel));
      if (!full.startsWith(RENDERER_DIR)) return new Response('Forbidden', { status: 403 });
      return await serveFile(full, request);
    } catch (e) {
      return new Response(String(e.message), { status: 404 });
    }
  });
}

// ---------- helpers ----------
function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, Object.assign({ maxBuffer: 64 * 1024 * 1024, windowsHide: true }, opts), (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr); return reject(err); }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}
const cacheDir = () => path.join(app.getPath('userData'), 'cache');
const recordingsDir = () => path.join(app.getPath('documents'), 'MeanderCut', 'Recordings');
const hashOf = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);

async function probe(filePath) {
  filePath = path.resolve(filePath);
  if (!fs.existsSync(filePath)) return { missing: true, path: filePath };
  allowedMedia.add(filePath);
  const ext = path.extname(filePath).toLowerCase();
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
  const info = JSON.parse(stdout);
  const v = info.streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = info.streams.find((s) => s.codec_type === 'audio');
  const isImage = IMAGE_EXT.has(ext) || (v && !a && (!info.format.duration || Number(info.format.duration) < 0.05 || ['png', 'mjpeg', 'bmp', 'webp', 'tiff', 'gif'].includes(v.codec_name) && IMAGE_EXT.has(ext)));
  let fps = 30;
  if (v && v.avg_frame_rate && v.avg_frame_rate !== '0/0') {
    const [n, d] = v.avg_frame_rate.split('/').map(Number);
    if (d) fps = n / d;
  }
  let width = v ? v.width : 0, height = v ? v.height : 0;
  const rot = v && v.side_data_list && v.side_data_list.find((s) => s.rotation !== undefined);
  const tagRot = v && v.tags && v.tags.rotate;
  const rotation = Math.abs(Number(rot ? rot.rotation : tagRot || 0)) % 180;
  if (rotation === 90) [width, height] = [height, width]; // phone footage shot in portrait
  return {
    path: filePath,
    name: path.basename(filePath),
    type: isImage ? 'image' : v ? 'video' : 'audio',
    duration: isImage ? 0 : Number(info.format.duration || (v && v.duration) || (a && a.duration) || 0),
    width, height, fps,
    hasVideo: !!v, hasAudio: !!a && !isImage,
    videoCodec: v ? v.codec_name : null,
    audioCodec: a ? a.codec_name : null,
    sampleRate: a ? Number(a.sample_rate) : null,
    channels: a ? a.channels : null,
    size: Number(info.format.size || 0),
  };
}

async function waveform(filePath) {
  filePath = path.resolve(filePath);
  await fsp.mkdir(cacheDir(), { recursive: true });
  const out = path.join(cacheDir(), `wave-${hashOf(filePath + fs.statSync(filePath).mtimeMs)}.png`);
  if (!fs.existsSync(out)) {
    await run(FFMPEG, ['-hide_banner', '-y', '-i', filePath, '-filter_complex',
      'aformat=channel_layouts=mono,compand=gain=4,showwavespic=s=2400x120:colors=#7fe3c8', '-frames:v', '1', out]);
  }
  allowedMedia.add(out);
  return out;
}

async function thumbnail(filePath, type, duration) {
  filePath = path.resolve(filePath);
  await fsp.mkdir(cacheDir(), { recursive: true });
  const out = path.join(cacheDir(), `thumb-${hashOf(filePath + fs.statSync(filePath).mtimeMs)}.jpg`);
  if (!fs.existsSync(out)) {
    const ss = type === 'video' ? String(Math.min(1, (duration || 0) / 3)) : '0';
    await run(FFMPEG, ['-hide_banner', '-y', '-ss', ss, '-i', filePath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out]);
  }
  allowedMedia.add(out);
  return out;
}

async function detectEncoders() {
  try {
    const { stdout } = await run(FFMPEG, ['-hide_banner', '-encoders']);
    const want = ['libx264', 'libx265', 'h264_nvenc', 'hevc_nvenc', 'h264_qsv', 'hevc_qsv', 'h264_amf', 'hevc_amf'];
    const listed = want.filter((e) => new RegExp('\\s' + e + '\\s').test(stdout));
    // Hardware encoders are listed even when no GPU is present, so try a tiny encode.
    const works = [];
    for (const e of listed) {
      if (e.startsWith('lib')) { works.push(e); continue; }
      try {
        await run(FFMPEG, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=s=256x256:d=0.1', '-c:v', e, '-f', 'null', '-'], { timeout: 8000 });
        works.push(e);
      } catch (_) { /* no GPU support */ }
    }
    return works;
  } catch (e) {
    return [];
  }
}

// ---------- export ----------
let currentExport = null;
async function startExport(event, project, opts) {
  if (currentExport) throw new Error('An export is already running.');
  const job = buildExport(project, opts);
  await fsp.mkdir(cacheDir(), { recursive: true });
  const script = path.join(cacheDir(), `export-${Date.now()}.filter.txt`);
  await fsp.writeFile(script, job.filter);
  const args = job.args.map((a) => (a === '__FILTER__' ? script : a));
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG, args, { windowsHide: true });
    currentExport = proc;
    let log = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        const [k, v] = line.split('=');
        if (k === 'out_time_us' || k === 'out_time_ms') {
          const secs = Number(v) / 1e6;
          if (!isFinite(secs)) continue;
          const p = Math.min(1, secs / job.duration);
          const elapsed = (Date.now() - started) / 1000;
          event.sender.send('export:progress', { progress: p, eta: p > 0.01 ? elapsed / p - elapsed : null, elapsed });
        }
      }
    });
    proc.stderr.on('data', (d) => { log = (log + d.toString()).slice(-20000); });
    proc.on('error', (e) => { currentExport = null; reject(new Error('Could not start FFmpeg: ' + e.message)); });
    proc.on('close', (code, signal) => {
      currentExport = null;
      fsp.unlink(script).catch(() => {});
      if (code === 0) resolve({ ok: true, path: opts.outPath, seconds: (Date.now() - started) / 1000 });
      else if (signal || code === 255) { fsp.unlink(opts.outPath).catch(() => {}); resolve({ ok: false, cancelled: true }); }
      else reject(new Error('FFmpeg failed:\n' + log.split('\n').slice(-15).join('\n')));
    });
  });
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1600, height: 960, minWidth: 1100, minHeight: 700,
    backgroundColor: '#121418',
    title: 'MeanderCut',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL('app://local/index.html');
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    win.webContents.send('app:request-close');
  });
  buildMenu();
}

function send(cmd) { if (win) win.webContents.send('menu', cmd); }
function buildMenu() {
  const t = [
    { label: 'File', submenu: [
      { label: 'New Project', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
      { label: 'Open Project...', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
      { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
      { label: 'Save As...', accelerator: 'CmdOrCtrl+Shift+S', click: () => send('saveAs') },
      { type: 'separator' },
      { label: 'Import Media...', accelerator: 'CmdOrCtrl+I', click: () => send('import') },
      { label: 'Record Voice-over...', accelerator: 'CmdOrCtrl+R', click: () => send('record') },
      { label: 'Export...', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
      { type: 'separator' },
      { label: 'Exit', click: () => win && win.close() },
    ] },
    { label: 'Edit', submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Y', click: () => send('redo') },
      { type: 'separator' },
      { label: 'Split at Playhead', accelerator: 'CmdOrCtrl+B', click: () => send('split') },
      { label: 'Duplicate Clip', accelerator: 'CmdOrCtrl+D', click: () => send('duplicate') },
      { label: 'Detach Audio', accelerator: 'CmdOrCtrl+Shift+D', click: () => send('detach') },
      { label: 'Extract Audio to File...', click: () => send('extractAudio') },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
    ] },
    { label: 'View', submenu: [
      { label: 'Zoom Timeline In', accelerator: 'CmdOrCtrl+=', click: () => send('zoomIn') },
      { label: 'Zoom Timeline Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoomOut') },
      { label: 'Fit Timeline', accelerator: 'Shift+Z', click: () => send('zoomFit') },
      { type: 'separator' },
      { role: 'togglefullscreen' },
      { role: 'toggleDevTools' },
    ] },
    { label: 'Help', submenu: [
      { label: 'Keyboard Shortcuts', accelerator: 'F1', click: () => send('shortcuts') },
      { label: 'About MeanderCut', click: () => dialog.showMessageBox(win, {
        type: 'info', title: 'MeanderCut', message: `MeanderCut ${app.getVersion()}`,
        detail: `A focused video editor by Meanderpaul_gaming.\nFFmpeg: ${FFMPEG}`,
      }) },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(t));
}

// ---------- IPC ----------
function registerIpc() {
  const mediaFilters = [
    { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mts', 'm2ts', 'wmv', 'flv', 'mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff'] },
    { name: 'All files', extensions: ['*'] },
  ];
  ipcMain.handle('dialog:importMedia', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import media', properties: ['openFile', 'multiSelections'], filters: mediaFilters });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('media:probe', (_e, p) => probe(p));
  ipcMain.handle('media:waveform', (_e, p) => waveform(p));
  ipcMain.handle('media:thumbnail', (_e, p, type, dur) => thumbnail(p, type, dur));
  ipcMain.handle('media:relink', async (_e, name) => {
    const r = await dialog.showOpenDialog(win, { title: `Find "${name}"`, properties: ['openFile'], filters: mediaFilters });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('project:save', async (_e, data, filePath) => {
    if (!filePath) {
      const r = await dialog.showSaveDialog(win, { title: 'Save project', defaultPath: 'Untitled.mcut', filters: [{ name: 'MeanderCut project', extensions: ['mcut'] }] });
      if (r.canceled) return null;
      filePath = r.filePath;
    }
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2));
    return filePath;
  });
  ipcMain.handle('project:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open project', properties: ['openFile'], filters: [{ name: 'MeanderCut project', extensions: ['mcut'] }] });
    if (r.canceled) return null;
    return { path: r.filePaths[0], data: JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8')) };
  });
  ipcMain.handle('project:autosave', async (_e, data) => {
    await fsp.mkdir(app.getPath('userData'), { recursive: true });
    await fsp.writeFile(path.join(app.getPath('userData'), 'autosave.mcut'), JSON.stringify(data));
    return true;
  });
  ipcMain.handle('project:readAutosave', async () => {
    try { return JSON.parse(await fsp.readFile(path.join(app.getPath('userData'), 'autosave.mcut'), 'utf8')); } catch (_) { return null; }
  });
  ipcMain.handle('project:clearAutosave', async () => { await fsp.unlink(path.join(app.getPath('userData'), 'autosave.mcut')).catch(() => {}); return true; });

  ipcMain.handle('export:formats', () => FORMATS);
  ipcMain.handle('export:encoders', () => detectEncoders());
  ipcMain.handle('export:chooseOutput', async (_e, name, ext) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Export', defaultPath: path.join(app.getPath('videos'), `${name}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    return r.canceled ? null : r.filePath;
  });
  ipcMain.handle('export:start', (e, project, opts) => startExport(e, project, opts));
  ipcMain.handle('export:cancel', () => {
    if (currentExport) { try { currentExport.stdin.write('q'); } catch (_) {} setTimeout(() => currentExport && currentExport.kill(), 1500); }
    return true;
  });

  ipcMain.handle('audio:extract', async (_e, mediaPath, inSec, durSec) => {
    const base = path.basename(mediaPath, path.extname(mediaPath));
    const r = await dialog.showSaveDialog(win, {
      title: 'Save audio as', defaultPath: path.join(path.dirname(mediaPath), `${base}-audio.wav`),
      filters: [{ name: 'WAV', extensions: ['wav'] }, { name: 'MP3', extensions: ['mp3'] }, { name: 'AAC (M4A)', extensions: ['m4a'] }],
    });
    if (r.canceled) return null;
    const ext = path.extname(r.filePath).toLowerCase();
    const codec = ext === '.mp3' ? ['-c:a', 'libmp3lame', '-b:a', '320k'] : ext === '.m4a' ? ['-c:a', 'aac', '-b:a', '256k'] : ['-c:a', 'pcm_s24le'];
    const range = typeof inSec === 'number' ? ['-ss', String(inSec), '-t', String(durSec)] : [];
    await run(FFMPEG, ['-hide_banner', '-y', ...range, '-i', mediaPath, '-vn', ...codec, r.filePath]);
    allowedMedia.add(path.resolve(r.filePath));
    return r.filePath;
  });

  ipcMain.handle('record:save', async (_e, bytes, mimeType) => {
    await fsp.mkdir(recordingsDir(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const raw = path.join(recordingsDir(), `voiceover-${stamp}.${mimeType.includes('ogg') ? 'ogg' : 'webm'}`);
    const wav = raw.replace(/\.(webm|ogg)$/, '.wav');
    await fsp.writeFile(raw, Buffer.from(bytes));
    // MediaRecorder files have no duration header; WAV seeks and edits cleanly.
    await run(FFMPEG, ['-hide_banner', '-y', '-i', raw, '-ar', '48000', '-c:a', 'pcm_s24le', wav]);
    await fsp.unlink(raw).catch(() => {});
    allowedMedia.add(path.resolve(wav));
    return wav;
  });

  // Small preferences file (default microphone, recorder options) in the user's app-data folder.
  const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
  const readSettings = async () => { try { return JSON.parse(await fsp.readFile(settingsFile(), 'utf8')); } catch (_) { return {}; } };
  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', async (_e, patch) => {
    const next = Object.assign(await readSettings(), patch);
    await fsp.mkdir(app.getPath('userData'), { recursive: true });
    await fsp.writeFile(settingsFile(), JSON.stringify(next, null, 2));
    return next;
  });

  ipcMain.handle('shell:showItem', (_e, p) => { shell.showItemInFolder(p); return true; });
  ipcMain.handle('app:closeNow', () => { allowClose = true; if (win) win.close(); return true; });
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), ffmpeg: FFMPEG, ffprobe: FFPROBE, recordings: recordingsDir() }));
}

app.whenReady().then(() => {
  // Allow microphone access for the voice-over recorder; deny everything else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    cb(permission === 'media' && (!details.mediaTypes || details.mediaTypes.every((t) => t === 'audio')));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  registerProtocol();
  registerIpc();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  if (currentExport) currentExport.kill();
  app.quit();
});
