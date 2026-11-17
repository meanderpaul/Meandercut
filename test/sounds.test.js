// Sound library tests. Run: node test/sounds.test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listSounds, prettyName, copyFilesInto, copyFolderInto } = require('../src/main/sounds');

(async () => {
  // Display names
  assert.equal(prettyName('02_night_ambience_crickets.mp3'), 'Night ambience crickets');
  assert.equal(prettyName('door-slam.wav'), 'Door slam');
  assert.equal(prettyName('Thunder Roll.flac'), 'Thunder Roll');

  // The bundled packs in /sounds load, every file is audio, and pack.json is honoured.
  const repoSounds = path.join(__dirname, '..', 'sounds');
  const packs = await listSounds([{ dir: repoSounds, source: 'builtin' }]);
  const mothman = packs.find((p) => p.name === 'Cryptid Compendium: Mothman');
  assert.ok(mothman, 'Mothman pack is bundled');
  assert.equal(mothman.sounds.length, 19);
  assert.equal(mothman.sounds[0].name, 'Theme music');
  assert.ok(mothman.sounds.every((s) => s.path.endsWith('.mp3')));
  assert.ok(mothman.license && mothman.credit);

  // A user library: folders become packs, loose files go to "Unsorted", non-audio is ignored,
  // sub-folders are included, and empty user folders still show (so people see where to put files).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-sounds-'));
  const user = path.join(tmp, 'Sounds');
  fs.mkdirSync(path.join(user, 'Horror', 'Doors'), { recursive: true });
  fs.mkdirSync(path.join(user, 'Empty'), { recursive: true });
  fs.writeFileSync(path.join(user, 'Horror', '10_scream.wav'), 'x');
  fs.writeFileSync(path.join(user, 'Horror', '2_creak.mp3'), 'x');
  fs.writeFileSync(path.join(user, 'Horror', 'notes.txt'), 'x');
  fs.writeFileSync(path.join(user, 'Horror', 'Doors', 'slam.ogg'), 'x');
  fs.writeFileSync(path.join(user, 'loose.m4a'), 'x');
  const mine = await listSounds([{ dir: user, source: 'user' }], async () => 1.5);
  assert.deepEqual(mine.map((p) => p.name), ['Empty', 'Horror', 'Unsorted']);
  const horror = mine.find((p) => p.name === 'Horror');
  assert.deepEqual(horror.sounds.map((s) => s.name), ['Creak', 'Scream', 'Slam']); // numeric sort, sub-folder last
  assert.ok(horror.sounds.every((s) => s.duration === 1.5 && s.path));
  assert.equal(mine.find((p) => p.name === 'Empty').sounds.length, 0);

  // A missing library folder is just empty
  assert.deepEqual(await listSounds([{ dir: path.join(tmp, 'nope'), source: 'user' }]), []);

  // Copying files in never overwrites
  const a = await copyFilesInto([path.join(user, 'loose.m4a'), path.join(user, 'Horror', 'notes.txt')], path.join(user, 'My Sounds'));
  const b = await copyFilesInto([path.join(user, 'loose.m4a')], path.join(user, 'My Sounds'));
  assert.equal(a.length, 1, 'non-audio skipped');
  assert.equal(path.basename(b[0]), 'loose (2).m4a');

  // Copying a folder in makes a new pack with only audio + pack notes
  const src = path.join(tmp, 'Ambience');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'rain.wav'), 'x');
  fs.writeFileSync(path.join(src, 'pack.json'), JSON.stringify({ name: 'Rainy Days' }));
  fs.writeFileSync(path.join(src, 'thumbs.db'), 'x');
  const dest = await copyFolderInto(src, user);
  assert.ok(fs.existsSync(path.join(dest, 'rain.wav')));
  assert.ok(fs.existsSync(path.join(dest, 'pack.json')));
  assert.ok(!fs.existsSync(path.join(dest, 'thumbs.db')));
  assert.ok((await listSounds([{ dir: user, source: 'user' }])).some((p) => p.name === 'Rainy Days'));
  await assert.rejects(copyFolderInto(path.join(user, 'Horror'), user), /already in your sound library/);
  fs.mkdirSync(path.join(tmp, 'NoAudio'));
  await assert.rejects(copyFolderInto(path.join(tmp, 'NoAudio'), user), /No audio files/);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('sounds tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
