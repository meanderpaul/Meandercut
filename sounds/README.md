# Sound packs

Every folder in here is a **sound pack**. MeanderCut ships these packs with the app and shows them under **Media › Sounds**, where you can preview a sound, double-click it (or press **+**) to drop it at the playhead, or drag it onto any audio track.

| Pack | What's in it |
|---|---|
| `cryptid-compendium-mothman` | 19 sounds and music beds for the Cryptid Compendium Mothman episode, with a cue sheet |

## Adding packs

**To the app for everyone (bundled):** add a folder here and commit it. It's copied into the installer by `npm run dist`.

**Just for you (no rebuild):** in the Sounds tab use **+ Files** (copies into *My Sounds*) or **+ Folder** (copies a whole folder in as a new pack), or press 📂 and drop folders into `Documents\MeanderCut\Sounds` yourself, then press ⟳.

## Pack format

- Any audio MeanderCut can play: MP3, WAV, M4A, AAC, FLAC, OGG, Opus. Sub-folders are included.
- Files are listed in name order. A leading number is hidden from the display name, so `02_night_ambience.mp3` shows as *Night ambience* and still sorts second.
- Optional `pack.json` for a nicer name and details shown on hover:

```json
{
  "name": "Cryptid Compendium: Mothman",
  "description": "What the pack is for.",
  "credit": "Who made it",
  "license": "How it may be used"
}
```

Only bundle sounds you have the rights to share.
