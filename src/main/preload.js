'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const h = (_e, ...a) => fn(...a);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('mc', {
  importMedia: invoke('dialog:importMedia'),
  probe: invoke('media:probe'),
  waveform: invoke('media:waveform'),
  thumbnail: invoke('media:thumbnail'),
  relink: invoke('media:relink'),
  saveProject: invoke('project:save'),
  openProject: invoke('project:open'),
  autosave: invoke('project:autosave'),
  readAutosave: invoke('project:readAutosave'),
  clearAutosave: invoke('project:clearAutosave'),
  exportFormats: invoke('export:formats'),
  exportEncoders: invoke('export:encoders'),
  chooseExportPath: invoke('export:chooseOutput'),
  startExport: invoke('export:start'),
  cancelExport: invoke('export:cancel'),
  onExportProgress: on('export:progress'),
  extractAudio: invoke('audio:extract'),
  saveRecording: invoke('record:save'),
  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  showItem: invoke('shell:showItem'),
  closeNow: invoke('app:closeNow'),
  info: invoke('app:info'),
  onMenu: on('menu'),
  onRequestClose: on('app:request-close'),
  // Path of a file dropped from Windows Explorer
  pathForFile: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path),
  mediaUrl: (p) => 'app://local/media?p=' + encodeURIComponent(p),
});
