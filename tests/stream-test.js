// Tests for lib/stream.js: parsing, URL resolution, segment ordering, error handling, and real
// downloads from a local HTTP server serving tests/fixtures. Run: node tests/stream-test.js
// If ffprobe/ffmpeg are installed, the saved output is also checked to be playable.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { execFileSync, spawnSync } = require('child_process');
const S = require('../lib/stream.js');

const FIX = path.join(__dirname, 'fixtures');
let passed = 0;
const ok = (c, m) => { assert.ok(c, m); passed++; console.log('  ok -', m); };
const rejects = async (p, code, re, m) => {
  try { await p; } catch (e) { ok(e.name === 'StreamError' && e.code === code && re.test(e.message), `${m} [${code}]`); return; }
  assert.fail('expected rejection: ' + m);
};
const hasTool = (t) => spawnSync(t, ['-version']).status === 0;
const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file]).toString());

// ---- local server with per-path overrides and a request log ----
const log = [];
let overrides = {};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  log.push(u.pathname);
  const o = overrides[u.pathname];
  if (o) return o(req, res);
  const f = path.join(FIX, path.normalize(u.pathname));
  if (!f.startsWith(FIX) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('nope'); }
  const data = fs.readFileSync(f);
  const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
  if (range) { res.writeHead(206); return res.end(data.subarray(+range[1], +range[2] + 1)); }
  // Random delay so parallel segments finish out of order.
  setTimeout(() => { res.writeHead(200); res.end(data); }, /\.(ts|m4s)$/.test(f) ? Math.random() * 40 : 0);
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const B = `http://127.0.0.1:${server.address().port}`;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-'));
  const save = async (files, name) => Promise.all(files.map(async (f) => {
    const p = path.join(out, `${name}${f.suffix}.${f.ext}`);
    fs.writeFileSync(p, Buffer.from(await f.blob.arrayBuffer()));
    return p;
  }));
  const bytes = async (blob) => Buffer.from(await blob.arrayBuffer());
  const fx = (f) => fs.readFileSync(path.join(FIX, f));

  console.log('HLS parsing and URL resolution');
  const m = S.parseHls(fx('hls/master.m3u8').toString(), 'https://cdn.example.com/a/b/master.m3u8?token=1');
  ok(m.type === 'master' && m.variants.length === 2, 'master playlist: 2 variants');
  ok(m.variants[0].url === 'https://cdn.example.com/a/b/hi.m3u8' && m.variants[0].height === 120 && m.variants[0].bandwidth === 120000, 'variant URL resolved against playlist URL; resolution/bandwidth parsed');
  const med = S.parseHls('#EXTM3U\n#EXT-X-MAP:URI="../init.mp4"\n#EXTINF:2,\nseg0.m4s?x=1\n#EXTINF:2,\n/abs/seg1.m4s\n#EXTINF:2,\nhttps://other.example.org/seg2.m4s\n#EXT-X-ENDLIST\n', 'https://cdn.example.com/a/b/v.m3u8');
  ok(med.segments.map((s) => s.url).join('|') === 'https://cdn.example.com/a/b/seg0.m4s?x=1|https://cdn.example.com/abs/seg1.m4s|https://other.example.org/seg2.m4s', 'relative, root-relative, absolute segment URLs resolve; order preserved');
  ok(med.map.url === 'https://cdn.example.com/a/init.mp4' && med.endList, 'EXT-X-MAP resolved with ../; ENDLIST detected');
  const br = S.parseHls('#EXTM3U\n#EXT-X-BYTERANGE:100@0\ns.ts\n#EXT-X-BYTERANGE:50\ns.ts\n#EXT-X-ENDLIST', 'https://e.com/p.m3u8');
  ok(br.segments[0].range.offset === 0 && br.segments[1].range.offset === 100 && br.segments[1].range.length === 50, 'BYTERANGE with implicit offset continues the previous range');
  await rejects(Promise.resolve().then(() => S.parseHls('<html>', 'https://e.com/')), 'BAD_MANIFEST', /not a valid HLS/, 'non-playlist text rejected');
  ok(S.parseHls('#EXTM3U\r\n#EXT-X-KEY:METHOD=AES-128,URI="k"\r\n#EXTINF:1,\r\na.ts\r\n', 'https://e.com/p.m3u8').encrypted === 'AES-128', 'CRLF playlist; AES-128 key detected');

  console.log('DASH parsing');
  const d = S.parseDash(fx('dash/manifest.mpd').toString(), 'https://cdn.example.com/v/manifest.mpd');
  const vt = d.tracks.find((t) => t.type === 'video'), at = d.tracks.find((t) => t.type === 'audio');
  ok(d.tracks.length === 2 && vt.height === 120 && at.codecs === 'mp4a.40.2', 'video + audio tracks found with attributes');
  ok(vt.init === 'https://cdn.example.com/v/init-stream0.m4s' && vt.segments.join() === [1, 2, 3].map((n) => `https://cdn.example.com/v/chunk-stream0-0000${n}.m4s`).join(), 'SegmentTimeline (r=2) expands to 3 ordered URLs; $RepresentationID$/$Number%05d$ filled');
  ok(at.segments.length === 3 && at.segments[2].endsWith('chunk-stream1-00003.m4s'), 'audio timeline with 3 explicit <S> entries');
  ok(S.fillTemplate('a/$Time$/$Bandwidth$/$$/$Number%03d$', { Time: 90, Bandwidth: 5, Number: 7 }) === 'a/90/5/$/007', 'template substitution incl. $$ and width');
  ok(S.isoDuration('PT1H2M3.5S') === 3723.5 && S.isoDuration('PT6.0S') === 6, 'ISO-8601 durations');
  const tpl = S.parseDash(`<MPD type="static" mediaPresentationDuration="PT10S"><BaseURL>media/</BaseURL><Period><AdaptationSet mimeType="video/mp4"><Representation id="v1" bandwidth="1000" codecs="avc1.64001f" height="360"><SegmentTemplate media="$RepresentationID$_$Number$.m4s" initialization="i.mp4" duration="4" startNumber="5"/></Representation></AdaptationSet></Period></MPD>`, 'https://e.com/d/m.mpd');
  ok(tpl.tracks[0].segments.join() === ['5', '6', '7'].map((n) => `https://e.com/d/media/v1_${n}.m4s`).join(), 'duration-based template: ceil(10/4)=3 segments from startNumber, BaseURL applied');
  const lst = S.parseDash(`<MPD><Period><AdaptationSet contentType="audio"><Representation id="a" bandwidth="1" codecs="mp4a.40.2"><SegmentList><Initialization sourceURL="i.mp4"/><SegmentURL media="s1.m4s"/><SegmentURL media="s2.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>`, 'https://e.com/m.mpd');
  ok(lst.tracks[0].segments.length === 2 && lst.tracks[0].init === 'https://e.com/i.mp4', 'SegmentList supported');
  const one = S.parseDash(`<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation id="a" bandwidth="1" codecs="avc1.4d401f"><BaseURL>full.mp4</BaseURL><SegmentBase indexRange="0-99"/></Representation></AdaptationSet></Period></MPD>`, 'https://e.com/x/m.mpd');
  ok(one.tracks[0].segments.join() === 'https://e.com/x/full.mp4', 'single-file (BaseURL + SegmentBase) representation');
  const bad = (x) => () => S.parseDash(x, 'https://e.com/m.mpd');
  assert.throws(bad('<MPD type="dynamic"><Period/></MPD>'), (e) => e.code === 'LIVE'); ok(true, 'dynamic (live) MPD rejected as LIVE');
  assert.throws(bad('<MPD><Period/><Period/></MPD>'), (e) => e.code === 'UNSUPPORTED'); ok(true, 'multi-period MPD rejected as UNSUPPORTED');
  assert.throws(bad('<MPD><Period><AdaptationSet'), (e) => e.code === 'BAD_MANIFEST'); ok(true, 'malformed XML rejected as BAD_MANIFEST');

  console.log('describe(): DRM, encryption, codecs');
  const drm = `<MPD><Period><AdaptationSet contentType="video"><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"/><Representation id="1" bandwidth="1" codecs="avc1.4d401f"><BaseURL>a.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>`;
  assert.throws(() => S.describe(drm, 'https://e.com/m.mpd'), (e) => e.code === 'DRM' && /DRM/.test(e.message)); ok(true, 'ContentProtection (DRM) refused with explanation');
  assert.throws(() => S.describe(fx('hls/encrypted.m3u8').toString(), 'https://e.com/e.m3u8'), (e) => e.code === 'ENCRYPTED' && /not downloaded/.test(e.message)); ok(true, 'encrypted HLS refused (AES-128)');
  assert.throws(() => S.describe(fx('hls/badcodec.m3u8').toString(), 'https://e.com/b.m3u8'), (e) => e.code === 'UNSUPPORTED_CODEC' && /dvh1/.test(e.message)); ok(true, 'unsupported codecs named in the error');
  ok(S.unsupportedCodecs('avc1.64001f,mp4a.40.2').length === 0 && S.unsupportedCodecs('wvtt').length === 1, 'codec allow-list');
  const q = S.describe(fx('hls/master.m3u8').toString(), 'https://e.com/m.m3u8').qualities;
  ok(q.length === 2 && /^120p/.test(q[0].label) && /^72p/.test(q[1].label), 'HLS qualities sorted best-first with labels');
  ok(S.describe(fx('dash/manifest.mpd').toString(), 'https://e.com/m.mpd').qualities[0].label.startsWith('120p'), 'DASH qualities listed');

  console.log('HLS download (MPEG-TS)');
  const prog = [];
  let info;
  let r = await S.downloadStream({ url: `${B}/hls/master.m3u8`, onProgress: (p) => prog.push(p), onInfo: (i) => { info = i; } });
  const expectHi = Buffer.concat(['hi_0.ts', 'hi_1.ts', 'hi_2.ts'].map((f) => fx('hls/' + f)));
  ok(r.files.length === 1 && r.files[0].ext === 'ts', 'one .ts file produced');
  ok((await bytes(r.files[0].blob)).equals(expectHi), 'segments concatenated in playlist order despite out-of-order arrival (best quality picked)');
  ok(info.kind === 'hls' && /^120p/.test(info.quality) && info.segments === 3, 'selected format reported');
  ok(prog.at(-1).done === 3 && prog.at(-1).total === 3 && prog.at(-1).bytes === expectHi.length, 'progress reports segments and bytes');
  r = await S.downloadStream({ url: `${B}/hls/master.m3u8`, quality: '1' });
  ok((await bytes(r.files[0].blob)).equals(Buffer.concat(['lo_0.ts', 'lo_1.ts', 'lo_2.ts'].map((f) => fx('hls/' + f)))), 'choosing the 72p quality downloads the lower variant');
  r = await S.downloadStream({ url: `${B}/hls/hi.m3u8` });
  ok(r.files[0].blob.size === expectHi.length, 'a media playlist works without a master');
  if (hasTool('ffprobe')) {
    const [f] = await save(r.files, 'hls-ts');
    const pr = probe(f); ok(pr.streams.length === 2 && +pr.format.duration > 5, 'ffprobe: .ts output is valid with video+audio, ~6 s');
  }

  console.log('HLS download (fMP4 with init segment)');
  r = await S.downloadStream({ url: `${B}/hls-fmp4/media.m3u8` });
  const expectF = Buffer.concat(['init.mp4', 's_0.m4s', 's_1.m4s', 's_2.m4s'].map((f) => fx('hls-fmp4/' + f)));
  ok(r.files[0].ext === 'mp4' && (await bytes(r.files[0].blob)).equals(expectF), 'init segment first, then segments in order, saved as .mp4');
  if (hasTool('ffprobe')) { const [f] = await save(r.files, 'hls-fmp4'); const pr = probe(f); ok(pr.streams.length === 2 && +pr.format.duration > 5, 'ffprobe: fMP4 output is valid'); }

  console.log('HLS separate audio rendition');
  r = await S.downloadStream({ url: `${B}/hls/separate-audio.m3u8` });
  ok(r.files.length === 2 && r.files[0].role === 'video' && r.files[1].role === 'audio' && r.files[1].suffix === '.audio', 'video and audio saved as two files');

  console.log('DASH download');
  const dprog = [];
  r = await S.downloadStream({ url: `${B}/dash/manifest.mpd`, onProgress: (p) => dprog.push(p.track) });
  ok(r.files.length === 2 && r.files[0].ext === 'mp4' && r.files[1].ext === 'm4a', 'DASH: video .mp4 and audio .m4a');
  ok((await bytes(r.files[0].blob)).equals(Buffer.concat([fx('dash/init-stream0.m4s'), ...[1, 2, 3].map((n) => fx(`dash/chunk-stream0-0000${n}.m4s`))])), 'DASH video = init + segments in order');
  ok(dprog.includes('Video') && dprog.includes('Audio'), 'progress reported per track');
  if (hasTool('ffmpeg') && hasTool('ffprobe')) {
    const [vf, af] = await save(r.files, 'dash');
    const merged = path.join(out, 'merged.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', vf, '-i', af, '-c', 'copy', merged]);
    const pr = probe(merged);
    ok(pr.streams.length === 2 && +pr.format.duration > 5, 'ffmpeg -c copy merge of the saved video + audio plays (2 streams, ~6 s)');
  }

  console.log('error handling');
  const getErr = async (url, extra) => S.downloadStream({ url, ...extra });
  await rejects(getErr(`${B}/hls/encrypted.m3u8`), 'ENCRYPTED', /encrypted/, 'encrypted HLS refused at download');
  await rejects(getErr(`${B}/hls/live.m3u8`), 'LIVE', /live or incomplete/, 'playlist without ENDLIST refused');
  await rejects(getErr(`${B}/hls/badcodec.m3u8`), 'UNSUPPORTED_CODEC', /Unsupported codec/, 'unsupported codec refused');
  await rejects(getErr(`${B}/hls/missing.m3u8`), 'MISSING_SEGMENT', /segment 2 of 3.*404/, 'missing segment reported with its number');
  await rejects(getErr(`${B}/nothing.m3u8`), 'MISSING_SEGMENT', /manifest was not found \(HTTP 404\)/, 'missing manifest reported');
  overrides['/hls/hi.m3u8'] = (q, s) => { s.writeHead(403); s.end(); };
  await rejects(getErr(`${B}/hls/hi.m3u8?Expires=1&Signature=x`), 'EXPIRED', /signed URL has probably expired/, '403 on a signed URL explained as expiry');
  await rejects(getErr(`${B}/hls/hi.m3u8`), 'EXPIRED', /Access is denied/, '403 without signature explained as access denied');
  overrides['/hls/hi.m3u8'] = (q, s) => { s.writeHead(401); s.end(); };
  await rejects(getErr(`${B}/hls/hi.m3u8`), 'AUTH', /requires a login/, '401 reported; no bypass attempted');
  overrides = { '/hls/hi.m3u8': (q, s) => { s.writeHead(200); s.end('<html>Sign in</html>'); } };
  await rejects(getErr(`${B}/hls/hi.m3u8`), 'BAD_MANIFEST', /did not return an HLS or DASH manifest/, 'HTML instead of manifest explained');
  overrides = { '/hls/hi_0.ts': (q, s) => { s.writeHead(200); s.end('<html>error page</html>'); } };
  await rejects(getErr(`${B}/hls/hi.m3u8`), 'BAD_SEGMENT', /not media/, 'HTML error page as first segment is not saved as video');
  overrides = { '/hls/hi_2.ts': (q, s) => { s.writeHead(200); s.end('<html>denied</html>'); } };
  await rejects(getErr(`${B}/hls/hi.m3u8`), 'BAD_SEGMENT', /segment 3.*not media/, 'HTML error page in a later segment is detected');
  let hits = 0;
  overrides = { '/hls/hi_1.ts': (q, s) => { if (hits++ < 1) { s.writeHead(500); return s.end(); } s.writeHead(200); s.end(fx('hls/hi_1.ts')); } };
  r = await getErr(`${B}/hls/hi.m3u8`);
  ok(hits === 2 && r.files[0].blob.size === expectHi.length, 'transient HTTP 500 is retried and succeeds');
  overrides = { '/hls/hi_1.ts': (q, s) => { s.writeHead(500); s.end(); } };
  await rejects(getErr(`${B}/hls/hi.m3u8`), 'HTTP', /HTTP 500/, 'persistent 500 fails clearly after retries');
  overrides = {};
  await rejects(getErr('http://127.0.0.1:1/x.m3u8'), 'NETWORK', /network error/, 'unreachable server reported');
  const ac = new AbortController();
  overrides = { '/hls/hi_1.ts': () => { ac.abort(); } }; // never answers
  await rejects(getErr(`${B}/hls/hi.m3u8`, { signal: ac.signal }), 'ABORTED', /canceled/, 'cancel aborts the download');
  overrides = {};

  console.log('files / packaging');
  const mf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
  ok(mf.host_permissions.includes('https://*/*') && fs.existsSync(path.join(__dirname, '..', 'downloader/downloader.html')), 'manifest has host_permissions; downloader page exists');
  for (const f of ['popup/popup.html', 'downloader/downloader.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const srcs = [...html.matchAll(/<script src="([^"]+)"/g)].map((x) => x[1]);
    ok(srcs.length >= 2 && srcs.every((s) => fs.existsSync(path.join(__dirname, '..', path.dirname(f), s))), `${f}: all script files exist`);
  }

  server.close();
  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('\nFAILED:', e.stack || e.message); server.close(); process.exit(1); });
