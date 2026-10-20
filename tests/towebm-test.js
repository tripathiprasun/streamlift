// Optional developer check (Node 18+, ffmpeg + ffprobe with libvpx-vp9; no npm packages).
// Covers lib/towebm.js (Instagram: MP4 VP9/AV1 picture -> WebM, frames copied): progressive and fragmented MP4 input,
// every result DECODED by ffmpeg. The AAC -> Opus half needs a real browser: node tests/towebm-browser-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('../lib/towebm.js');
const has = (c) => spawnSync(c, ['-version']).status === 0;
if (!has('ffmpeg') || !has('ffprobe')) { console.log('skipped: ffmpeg/ffprobe not installed'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-towebm-'));
let passed = 0;
const ok = (c, m) => { if (!c) { console.log('  FAIL -', m); process.exitCode = 1; throw new Error('FAILED: ' + m); } passed++; console.log('  ok -', m); };
const ff = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
const probe = (f, args) => spawnSync('ffprobe', ['-v', 'error', ...args, f], { encoding: 'utf8' }).stdout.trim();
const src = ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '4', '-g', '60', '-an'];
const make = (name, codec, flags) => { const f = path.join(tmp, name); const r = ff([...src, '-c:v', codec, ...(codec === 'libaom-av1' ? ['-cpu-used', '8'] : []), ...flags, f]); return r.status === 0 ? f : null; };
(async () => {
  const cases = [
    ['VP9 progressive MP4', make('p.mp4', 'libvpx-vp9', ['-movflags', '+faststart']), 'vp9'],
    ['VP9 fragmented MP4', make('f.mp4', 'libvpx-vp9', ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']), 'vp9'],
    ['AV1 fragmented MP4', make('a.mp4', 'libaom-av1', ['-movflags', 'frag_keyframe+empty_moov+default_base_moof']), 'av1'],
  ];
  for (const [label, file, codec] of cases) {
    if (!file) { console.log('  skipped -', label, '(encoder not available)'); continue; }
    const out = await T.mp4PairToWebm(new Blob([fs.readFileSync(file)]), null, {});
    const o = path.join(tmp, label.replace(/\W+/g, '_') + '.webm');
    fs.writeFileSync(o, Buffer.from(await out.arrayBuffer()));
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', o, '-f', 'null', '-'], { encoding: 'utf8' });
    ok(dec.status === 0 && dec.stderr.trim() === '', label + ': ffmpeg decodes it without any message');
    ok(probe(o, ['-select_streams', 'v', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0']) === codec, label + ': codec is ' + codec);
    ok(probe(o, ['-count_frames', '-select_streams', 'v', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0']) === '120', label + ': all 120 frames are there');
    const keys = probe(o, ['-select_streams', 'v', '-show_entries', 'packet=flags', '-of', 'csv=p=0']).split('\n').filter((l) => l.startsWith('K')).length;
    ok(keys === 2, label + ': both key frames kept');
    ok(fs.readFileSync(o).includes(Buffer.from([0x1c, 0x53, 0xbb, 0x6b])), label + ': has a seek index (Cues)');
    ok(ff(['-ss', '2.5', '-i', o, '-t', '1', '-f', 'null', '-']).status === 0, label + ': seeking works');
  }
  // H.264 cannot go into WebM: refused with a clear code, so the caller keeps the MP4 merge
  const h = path.join(tmp, 'h.mp4'); ff([...src, '-c:v', 'libx264', h]);
  let err = null; try { await T.mp4PairToWebm(new Blob([fs.readFileSync(h)]), null, {}); } catch (e) { err = e; }
  ok(err && err.code === 'UNSUPPORTED' && /H\.264/.test(err.message), 'H.264 is refused (UNSUPPORTED)');
  let err2 = null; try { await T.mp4PairToWebm(new Blob([Buffer.from('not a video at all')]), null, {}); } catch (e) { err2 = e; }
  ok(err2 && err2.name === 'ToWebmError', 'garbage input is refused cleanly');
  console.log(passed + ' checks passed');
})().catch((e) => { console.error(e.message); process.exit(1); });
