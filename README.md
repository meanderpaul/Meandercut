# MeanderCut

A focused desktop video editor for Windows. It has the editing core of CapCut and leaves out the stickers, text blurbs and effect packs.

Built by **Meanderpaul_gaming**.

![MeanderCut icon](build/icon.png)

## Features

**Editing**
- Multi-track timeline with unlimited video and audio tracks
- Split, trim, ripple delete, duplicate, and drag clips between tracks
- Snapping to the playhead and clip edges, marquee selection, and undo/redo
- Overwrite editing: dropping a clip on top of another trims the one underneath instead of stacking them
- Speed from 0.1x to 8x with pitch-preserved audio, plus reverse

**Media**
- Import video (MP4, MOV, MKV, WebM, AVI, MTS...), audio (MP3, WAV, M4A, FLAC, OGG...) and images (PNG, JPG, WebP, GIF...)
- Import with the button or by dragging files in from Explorer
- Thumbnails on video clips and waveforms on audio clips
- Missing-file detection with relinking when a project is reopened

**Audio**
- Separate audio from video onto its own track (**Detach audio**)
- Save any clip's audio as WAV, MP3 or M4A (**Extract audio**)
- Per-clip volume (0–200%), fade in and fade out, and mute
- Per-track volume, mute and solo, with a stereo output meter
- **Voice-over recorder**: pick a microphone, use a 3-2-1 countdown, and record while the timeline plays so you can narrate over your footage. Noise suppression is optional. Takes save as 48 kHz WAV files in `Documents\MeanderCut\Recordings` and land on the Voice-over track.

**View and picture**
- Canvas aspect ratios: 16:9 (YouTube), 9:16 (Shorts/TikTok), 1:1, 4:5, 4:3 and 21:9, plus custom sizes
- Project resolution from 720p to 4K, with frame rates from 23.976 to 120 fps
- Per clip: Fit, Fill or Stretch, scale, position, rotation, flip, crop, opacity, brightness, contrast, saturation and gamma
- Move and resize clips directly in the preview
- Preview zoom, preview quality (Full, Half or Quarter for smooth playback with 4K footage), and safe-area and grid guides

**Export**
- MP4 (H.264 or H.265/HEVC), MKV, MOV ProRes 422 HQ, or audio-only MP3 and WAV
- Resolutions up to **4K UHD (3840×2160)** and DCI 4K (4096×2160), with vertical versions for 9:16 projects
- Constant-quality (CRF) or target-bitrate encoding, encoder speed presets, and 10-bit HEVC
- GPU encoding on NVIDIA (NVENC), Intel (Quick Sync) and AMD (AMF), detected automatically
- Sample rate (44.1, 48 or 96 kHz), audio bitrate, and mono or stereo output
- Progress bar with time remaining, and cancel

**Projects**
- Save and open `.mcut` project files (plain JSON)
- Autosave with crash recovery

## Install and run (Windows)

1. Install **Node.js LTS** from [nodejs.org](https://nodejs.org).
2. Download this repo (**Code → Download ZIP**) and unzip it, or `git clone` it.
3. Double-click **`setup.bat`**. It installs Electron and FFmpeg once, then opens MeanderCut.
4. Next time, double-click **`start.bat`**.

FFmpeg is included through `ffmpeg-static`, so there's nothing else to install.

### Build an installer

Double-click **`build-installer.bat`**, or run:

```
npm run dist
```

This creates a Windows installer and a portable `.exe` in the `dist` folder.

## Keyboard shortcuts

| Action | Keys |
|---|---|
| Play / pause | Space |
| Previous / next frame | ← / → |
| Jump 1 second | Shift + ← / → |
| Split at playhead | S or Ctrl+B |
| Delete / ripple delete | Delete / Shift+Delete |
| Duplicate | Ctrl+D |
| Detach audio | Ctrl+Shift+D |
| Undo / redo | Ctrl+Z / Ctrl+Y |
| Import | Ctrl+I |
| Record voice-over | Ctrl+R |
| Export | Ctrl+E |
| Save / Save as | Ctrl+S / Ctrl+Shift+S |
| Snapping on/off | N |
| Zoom timeline | Ctrl + mouse wheel |
| Fit timeline | Shift+Z |

Press **F1** in the app to see the full list.

## How it works

- **Electron** provides the window and interface (`src/renderer`). The preview draws clips on a canvas and mixes audio with the Web Audio API.
- **FFmpeg** does the real work (`src/main/exporter.js`). Each export becomes a single FFmpeg filter graph that trims, retimes, crops, scales, rotates, color-adjusts and layers every clip, then mixes all audio with fades and volume. The preview and the exporter use the same layout math, so the export matches what you see.
- Media is streamed to the preview through a private `app://` protocol with seeking support, and only files you have imported are served.

## Notes

- Reversed clips play silent in the preview, but their audio is reversed in the export.
- The gamma adjustment shows in the export only.
- For heavy 4K or HEVC footage, set preview quality to Half or Quarter. Exports always render at full quality.

## Tests

```
npm test
```

This runs the editing-operation tests and renders real exports (1080p, 4K, HEVC, ProRes, WAV and MP3) through FFmpeg to check durations, codecs and overlay timing.

## License

MIT © 2026 Meanderpaul_gaming
