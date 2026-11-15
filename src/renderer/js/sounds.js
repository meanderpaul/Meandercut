// Sound library panel (Media › Sounds): browse bundled and user sound packs, preview them,
// and add them to the project. Sounds are only imported into the media bin when you use them.
import { formatTime } from './state.js';

export const SOUND_MIME = 'application/x-meandercut-sound';

export class SoundLibrary {
  /**
   * @param {object} els { root, packs, search, addFiles, addFolder, openFolder, refresh }
   * @param {object} ui  { toast, importPaths, placeAtPlayhead(mediaId) }
   */
  constructor(els, ui) {
    this.els = els;
    this.ui = ui;
    this.packs = [];
    this.loaded = false;
    this.loading = null;
    this.query = '';
    this.collapsed = new Set();
    this.audio = new Audio();
    this.playingPath = null;
    this.audio.addEventListener('ended', () => this.stopPreview());

    els.search.addEventListener('input', () => { this.query = els.search.value.trim().toLowerCase(); this.render(); });
    els.refresh.addEventListener('click', () => this.load(true));
    els.openFolder.addEventListener('click', () => window.mc.openSoundsFolder());
    els.addFiles.addEventListener('click', () => this.addFiles());
    els.addFolder.addEventListener('click', () => this.addFolder());
  }

  show(visible) {
    this.els.root.classList.toggle('hidden', !visible);
    if (visible && !this.loaded) this.load();
    if (!visible) this.stopPreview();
  }

  async load(force = false) {
    if (this.loading && !force) return this.loading;
    this.loading = (async () => {
      try {
        const r = await window.mc.listSounds();
        this.packs = r.packs;
        this.userDir = r.userDir;
        this.loaded = true;
      } catch (e) {
        this.ui.toast('Could not load the sound library: ' + (e.message || e), 'error');
      }
      this.render();
      this.loading = null;
    })();
    return this.loading;
  }

  async addFiles() {
    try {
      const added = await window.mc.addSoundFiles();
      if (!added.length) return;
      this.ui.toast(`Added ${added.length} sound(s) to My Sounds.`);
      await this.load(true);
    } catch (e) { this.ui.toast('Could not add sounds: ' + (e.message || e), 'error'); }
  }

  async addFolder() {
    try {
      const dest = await window.mc.addSoundFolder();
      if (!dest) return;
      this.ui.toast('Sound pack added.');
      await this.load(true);
    } catch (e) { this.ui.toast(String(e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'); }
  }

  togglePreview(sound, btn) {
    if (this.playingPath === sound.path) { this.stopPreview(); return; }
    this.stopPreview();
    this.audio.src = window.mc.mediaUrl(sound.path);
    this.audio.play().catch(() => this.ui.toast('Could not play that sound.', 'error'));
    this.playingPath = sound.path;
    this.playingBtn = btn;
    btn.textContent = '■';
    btn.classList.add('on');
  }

  stopPreview() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    if (this.playingBtn) { this.playingBtn.textContent = '▶'; this.playingBtn.classList.remove('on'); }
    this.playingPath = null;
    this.playingBtn = null;
  }

  /** Imports the sound into the media bin (once) and returns its media id. */
  async importSound(sound) {
    const [id] = await this.ui.importPaths([sound.path]);
    return id || null;
  }

  async addToTimeline(sound) {
    const id = await this.importSound(sound);
    if (id) this.ui.placeAtPlayhead(id);
  }

  render() {
    const box = this.els.packs;
    box.innerHTML = '';
    if (!this.loaded) { box.appendChild(hint('Loading sounds…')); return; }
    const q = this.query;
    let shown = 0;
    for (const pack of this.packs) {
      const matches = pack.sounds.filter((s) => !q || s.name.toLowerCase().includes(q) || pack.name.toLowerCase().includes(q));
      if (q && !matches.length) continue;
      shown++;
      const open = q ? true : !this.collapsed.has(pack.id);
      const sec = document.createElement('section');
      sec.className = 'sound-pack';

      const head = document.createElement('button');
      head.className = 'pack-head';
      head.setAttribute('aria-expanded', String(open));
      const caret = el('span', 'caret', open ? '▾' : '▸');
      const title = el('span', 'pack-name', pack.name);
      const tag = el('span', 'pack-tag' + (pack.source === 'user' ? ' user' : ''), pack.source === 'user' ? 'Yours' : 'Built-in');
      const count = el('span', 'muted small', String(pack.sounds.length));
      head.append(caret, title, tag, count);
      head.title = [pack.description, pack.credit && `Credit: ${pack.credit}`, pack.license && `License: ${pack.license}`, pack.dir].filter(Boolean).join('\n');
      head.addEventListener('click', () => {
        if (this.collapsed.has(pack.id)) this.collapsed.delete(pack.id); else this.collapsed.add(pack.id);
        this.render();
      });
      sec.appendChild(head);

      if (open) {
        if (pack.description) sec.appendChild(el('div', 'pack-desc', pack.description));
        if (!pack.sounds.length) sec.appendChild(el('div', 'pack-desc', 'No sounds yet. Put audio files in this folder, then press ⟳.'));
        for (const s of matches) sec.appendChild(this.row(s));
      }
      box.appendChild(sec);
    }
    if (!shown) {
      box.appendChild(hint(q ? 'No sounds match your search.'
        : 'No sound packs yet. Use + Files or + Folder, or put folders of sounds in your library folder (📂).'));
    }
  }

  row(s) {
    const r = document.createElement('div');
    r.className = 'sound-row';
    r.draggable = true;
    r.title = `${s.file}\nDrag onto the timeline, or double-click to add at the playhead.`;
    const play = el('button', 'sound-play', this.playingPath === s.path ? '■' : '▶');
    play.setAttribute('aria-label', `Preview ${s.name}`);
    if (this.playingPath === s.path) { play.classList.add('on'); this.playingBtn = play; }
    play.addEventListener('click', (e) => { e.stopPropagation(); this.togglePreview(s, play); });
    const name = el('span', 'sound-name', s.name);
    const dur = el('span', 'sound-dur', s.duration ? formatTime(s.duration, 30, false) : '');
    const add = el('button', 'sound-add', '+');
    add.setAttribute('aria-label', `Add ${s.name} at the playhead`);
    add.title = 'Add at playhead';
    add.addEventListener('click', (e) => { e.stopPropagation(); this.addToTimeline(s); });
    r.append(play, name, dur, add);
    r.addEventListener('dblclick', () => this.addToTimeline(s));
    r.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(SOUND_MIME, s.path);
      e.dataTransfer.effectAllowed = 'copy';
    });
    return r;
  }
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
function hint(text) { return el('div', 'empty-hint', text); }
