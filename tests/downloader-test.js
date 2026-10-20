// Optional developer check (needs Node 18+). Runs the real downloader/downloader.js against a
// local HTTP server (serving tests/fixtures) with a fake page and fake chrome.downloads, and
// checks what would be saved: one merged MP4 for DASH and for video+audio file pairs, and the
// fallbacks. Merged files are decoded with ffprobe/ffmpeg when those are installed.
// Run from the project root:  node tests/downloader-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const assert = require('assert');
const { resolveObjectURL } = require('buffer');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');
const hasFF = spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-dl-'));
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ok -', msg); };

function types(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.stdout.trim().split(/\s+/).sort().join(',');
}
const decodes = (file) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }); return r.status === 0 && r.stderr.trim() === ''; };

// Serves fixtures; /expired.m4a returns an HTML page (a dead signed URL).
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/expired.m4a') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('<html>expired</html>'); }
  const f = path.join(fixtures, p);
  if (!f.startsWith(fixtures) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': 'application/octet-stream' });
  res.end(fs.readFileSync(f));
});

// Runs downloader.js with the given query string; resolves when it has finished.
async function run(base, query) {
  const els = {};
  const mk = () => {
    const e = { _text: '', hidden: false, className: '', value: 0, children: [], listeners: {},
      get textContent() { return e._text; }, set textContent(v) { e._text = v; },
      addEventListener(t, f) { e.listeners[t] = f; }, append(...k) { e.children.push(...k); } };
    return e;
  };
  const saved = [];
  const document = { title: '', getElementById: (i) => (els[i] = els[i] || mk()), createElement: () => mk() };
  const chrome = { downloads: {
    download: async (o) => { saved.push({ filename: o.filename, blob: resolveObjectURL(o.url) }); return saved.length; },
    onChanged: { addListener() {}, removeListener() {} } } };
  const ctx = { document, chrome, URL, URLSearchParams, AbortController, Blob, fetch, console, setTimeout, location: { search: '?' + query },
    SVDStream: require('../lib/stream.js'), SVDMux: require('../lib/mux.js'), SVDWebm: require('../lib/webm.js') };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'downloader/downloader.js'), 'utf8'), ctx);
  for (let i = 0; i < 400 && !/^(Done|Invalid|[A-Z].*(failed|refused|expired|not|could|empty))/i.test(els.status ? els.status._text : '') ; i++) {
    await new Promise((r) => setTimeout(r, 25));
    if (els.status && (els.status.className === 'done' || els.status.className === 'error')) break;
  }
  await new Promise((r) => setTimeout(r, 30));
  return { els, saved, status: els.status._text, cls: els.status.className, note: els.note ? els.note._text : '', title: document.title };
}
const q = (o) => new URLSearchParams(o).toString();

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${server.address().port}`;
  try {
    console.log('downloader: DASH (separate video + audio) is merged into one file');
    let r = await run(B, q({ url: `${B}/dash/manifest.mpd`, quality: 'best', name: 'Clip' }));
    ok(r.cls === 'done' && r.saved.length === 1 && r.saved[0].filename === 'Clip.mp4', `one file saved: ${r.saved.map((s) => s.filename).join(', ')}`);
    ok(/merged into one MP4/.test(r.note), 'a note explains the merged file');
    if (hasFF) {
      const f = path.join(tmp, 'dash.mp4'); fs.writeFileSync(f, Buffer.from(await r.saved[0].blob.arrayBuffer()));
      ok(types(f) === 'audio,video' && decodes(f), 'ffprobe/ffmpeg: merged DASH download has audio + video and decodes with zero errors');
    }

    console.log('downloader: HLS fMP4 (single muxed track) is saved as is');
    r = await run(B, q({ url: `${B}/hls-fmp4/media.m3u8`, name: 'Muxed' }));
    ok(r.cls === 'done' && r.saved.length === 1 && r.saved[0].filename === 'Muxed.mp4', 'a single-track result is saved as one .mp4 without merging');

    console.log('downloader: video file + audio file (pair) are downloaded in full and merged');
    r = await run(B, q({ url: `${B}/mux/v_prog.mp4`, audio: `${B}/mux/a_prog.m4a`, name: 'Reel' }));
    ok(r.cls === 'done' && r.saved.length === 1 && r.saved[0].filename === 'Reel.mp4', `one merged file saved: ${r.saved.map((s) => s.filename).join(', ')}`);
    ok(/^Video file \+ audio file/.test(r.els.info._text), 'info line says what is being downloaded');
    if (hasFF) {
      const f = path.join(tmp, 'pair.mp4'); fs.writeFileSync(f, Buffer.from(await r.saved[0].blob.arrayBuffer()));
      ok(types(f) === 'audio,video' && decodes(f), 'ffprobe/ffmpeg: merged progressive pair has audio + video and decodes with zero errors');
    }
    r = await run(B, q({ url: `${B}/mux/v_frag.mp4`, audio: `${B}/mux/a_frag.m4a`, name: 'Frag' }));
    ok(r.cls === 'done' && r.saved.length === 1 && r.saved[0].filename === 'Frag.mp4', 'a fragmented pair is merged too');

    console.log('downloader: fallbacks (never lose the download)');
    r = await run(B, q({ url: `${B}/webm/v.webm`, audio: `${B}/webm/a.webm`, name: 'Yt' }));
    ok(r.cls === 'done' && r.saved.length === 1 && r.saved[0].filename === 'Yt.webm' && /merged into one WebM/.test(r.note), 'a WebM video file + a WebM audio file (YouTube style) are merged into ONE .webm');
    if (hasFF) {
      const f = path.join(tmp, 'yt.webm'); fs.writeFileSync(f, Buffer.from(await r.saved[0].blob.arrayBuffer()));
      ok(types(f) === 'audio,video' && decodes(f), 'ffprobe/ffmpeg: that file has picture and sound and decodes cleanly');
    }
    r = await run(B, q({ url: `${B}/mux/v_prog.mp4`, audio: `${B}/webm/a.webm`, name: 'Cross' }));
    ok(r.cls === 'done' && r.saved.length === 2 && /Could not merge/.test(r.note) && /mp4 \+ webm/.test(r.note), 'MP4 video + WebM audio: two files and the note names the combination');
    r = await run(B, q({ url: `${B}/hls/separate-audio.m3u8`, name: 'Ts' }));
    ok(r.cls === 'done' && r.saved.length === 2 && r.saved.map((s) => s.filename).sort().join() === 'Ts.audio.ts,Ts.ts', 'HLS TS + separate audio is saved as two files');
    ok(/Could not merge/.test(r.note) && /MPEG-TS/.test(r.note), 'and says why it could not merge');
    r = await run(B, q({ url: `${B}/mux/v_prog.mp4`, audio: `${B}/mux/a_frag.m4a`, name: 'Mix' }));
    ok(r.cls === 'done' && r.saved.length === 2 && /Could not merge/.test(r.note) && /ffmpeg -i "Mix\.mp4" -i "Mix\.audio\.m4a"/.test(r.els.note.children.map((c) => c._text).join('') + r.note), 'a progressive + fragmented mix is saved as two files with the FFmpeg command');

    console.log('downloader: errors save nothing');
    r = await run(B, q({ url: `${B}/mux/v_prog.mp4`, audio: `${B}/expired.m4a`, name: 'Bad' }));
    ok(r.cls === 'error' && r.saved.length === 0 && /HTML|expired/i.test(r.status), `an expired/HTML audio URL fails clearly and saves nothing ("${r.status}")`);
    r = await run(B, q({ url: `${B}/mux/nope.mp4`, audio: `${B}/mux/a_prog.m4a`, name: 'Gone' }));
    ok(r.cls === 'error' && r.saved.length === 0 && /404/.test(r.status), 'a missing video file reports HTTP 404');
    r = await run(B, q({ url: 'javascript:alert(1)', audio: `${B}/mux/a_prog.m4a`, name: 'X' }));
    ok(r.cls === 'error' && /Invalid URL/.test(r.status) && r.saved.length === 0, 'non-http URLs are refused');

    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error('\nFAILED:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
