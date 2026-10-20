// Optional developer check: the AAC -> Opus half of lib/towebm.js in a real Chromium (needs: npm i, ffmpeg, ffprobe).
// Builds VP9-in-MP4 + an audio file with ffmpeg, runs SVDToWebm.mp4PairToWebm in the page, decodes the result with ffmpeg.
// Audio source: AAC .m4a when this browser can decode AAC (Chrome/Edge can; Playwright's Chromium cannot),
// otherwise a WAV file, which still checks Opus encoding + muxing. Run: node tests/towebm-browser-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('skipped: playwright is not installed (npm install)'); process.exit(0); }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-towebm-b-'));
const ff = (args) => spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' });
const v = path.join(tmp, 'v.mp4'), aac = path.join(tmp, 'a.m4a'), wav = path.join(tmp, 'a.wav');
ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30', '-t', '4', '-c:v', 'libvpx-vp9', '-g', '60', '-an', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', v]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4', '-ac', '2', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', aac]);
ff(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '4', '-ac', '2', wav]);
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  await p.route('http://localhost:8123/**', (r) => r.fulfill({ contentType: 'text/html', body: '<html></html>' }));   // WebCodecs needs a secure context
  await p.goto('http://localhost:8123/');
  await p.addScriptTag({ content: fs.readFileSync(path.join(__dirname, '..', 'lib', 'towebm.js'), 'utf8') });
  const b64 = (f) => fs.readFileSync(f).toString('base64');
  const res = await p.evaluate(async (files) => {
    const mk = (s) => new Blob([Uint8Array.from(atob(s), (c) => c.charCodeAt(0))]);
    const run = async (a) => {
      try {
        const w = await SVDToWebm.mp4PairToWebm(mk(files.v), mk(a), {});
        const u = new Uint8Array(await w.arrayBuffer()); let s = '';
        for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
        return { b64: btoa(s) };
      } catch (e) { return { err: e.name + ': ' + e.message }; }
    };
    return { aac: await run(files.aac), wav: await run(files.wav) };
  }, { v: b64(v), aac: b64(aac), wav: b64(wav) });
  await b.close();
  let used = null;
  for (const k of ['aac', 'wav']) if (res[k].b64) { used = k; break; }
  if (res.aac.err) console.log('  note - AAC not decodable in this browser (' + res.aac.err + '); using WAV source');
  if (!used) { console.log('FAIL -', JSON.stringify(res)); process.exit(1); }
  const out = path.join(tmp, 'out.webm'); fs.writeFileSync(out, Buffer.from(res[used].b64, 'base64'));
  const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-f', 'null', '-'], { encoding: 'utf8' });
  const streams = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout.trim().split(/\s+/).sort().join(',');
  const dur = parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' }).stdout);
  const good = dec.status === 0 && dec.stderr.trim() === '' && streams === 'opus,vp9' && Math.abs(dur - 4) < 0.2;
  console.log((good ? '  ok - ' : '  FAIL - ') + `one WebM (${streams}, ${dur}s) from ${used} source, ffmpeg decodes it${dec.stderr.trim() ? ': ' + dec.stderr.trim() : ''}`);
  process.exit(good ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
