'use strict';
// Sound library: finds sound packs on disk.
// A pack is a folder of audio files, optionally with a pack.json:
//   { "name": "...", "description": "...", "credit": "...", "license": "..." }
// Packs come from two places: the ones bundled with MeanderCut (read-only) and the
// user's own folder (Documents\MeanderCut\Sounds), where any folder they add becomes a pack.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const AUDIO_EXT = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus']);
const PACK_EXTRAS = new Set(['pack.json', 'readme.md', 'readme.txt', 'cue_sheet.txt', 'license.txt']);
const MAX_DEPTH = 4;

/** "02_night_ambience_crickets.mp3" -> "Night ambience crickets" */
function prettyName(file) {
  let s = path.basename(file, path.extname(file));
  s = s.replace(/^\d+[\s._-]+/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : path.basename(file);
}

async function readPackInfo(dir) {
  try { return JSON.parse(await fsp.readFile(path.join(dir, 'pack.json'), 'utf8')) || {}; } catch (_) { return {}; }
}

async function audioFilesIn(dir, depth = 0) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory() && depth < MAX_DEPTH) out.push(...await audioFilesIn(full, depth + 1));
    else if (e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
  return out;
}

const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Scans one library folder. Each sub-folder is a pack; loose files form an "Unsorted" pack. */
async function scanRoot(root, source) {
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return []; }
  const packs = [];
  const loose = entries.filter((e) => e.isFile() && AUDIO_EXT.has(path.extname(e.name).toLowerCase())).map((e) => path.join(root, e.name));
  for (const e of entries.filter((x) => x.isDirectory()).sort((a, b) => byName(a.name, b.name))) {
    const dir = path.join(root, e.name);
    const info = await readPackInfo(dir);
    const files = (await audioFilesIn(dir)).sort((a, b) => byName(path.relative(dir, a), path.relative(dir, b)));
    if (!files.length && source !== 'user') continue;
    packs.push(makePack(dir, source, info, files, info.name || prettyName(e.name)));
  }
  if (loose.length) packs.push(makePack(root, source, {}, loose.sort(byName), 'Unsorted'));
  return packs;
}

function makePack(dir, source, info, files, name) {
  return {
    id: `${source}:${dir}`,
    name: String(name),
    description: info.description ? String(info.description) : '',
    credit: info.credit ? String(info.credit) : '',
    license: info.license ? String(info.license) : '',
    source, // 'builtin' | 'user'
    dir,
    sounds: files.map((p) => ({ path: p, name: prettyName(p), file: path.basename(p), duration: null })),
  };
}

/**
 * Lists every pack in the given roots ([{ dir, source }]). If durationOf(path) is given,
 * fills in each sound's duration (a few at a time).
 */
async function listSounds(roots, durationOf) {
  const packs = [];
  for (const r of roots) packs.push(...await scanRoot(r.dir, r.source));
  if (durationOf) {
    const all = packs.flatMap((p) => p.sounds);
    let i = 0;
    const worker = async () => {
      while (i < all.length) {
        const s = all[i++];
        try { s.duration = await durationOf(s.path); } catch (_) { s.duration = null; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, all.length) }, worker));
  }
  return packs;
}

/** A path in dir that doesn't exist yet: "name.mp3", "name (2).mp3", ... */
function uniquePath(dir, base) {
  const ext = path.extname(base);
  const stem = path.basename(base, ext);
  let p = path.join(dir, base);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${stem} (${n})${ext}`);
  return p;
}

/** Copies audio files into a pack folder. Returns the new paths. */
async function copyFilesInto(files, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  const out = [];
  for (const f of files) {
    if (!AUDIO_EXT.has(path.extname(f).toLowerCase())) continue;
    const dest = uniquePath(destDir, path.basename(f));
    await fsp.copyFile(f, dest);
    out.push(dest);
  }
  return out;
}

/** Copies a whole folder into the user's library as a new pack (audio files and pack notes only). */
async function copyFolderInto(srcDir, userRoot) {
  const src = path.resolve(srcDir);
  const root = path.resolve(userRoot);
  if (src === root || src.startsWith(root + path.sep)) throw new Error('That folder is already in your sound library.');
  const files = await audioFilesIn(src);
  if (!files.length) throw new Error('No audio files found in that folder.');
  const dest = uniquePath(root, path.basename(src));
  await fsp.cp(src, dest, {
    recursive: true,
    filter: (p) => {
      if (p === src) return true;
      const st = fs.statSync(p);
      return st.isDirectory() || AUDIO_EXT.has(path.extname(p).toLowerCase()) || PACK_EXTRAS.has(path.basename(p).toLowerCase());
    },
  });
  return dest;
}

module.exports = { AUDIO_EXT, prettyName, listSounds, copyFilesInto, copyFolderInto, uniquePath };
