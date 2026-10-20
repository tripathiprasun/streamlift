// Optional developer check (needs Node 18+; no npm packages).
// Covers the Part 4 detection features: lib/sniff.js, inject.js (page world),
// the content-script bridge, and the background sniffer, against minimal fake browser APIs.
// Blob capture is tested end to end: a simulated player appends real fMP4 fixtures to
// fake SourceBuffers, we "press Download", and (if ffprobe/ffmpeg exist) check the output plays.
// Run from the project root:  node tests/capture-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const fix = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
const S = require('../lib/sniff.js');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ok -', msg); };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const hasFfprobe = spawnSync('ffprobe', ['-version']).status === 0;
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-'));
function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim().split(/\s+/).sort().join(',') : null;
}

// ============================================================ lib/sniff.js ====
function testSniff() {
  console.log('sniff: content and mime');
  ok(S.sniffManifestText('#EXTM3U\n#EXT-X-VERSION:3') === 'hls', 'HLS playlist recognised by its first line');
  ok(S.sniffManifestText('\uFEFF  #EXTM3U') === 'hls', 'HLS with BOM/whitespace recognised');
  ok(S.sniffManifestText('<?xml version="1.0"?><MPD type="static"></MPD>') === 'dash', 'DASH manifest recognised');
  ok(S.sniffManifestText('<ns:MPD xmlns:ns="x">') === 'dash', 'DASH with namespace prefix recognised');
  ok(S.sniffManifestText('{"video_dash_manifest":"<MPD type=\\"static\\"></MPD>"}') === null, 'JSON that merely contains a DASH manifest string is NOT itself a manifest');
  ok(S.sniffManifestText('<!-- generated --><?xml version="1.0"?><MPD></MPD>') === 'dash', 'DASH after an XML comment is still recognised');
  ok(S.sniffManifestText('<html><body>#EXTM3U</body></html>') === null && S.sniffManifestText('{"a":1}') === null, 'HTML / JSON are not manifests');
  ok(S.classifyMime('application/vnd.apple.mpegurl') === 'hls' && S.classifyMime('application/x-mpegURL; charset=utf-8') === 'hls', 'HLS mime types');
  ok(S.classifyMime('application/dash+xml') === 'dash', 'DASH mime type');
  ok(S.classifyMime('video/mp2t') === 'segment' && S.classifyMime('video/iso.segment') === 'segment', 'segment mime types');
  ok(S.classifyMime('video/mp4') === 'video' && S.classifyMime('audio/mpeg') === 'audio' && S.classifyMime('text/html') === null, 'video/audio/other mime types');

  console.log('sniff: URL helpers');
  const sp = S.stripRangeParams('https://v.fbcdn.net/a.mp4?x=1&bytestart=0&byteend=999#t');
  ok(sp.stripped && sp.url === 'https://v.fbcdn.net/a.mp4?x=1', 'bytestart/byteend are stripped (and the #hash)');
  ok(S.stripRangeParams('https://e.com/v?range=0-1023').url === 'https://e.com/v' && S.stripRangeParams('https://e.com/v?range=0-1023').stripped, 'range=a-b is stripped');
  ok(!S.stripRangeParams('https://e.com/v?range=high').stripped, 'a non-numeric range parameter is left alone');
  ok(S.patternKey('https://c.com/seg/chunk-0001.m4s') === S.patternKey('https://c.com/seg/chunk-0002.m4s'), 'short counters share a pattern key');
  ok(S.patternKey('https://c.com/v/123456789012_n.mp4') !== S.patternKey('https://c.com/v/987654321098_n.mp4'), 'long IDs (different videos) do not share a pattern key');
  ok(S.patternKey('https://c.com/a/seg1.ts') === S.patternKey('https://c.com/a/seg22.ts'), 'seg1 / seg22 share a pattern key');

  console.log('sniff: judging network responses');
  const J = (o) => S.judgeResponse({ status: 200, type: 'xmlhttprequest', ...o });
  ok(J({ url: 'https://c.com/api/play?id=1', mime: 'application/vnd.apple.mpegurl' }).kindHint === 'hls', 'extensionless HLS manifest found by content-type');
  ok(J({ url: 'https://c.com/m?id=1', mime: 'application/dash+xml' }).kindHint === 'dash', 'extensionless DASH manifest found by content-type');
  ok(J({ url: 'https://c.com/x/index.m3u8', mime: 'text/plain' }).kindHint === 'hls', '.m3u8 served as text/plain still accepted');
  ok(!J({ url: 'https://c.com/x/index.m3u8', mime: 'text/html' }).ok, '.m3u8 that returns HTML is rejected');
  ok(J({ url: 'https://c.com/get?id=7', mime: 'video/mp4', length: 5e6 }).ok, 'big extensionless video/mp4 accepted');
  ok(!J({ url: 'https://c.com/get?id=7', mime: 'video/mp4', length: 80000 }).ok, 'small fetch/XHR video (probably a segment) rejected');
  ok(J({ url: 'https://c.com/tiny.mp4', mime: 'video/mp4', length: 80000, type: 'media' }).ok, 'small file requested by a real <video> accepted');
  ok(!J({ url: 'https://c.com/a/seg-1.ts', mime: 'video/mp2t', length: 9e6 }).ok && !J({ url: 'https://c.com/a/init.m4s', mime: 'video/mp4', length: 9e6 }).ok, 'TS and .m4s segments rejected regardless of size');
  ok(!J({ url: 'https://c.com/p.mp4', mime: 'text/html', length: 9e6 }).ok, 'an .mp4 URL that returns HTML is rejected');
  ok(J({ url: 'https://c.com/p.mp4', mime: 'application/octet-stream', length: 9e6 }).ok, '.mp4 served as octet-stream accepted');
  ok(!J({ url: 'https://c.com/p.mp4', mime: 'video/mp4', length: 9e6, status: 404 }).ok, 'non-200/206 rejected');
  const ranged = J({ url: 'https://c.com/get?id=7', mime: 'video/mp4', length: 1024, range: 'bytes 0-1023/7340032' });
  ok(ranged.ok, 'a 206 range probe uses the TOTAL size from Content-Range');
  const split = J({ url: 'https://v.fbcdn.net/o/v.mp4?bytestart=0&byteend=900000&x=1', mime: 'video/mp4', length: 900001 });
  ok(split.ok && split.url === 'https://v.fbcdn.net/o/v.mp4?x=1' && /one track/i.test(split.note), 'byte-range URL is normalised to the whole track and flagged as one track');
  ok(J({ url: 'https://c.com/a?id=3', mime: 'audio/mpeg', length: 5e6 }).media === 'audio', 'audio mime is marked as audio');

  console.log('sniff: JSON payloads');
  ok(S.parseJsonLoose('for (;;);{"a":1}')[0].a === 1 && S.parseJsonLoose(")]}'\n{\"a\":2}")[0].a === 2, 'Facebook / Google JSON prefixes are removed');
  ok(S.parseJsonLoose('{"a":1}\n{"b":2}\nnot json').length === 2, 'one-JSON-per-line payloads are parsed');
  ok(S.mightHaveMedia('{"x":"https://a/b.mp4"}') && !S.mightHaveMedia('{"x":"hello"}'), 'cheap pre-filter');

  const ig = { items: [{ video_versions: [
    { type: 101, width: 720, height: 1280, url: 'https://scontent.cdninstagram.com/v/t50/abc.mp4?efg=x&oh=1' },
    { type: 102, width: 480, height: 852, url: 'https://scontent.cdninstagram.com/v/t50/def.mp4?x=1' }],
  image_versions2: { candidates: [{ url: 'https://scontent.cdninstagram.com/v/t51/thumb.jpg' }] },
  video_dash_manifest: '<?xml version="1.0"?><MPD type="static"><Period><AdaptationSet contentType="video"><Representation bandwidth="1" codecs="avc1.4d401f" height="1280" mimeType="video/mp4"><BaseURL>https://scontent.cdninstagram.com/v/t50/vid.mp4?a=1&amp;b=2</BaseURL></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation bandwidth="2" codecs="mp4a.40.2" mimeType="audio/mp4"><BaseURL>https://scontent.cdninstagram.com/v/t50/aud.mp4?a=1&amp;b=3</BaseURL></Representation></AdaptationSet></Period></MPD>' }] };
  const igUrls = S.findMedia(ig).map((m) => m.url);
  ok(igUrls.includes('https://scontent.cdninstagram.com/v/t50/abc.mp4?efg=x&oh=1') && igUrls.includes('https://scontent.cdninstagram.com/v/t50/def.mp4?x=1'), 'Instagram-style video_versions found');
  const pair = S.findMedia(ig).find((m) => m.audioUrl);
  ok(pair && pair.url === 'https://scontent.cdninstagram.com/v/t50/vid.mp4?a=1&b=2' && pair.audioUrl === 'https://scontent.cdninstagram.com/v/t50/aud.mp4?a=1&b=3', 'DASH XML embedded in JSON becomes ONE video+audio pair (&amp; decoded)');
  ok(/Video \+ audio 1280p/.test(pair.note) && !igUrls.includes('https://scontent.cdninstagram.com/v/t50/aud.mp4?a=1&b=3'), 'the pair is labelled with its quality and the audio is not also listed on its own');
  const two = '<MPD><Period><AdaptationSet contentType="video"><Representation bandwidth="100" height="360" mimeType="video/mp4"><BaseURL>https://c.com/v360.mp4</BaseURL></Representation><Representation bandwidth="900" height="720" mimeType="video/mp4"><BaseURL>https://c.com/v720.mp4</BaseURL></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation bandwidth="48" mimeType="audio/mp4"><BaseURL>https://c.com/a48.mp4</BaseURL></Representation><Representation bandwidth="128" mimeType="audio/mp4"><BaseURL>https://c.com/a128.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>';
  const best = S.findMedia({ video_dash_manifest: two });
  ok(best.length === 1 && best[0].url === 'https://c.com/v720.mp4' && best[0].audioUrl === 'https://c.com/a128.mp4', 'the pair uses the best video and the best audio');
  const vOnly = S.findMedia({ video_dash_manifest: two.replace(/<AdaptationSet contentType="audio">[\s\S]*?<\/AdaptationSet>/, '') });
  ok(vOnly.length === 2 && vOnly.every((m) => !m.audioUrl && /Video only/.test(m.note)), 'a manifest with no audio keeps listing the video tracks (marked video only)');
  ok(!igUrls.some((u) => /thumb\.jpg/.test(u)), 'image URLs are never reported');
  const fb = S.parseJsonLoose('for (;;);{"payload":{"playable_url":"https://video.xx.fbcdn.net/v/a.mp4?_nc=1","playable_url_quality_hd":"https://video.xx.fbcdn.net/v/b.mp4?_nc=2"}}')[0];
  ok(S.findMedia(fb).length === 2, 'Facebook-style playable_url / playable_url_quality_hd found');
  const tw = { media: [{ video_info: { variants: [
    { content_type: 'application/x-mpegURL', url: 'https://video.twimg.com/ext/pl/x.m3u8?tag=12' },
    { bitrate: 832000, content_type: 'video/mp4', url: 'https://video.twimg.com/ext/vid/480x270/a.mp4?tag=12' }] },
  media_url_https: 'https://pbs.twimg.com/thumb/a.jpg' }] };
  const twm = S.findMedia(tw);
  ok(twm.length === 2 && twm.some((m) => m.kind === 'hls') && twm.some((m) => /a\.mp4/.test(m.url)), 'X/Twitter-style variants[] (HLS + MP4) found, thumbnail ignored');
  const tt = { video: { playAddr: 'https://v16.tiktok.com/abc/video/tos/xyz/?a=1&mime_type=video_mp4', cover: 'https://p16.tiktokcdn.com/c.jpeg' } };
  ok(S.findMedia(tt).length === 1, 'TikTok-style playAddr (no file extension) found, cover ignored');
  const rd = S.findMedia({ reddit_video: { fallback_url: 'https://v.redd.it/x/DASH_720.mp4?source=fallback', hls_url: 'https://v.redd.it/x/HLSPlaylist.m3u8?a=1' } });
  ok(rd.length === 2 && rd.find((m) => /m3u8/.test(m.url)).kind === 'hls', 'Reddit-style fallback_url + hls_url found');
  ok(S.findMedia({ avatar: 'https://x.com/a.png', next: 'https://x.com/api?page=2', video_url: 'https://x.com/img/poster.jpg', link: 'https://x.com/watch/1' }).length === 0, 'ordinary links and posters produce nothing');
  const deep = {}; let n = deep; for (let i = 0; i < 40; i++) { n.a = {}; n = n.a; } n.video_url = 'https://e.com/deep.mp4';
  ok(S.findMedia(deep).length === 0, 'absurdly deep JSON is cut off safely');
  ok(S.findMedia(JSON.parse(JSON.stringify({ l: Array.from({ length: 200 }, (_, i) => ({ video_url: `https://e.com/${i}.mp4` })) }))).length === 40, 'result count is capped');

  console.log('sniff: bytes and ranges');
  const init = fix('dash/init-stream0.m4s'), chunk = fix('dash/chunk-stream0-00001.m4s');
  ok(S.isInitSegment(init) && !S.isInitSegment(chunk), 'init segment (ftyp/moov) vs media segment (moof)');
  ok(S.isInitSegment(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])), 'WebM EBML header is an init segment');
  ok(S.fingerprint(chunk) === S.fingerprint(Buffer.from(chunk)) && S.fingerprint(chunk) !== S.fingerprint(fix('dash/chunk-stream0-00002.m4s')), 'fingerprint: equal bytes equal, different segments differ');
  ok(S.roleOfMime('audio/mp4; codecs="mp4a.40.2"') === 'audio' && S.roleOfMime('video/mp4; codecs="avc1.64001e"') === 'video' && S.roleOfMime('video/mp4; codecs="avc1.64001e, mp4a.40.2"') === 'media', 'role from mime (audio / video / muxed)');
  let r = S.addRange([], 0, 2); r = S.addRange(r, 2, 4); r = S.addRange(r, 10, 12); r = S.addRange(r, 3, 11);
  ok(JSON.stringify(r) === '[[0,12]]' && S.rangeTotal(r) === 12, 'buffered ranges merge');
  ok(S.rangeTotal(S.addRange(S.addRange([], 0, 2), 5, 6)) === 3, 'gaps stay gaps');
}

// ======================================================== page world (inject.js) ====
function loadInject(opts = {}) {
  const posted = [], timers = [], anchors = [], blobs = new Map(), docL = {}, clock = { t: 1e6 };
  let nextBlob = 1;
  class FakeURL extends URL {
    static createObjectURL(o) { const u = 'blob:https://example.com/' + nextBlob++; blobs.set(u, o); return u; }
    static revokeObjectURL() {}
  }
  class SourceBuffer {
    constructor(mime) { this.mime = mime; this.l = {}; this.ranges = []; }
    appendBuffer(d) { (this.appended = this.appended || []).push(d); }
    addEventListener(t, f) { this.l[t] = f; }
    get buffered() { const r = this.ranges; return { length: r.length, start: (i) => r[i][0], end: (i) => r[i][1] }; }
  }
  class MediaSource { constructor() { this.duration = NaN; this.readyState = 'open'; } addSourceBuffer(mime) { return new SourceBuffer(mime); } }
  class HTMLMediaElement { setMediaKeys() { return 'set'; } }
  class XMLHttpRequest {
    constructor() { this._l = {}; this.status = 0; this.responseType = ''; this.responseText = ''; this.response = null; this.responseURL = ''; this.h = {}; }
    open(m, u) { this.u = u; }
    send() {}
    addEventListener(t, f) { this._l[t] = f; }
    getResponseHeader(n) { return n.toLowerCase() in this.h ? this.h[n.toLowerCase()] : null; }
  }
  const sb = {
    Blob, TextDecoder, Uint8Array, ArrayBuffer, Promise, Set, Map, WeakMap, WeakSet, Number, String, Object, Array, JSON, Math, console,
    URL: FakeURL, MediaSource, SourceBuffer, HTMLMediaElement, XMLHttpRequest,
    // opts.auto: timers fire at once and move a virtual clock, so a 15 minute timeout takes no time
    setTimeout: (f, ms) => { if (opts.auto) { clock.t += ms || 0; Promise.resolve().then(f); return 0; } timers.push({ f, ms }); return timers.length; },
    Date: opts.auto ? { now: () => clock.t } : Date,
    TextEncoder,
    location: { href: 'https://example.com/watch?v=1' },
    postMessage: (m) => posted.push(m),
    addEventListener: (t, f) => { sb.listeners[t] = f; }, listeners: {},
    document: {
      createElement: () => { const a = { style: {}, click() { anchors.push({ download: a.download, href: a.href }); }, remove() {} }; return a; },
      body: { appendChild() {} }, documentElement: { appendChild() {} }, querySelectorAll: () => opts.elements || [],
      addEventListener: (t, f) => { docL[t] = f; },
    },
    fetch: (u) => Promise.resolve(sb.nextResponse(u)),
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(read('lib/sniff.js'), sb);
  vm.runInContext(read('lib/mux.js'), sb);
  vm.runInContext(read('lib/webm.js'), sb);
  const origFetch = sb.fetch, origOpen = XMLHttpRequest.prototype.open, origAppend = SourceBuffer.prototype.appendBuffer;
  vm.runInContext(read('inject.js'), sb);
  const self = vm.runInContext('globalThis', sb); // what event.source is in a real page
  const msg = (data) => sb.listeners.message({ source: self, data });
  const runTimers = () => { const t = timers.splice(0); t.forEach((x) => x.f()); };
  const bytesOf = async (blob) => Buffer.from(await blob.arrayBuffer());
  return { sb, posted, anchors, blobs, docL, clock, msg, runTimers, bytesOf, MediaSource, SourceBuffer, XMLHttpRequest, FakeURL, origFetch, origOpen, origAppend };
}

async function testInjectNetwork() {
  console.log('page world: global hygiene');
  const p = loadInject();
  ok(p.sb.SVDSniff === undefined && p.sb.SVDMux === undefined && p.sb.SVDWebm === undefined && p.sb.__svd_injected === true, 'no SVDSniff / SVDMux / SVDWebm global is left behind; double-injection guard set');
  vm.runInContext(read('inject.js'), p.sb);
  ok(p.sb.fetch !== p.origFetch, 'fetch is wrapped');

  console.log('page world: fetch');
  const res = (url, ct, body, len) => ({
    url, headers: { get: (n) => ({ 'content-type': ct, 'content-length': len === undefined ? String(body.length) : len }[n.toLowerCase()] ?? null) },
    reads: 0, clone() { return this; }, text: async function () { this.reads++; return body; },
  });
  const found = () => p.posted.filter((m) => m.type === 'found');
  let r0 = res('https://api.example.com/graphql', 'application/json', 'for (;;);' + JSON.stringify({ d: { playable_url: 'https://video.fbcdn.net/v/a.mp4?_nc=1' } }));
  p.sb.nextResponse = () => r0;
  const got = await p.sb.fetch('https://api.example.com/graphql');
  await tick();
  ok(got === r0, 'the page receives the original response object untouched');
  ok(found().length === 1 && found()[0].url === 'https://video.fbcdn.net/v/a.mp4?_nc=1', 'video URL inside an API JSON response is reported');

  const igBody = JSON.stringify({ items: [{ video_dash_manifest: '<MPD><Period><AdaptationSet contentType="video"><Representation bandwidth="9" height="1280" mimeType="video/mp4"><BaseURL>https://scontent.cdninstagram.com/v.mp4?a=1&amp;b=2</BaseURL></Representation></AdaptationSet><AdaptationSet contentType="audio"><Representation bandwidth="3" mimeType="audio/mp4"><BaseURL>https://scontent.cdninstagram.com/a.mp4?a=1&amp;b=3</BaseURL></Representation></AdaptationSet></Period></MPD>' }] });
  p.sb.nextResponse = () => res('https://www.instagram.com/api/graphql', 'application/json', igBody);
  await p.sb.fetch('https://www.instagram.com/api/graphql'); await tick();
  const pairMsg = found().find((m) => m.audioUrl);
  ok(pairMsg && pairMsg.url === 'https://scontent.cdninstagram.com/v.mp4?a=1&b=2' && pairMsg.audioUrl === 'https://scontent.cdninstagram.com/a.mp4?a=1&b=3' && /Video \+ audio 1280p/.test(pairMsg.note), 'an Instagram-style API response yields a video+audio pair message');
  ok(!found().some((m) => m.url === 'https://www.instagram.com/api/graphql'), 'the API URL that merely carried the manifest is not reported as a stream');
  p.sb.nextResponse = () => res('https://cdn.example.com/play?id=3', 'text/plain', '#EXTM3U\n#EXT-X-ENDLIST\n');
  await p.sb.fetch('https://cdn.example.com/play?id=3'); await tick();
  ok(found().some((m) => m.url === 'https://cdn.example.com/play?id=3' && m.kindHint === 'hls'), 'HLS manifest with no .m3u8 in its URL found by its content');
  p.sb.nextResponse = () => res('https://cdn.example.com/m?x=1', 'application/octet-stream', '<?xml version="1.0"?><MPD type="static"></MPD>');
  await p.sb.fetch('https://cdn.example.com/m?x=1'); await tick();
  ok(found().some((m) => m.url === 'https://cdn.example.com/m?x=1' && m.kindHint === 'dash'), 'DASH manifest served as octet-stream found by its content');
  p.sb.nextResponse = () => res('https://cdn.example.com/x.m3u8', 'application/vnd.apple.mpegurl', '', '0');
  const before = found().length;
  await p.sb.fetch('https://cdn.example.com/x.m3u8'); await tick();
  ok(found().length === before + 1 && found().at(-1).kindHint === 'hls', 'manifest recognised from content-type alone (body not read)');

  const bodies = [
    res('https://cdn.example.com/big', 'application/octet-stream', 'x', String(50e6)),
    res('https://cdn.example.com/unk', 'application/octet-stream', 'x', null),
    res('https://cdn.example.com/events', 'text/event-stream', 'x', null),
    res('https://cdn.example.com/page', 'text/html', '<html>', '6'),
    res('https://cdn.example.com/huge.json', 'application/json', '{}', String(50e6)),
    res('https://cdn.example.com/img', 'image/png', 'x', '1'),
  ];
  for (const b of bodies) { p.sb.nextResponse = () => b; await p.sb.fetch(b.url); }
  await tick();
  ok(bodies.every((b) => b.reads === 0), 'large/unknown-size binaries, event streams, HTML, images and huge JSON are never read');
  p.sb.nextResponse = () => res('https://api.example.com/plain', 'application/json', JSON.stringify({ a: 'hello', img: 'https://e.com/a.png' }));
  const n0 = found().length;
  await p.sb.fetch('https://api.example.com/plain'); await tick();
  ok(found().length === n0, 'JSON without media reports nothing');
  p.sb.nextResponse = () => { throw new Error('boom'); };
  let threw = false; try { await p.sb.fetch('x'); } catch (e) { threw = e.message === 'boom'; }
  ok(threw, 'errors from the real fetch pass through unchanged');
  p.sb.nextResponse = () => Promise.reject(new Error('net'));
  let rejected = false; try { await p.sb.fetch('x'); } catch (e) { rejected = e.message === 'net'; }
  ok(rejected, 'a failed request still rejects for the page (and is not swallowed)');

  console.log('page world: XMLHttpRequest');
  const xhr = (url, ct, set) => { const x = new p.sb.XMLHttpRequest(); x.open('GET', url); x.send(); x.status = 200; x.responseURL = url; x.h['content-type'] = ct; set(x); x._l.loadend(); return x; };
  xhr('https://api.example.com/x1', 'application/json', (x) => { x.responseText = JSON.stringify({ video_url: 'https://e.com/x1.mp4' }); });
  xhr('https://api.example.com/x2', 'application/json', (x) => { x.responseType = 'json'; x.response = { sources: [{ src: 'https://e.com/x2.mp4' }] }; });
  xhr('https://cdn.example.com/x3', 'application/octet-stream', (x) => { x.responseType = 'arraybuffer'; x.response = new TextEncoder().encode('#EXTM3U\n#EXT-X-ENDLIST').buffer; });
  xhr('https://cdn.example.com/x4', 'application/vnd.apple.mpegurl', () => {});
  xhr('https://api.example.com/x5', 'application/json', (x) => { x.status = 404; x.responseText = JSON.stringify({ video_url: 'https://e.com/x5.mp4' }); });
  const urls = found().map((m) => m.url);
  ok(urls.includes('https://e.com/x1.mp4') && urls.includes('https://e.com/x2.mp4'), 'XHR text and json responses are inspected');
  ok(found().some((m) => m.url === 'https://cdn.example.com/x3' && m.kindHint === 'hls') && found().some((m) => m.url === 'https://cdn.example.com/x4'), 'XHR manifests found (arraybuffer body, content-type)');
  ok(!urls.includes('https://e.com/x5.mp4'), 'failed XHR responses are ignored');
  const dup = found().length;
  xhr('https://api.example.com/x1', 'application/json', (x) => { x.responseText = JSON.stringify({ video_url: 'https://e.com/x1.mp4' }); });
  ok(found().length === dup, 'the same URL is reported once');
  p.msg({ svd: 1, type: 'rescan' });
  xhr('https://api.example.com/x1', 'application/json', (x) => { x.responseText = JSON.stringify({ video_url: 'https://e.com/x1.mp4' }); });
  ok(found().length === dup + 1, 'rescan makes the page world report again');
  p.sb.listeners.message({ source: {}, data: { svd: 1, type: 'rescan' } });
  p.msg('junk');
  ok(true, 'messages from other windows / junk are ignored without errors');
}

// ---- helpers for the capture tests ----
const DV = ['init-stream0.m4s', 'chunk-stream0-00001.m4s', 'chunk-stream0-00002.m4s', 'chunk-stream0-00003.m4s'].map((f) => fix('dash/' + f));
const DA = ['init-stream1.m4s', 'chunk-stream1-00001.m4s', 'chunk-stream1-00002.m4s', 'chunk-stream1-00003.m4s'].map((f) => fix('dash/' + f));
const md5of = (file, map) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', map, '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
const decodesOk = (file) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }); return r.status === 0 && r.stderr.trim() === ''; };

// A page with a MediaSource, a video + audio SourceBuffer and a <video> element.
function makePlayer(opts = {}) {
  const p = loadInject({ auto: true, elements: [] });
  const ms = new p.MediaSource(); ms.duration = opts.duration === undefined ? 6 : opts.duration;
  const url = p.sb.URL.createObjectURL(ms);
  const vsb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001e"'), asb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  const have = new Set();
  const ranges = [];
  const loadSeg = (k) => {            // the "player" fetches segment k (0..2): 2 seconds each
    if (k < 0 || k > 2 || have.has(k)) return;
    have.add(k);
    vsb.appendBuffer(DV[k + 1]); asb.appendBuffer(DA[k + 1]);
    ranges.push([k * 2, k * 2 + 2]);
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const r of ranges) { if (merged.length && merged[merged.length - 1][1] >= r[0] - 0.01) merged[merged.length - 1][1] = r[1]; else merged.push([...r]); }
    vsb.ranges = merged.map((r) => [...r]); asb.ranges = merged.map((r) => [...r]);
    vsb.l.updateend(); asb.l.updateend();
  };
  vsb.appendBuffer(DV[0]); asb.appendBuffer(DA[0]);
  let ct = opts.start === undefined ? 1 : opts.start;
  const start = ct;
  const el = { currentSrc: url, src: url, paused: true, muted: false, playbackRate: 1, loop: true, plays: 0, pauses: 0, seeks: [],
    // the fake player "plays": it loads the segment at the playhead and moves on by itself (not counted as a seek)
    play() { this.plays++; if (opts.stuck) return Promise.resolve(); const k = Math.floor(ct / 2); loadSeg(k); ct = Math.min(5.99, (k + 1) * 2); if (opts.onPlay) opts.onPlay(this, p); return Promise.resolve(); },
    pause() { this.pauses++; },
    get currentTime() { return ct; }, set currentTime(v) { this.seeks.push(v); ct = v; } };
  p.sb.document.querySelectorAll = () => (opts.noElement ? [] : [el]);
  return { p, ms, el, loadSeg, vsb, asb, start };
}
const lastCap = (p) => p.posted.filter((m) => m.type === 'capture').at(-1).capture;
const reply = (p, reqId) => p.posted.find((m) => m.type === 'download-result' && m.reqId === reqId);
const download = async (p, id, reqId, mode, name = 'Reel') => { p.msg({ svd: 1, type: 'capture-download', id, name, mode, reqId }); await tick(10); };

async function testCapture() {
  console.log('page world: blob capture (MediaSource) with real fMP4, audio + video merged into one file');
  const p = loadInject();
  const ms = new p.MediaSource();
  const url = p.sb.URL.createObjectURL(ms);
  const vsb = ms.addSourceBuffer('video/mp4; codecs="avc1.64001e"');
  const asb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  ok(vsb.appendBuffer !== p.origAppend && typeof vsb.appendBuffer === 'function', 'SourceBuffer.appendBuffer is wrapped');
  const V = DV, A = DA;
  // The player hands us views over a shared, reused buffer: capture must copy.
  const scratch = new Uint8Array(100000);
  const feed = (sb, buf, range) => { scratch.set(buf); sb.appendBuffer(scratch.subarray(0, buf.length)); scratch.fill(0); if (range) { sb.ranges = [range]; sb.l.updateend(); } };
  ms.duration = 6;
  feed(vsb, V[0]); feed(asb, A[0]);
  feed(vsb, V[1], [0, 2]); feed(asb, A[1], [0, 2]);
  feed(vsb, V[2], [0, 4]); feed(asb, A[2], [0, 4]);
  feed(vsb, V[1], [0, 4]);          // seek back: same segment again
  feed(vsb, V[0]);                  // player re-appends the init segment after a seek
  feed(vsb, V[3], [0, 6]); feed(asb, A[3], [0, 6]);
  p.runTimers();
  const cap = lastCap(p);
  ok(cap && cap.tracks.length === 2 && cap.tracks[0].role === 'video' && cap.tracks[1].role === 'audio', 'capture reports a video and an audio track');
  ok(cap.duration === 6 && cap.tracks[0].covered === 6 && cap.tracks[1].covered === 6, 'player duration and captured coverage (6 of 6 s) are reported');
  ok(cap.tracks[0].bytes === V.reduce((n, b) => n + b.length, 0), 're-appended segment/init were de-duplicated (byte count equals unique data)');
  ok(!cap.protected && !cap.truncated && !cap.whole && cap.job === null, 'not marked protected / truncated / whole; no job running');

  await download(p, cap.id, 9, 'complete', 'My Reel');
  const result = reply(p, 9);
  ok(result && result.ok && !result.started && result.merged === true && result.files.length === 1 && !result.partial, 'a complete capture is saved at once as ONE merged file');
  p.runTimers();
  ok(p.anchors.length === 1 && p.anchors[0].download === 'My Reel.mp4', 'one file: My Reel.mp4');
  const merged = await p.bytesOf(p.blobs.get(p.anchors[0].href));
  fs.writeFileSync(path.join(tmp, 'cap.merged.mp4'), merged);
  if (hasFfprobe) ok(probe(path.join(tmp, 'cap.merged.mp4')) === 'audio,video', 'ffprobe: the captured file has an audio and a video stream');
  if (hasFfmpeg) {
    ok(decodesOk(path.join(tmp, 'cap.merged.mp4')), 'ffmpeg decodes the merged capture with zero errors');
    // reference: the same fixtures merged straight from the DASH segments
    fs.writeFileSync(path.join(tmp, 'ref.v.mp4'), Buffer.concat(V)); fs.writeFileSync(path.join(tmp, 'ref.a.m4a'), Buffer.concat(A));
    const mergedRef = await require('../lib/mux.js').mergeMp4(new Blob([Buffer.concat(V)]), new Blob([Buffer.concat(A)]));
    fs.writeFileSync(path.join(tmp, 'ref.merged.mp4'), Buffer.from(await mergedRef.arrayBuffer()));
    ok(md5of(path.join(tmp, 'cap.merged.mp4'), '0:v:0') === md5of(path.join(tmp, 'ref.merged.mp4'), '0:v:0') && md5of(path.join(tmp, 'cap.merged.mp4'), '0:a:0') === md5of(path.join(tmp, 'ref.merged.mp4'), '0:a:0'), 'decoded frames and samples equal the original streams (re-appended segments did not leak in)');
  }

  console.log('page world: segments appended out of order (a player that was made to seek)');
  const o = loadInject();
  const mso = new o.MediaSource(); o.sb.URL.createObjectURL(mso); mso.duration = 6;
  const ov = mso.addSourceBuffer('video/mp4; codecs="avc1.64001e"'), oa = mso.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  const setR = (sb) => { sb.ranges = [[0, 2], [2, 4], [4, 6]]; sb.l.updateend(); };
  for (const sb of [ov, oa]) sb.appendBuffer((sb === ov ? V : A)[0]);
  for (const k of [3, 1, 2]) { ov.appendBuffer(V[k]); oa.appendBuffer(A[k]); }   // segment order 3,1,2
  setR(ov); setR(oa); o.runTimers();
  await download(o, lastCap(o).id, 1, 'complete', 'Shuf'); o.runTimers();
  ok(o.anchors.length === 1 && o.anchors[0].download === 'Shuf.mp4', 'out-of-order capture still gives one merged file');
  if (hasFfmpeg) {
    fs.writeFileSync(path.join(tmp, 'shuf.mp4'), await o.bytesOf(o.blobs.get(o.anchors[0].href)));
    ok(decodesOk(path.join(tmp, 'shuf.mp4')) && md5of(path.join(tmp, 'shuf.mp4'), '0:v:0') === md5of(path.join(tmp, 'ref.merged.mp4'), '0:v:0') && md5of(path.join(tmp, 'shuf.mp4'), '0:a:0') === md5of(path.join(tmp, 'ref.merged.mp4'), '0:a:0'), 'fragments were put back in time order: output equals the in-order result');
  }

  console.log('page world: no playback needed (the extension loads the rest itself)');
  let g1 = makePlayer();
  ok(g1.el.paused && g1.el.muted === false && g1.el.playbackRate === 1 && g1.el.loop === true, 'sanity: the video is paused at 0:01, unmuted, normal speed, looping');
  g1.loadSeg(0); g1.p.runTimers(); g1.p.posted.length = 0; g1.p.runTimers();
  await download(g1.p, 1, 20, 'complete', 'Reel');
  ok(reply(g1.p, 20) && reply(g1.p, 20).ok && reply(g1.p, 20).started === true, 'Download on an incomplete capture answers "started" (it will finish by itself)');
  await tick(30);
  const done = lastCap(g1.p);
  ok(done.job && done.job.phase === 'done' && /^Saved: Reel\.mp4/.test(done.job.message), `the job finishes by itself and reports the saved file ("${done.job.message}")`);
  ok(done.tracks[0].covered === 6 && done.tracks[1].covered === 6, 'the whole video (6 of 6 s) was loaded without anyone playing it');
  ok(g1.p.anchors.length === 1 && g1.p.anchors[0].download === 'Reel.mp4', 'one merged file was saved automatically');
  ok(g1.el.muted === false && g1.el.playbackRate === 1 && g1.el.loop === true && g1.el.currentTime === 1 && g1.el.seeks[g1.el.seeks.length - 1] === 1 && g1.el.pauses >= 1, 'the video is put back: unmuted, normal speed, looping, at 0:01, paused');
  ok(g1.el.plays >= 2 && g1.el.seeks.length === 1, 'the missing part right after the playhead is simply played through (the only seek is putting the playhead back)');

  console.log('page world: the missing parts are BEHIND the playhead (seeking is required)');
  const back = makePlayer({ start: 5 });
  back.loadSeg(2); back.p.runTimers();
  await download(back.p, 1, 40, 'complete', 'Back'); await tick(40);
  const bj = lastCap(back.p);
  ok(bj.job.phase === 'done' && bj.tracks[0].covered === 6 && back.p.anchors.length === 1, 'a viewer near the end of the video still gets the whole video: the missing start is loaded by seeking back');
  ok(back.el.seeks[0] < 1 && back.el.seeks[back.el.seeks.length - 1] === 5 && back.el.currentTime === 5, 'it seeked back to the start, then returned the playhead to where the viewer was (0:05)');
  if (hasFfmpeg) {
    fs.writeFileSync(path.join(tmp, 'auto.mp4'), await g1.p.bytesOf(g1.p.blobs.get(g1.p.anchors[0].href)));
    ok(decodesOk(path.join(tmp, 'auto.mp4')) && probe(path.join(tmp, 'auto.mp4')) === 'audio,video' && md5of(path.join(tmp, 'auto.mp4'), '0:v:0') === md5of(path.join(tmp, 'ref.merged.mp4'), '0:v:0'), 'the auto-completed download is the full, valid video (frames equal the original)');
  }

  console.log('page world: the player is stuck / canceled / cannot be found');
  const stuck = makePlayer({ stuck: true });
  stuck.loadSeg(0); stuck.p.runTimers();
  await download(stuck.p, 1, 21, 'complete'); await tick(60);
  const sj = lastCap(stuck.p).job;
  ok(sj && sj.phase === 'failed' && /Could not load the whole video \(33% loaded\)/.test(sj.message) && stuck.p.anchors.length === 0, 'a player that stops loading fails with a clear message and saves nothing');
  ok(stuck.el.muted === false && stuck.el.playbackRate === 1 && stuck.el.currentTime === 1, 'even after failing, the video is restored');
  await download(stuck.p, 1, 22, 'asis', 'Part');
  ok(reply(stuck.p, 22).ok && reply(stuck.p, 22).partial === true && stuck.p.anchors.length === 1, '"Save as is" after a failure saves the partial video, flagged as partial');

  let cancelHere = null;
  const can = makePlayer({ onPlay: (el, pp) => { if (el.plays === 2) pp.msg({ svd: 1, type: 'capture-cancel', id: cancelHere }); } });
  can.loadSeg(0); can.p.runTimers(); cancelHere = 1;
  await download(can.p, 1, 23, 'complete'); await tick(60);
  ok(lastCap(can.p).job.phase === 'canceled' && can.p.anchors.length === 0 && can.el.currentTime === 1 && can.el.muted === false, 'Cancel stops the job, saves nothing and restores the video');

  const noEl = makePlayer({ noElement: true });
  noEl.loadSeg(0); noEl.p.runTimers();
  await download(noEl.p, 1, 24, 'complete'); noEl.p.runTimers();
  const ne = reply(noEl.p, 24);
  ok(ne.ok && !ne.started && ne.partial === true && /video element was not found/.test(ne.note) && noEl.p.anchors.length === 1, 'without a video element it saves what it has and says the rest could not be loaded');

  const live = makePlayer({ duration: Infinity });
  live.loadSeg(0); live.p.runTimers();
  await download(live.p, 1, 25, 'complete'); live.p.runTimers();
  ok(reply(live.p, 25).ok && !reply(live.p, 25).started && /length is unknown/.test(reply(live.p, 25).note), 'a stream of unknown length (live) is saved as captured, with an explanation');

  const busy = makePlayer();
  busy.loadSeg(0); busy.p.runTimers();
  busy.p.msg({ svd: 1, type: 'capture-download', id: 1, name: 'Dup', mode: 'complete', reqId: 26 });   // both requests arrive
  busy.p.msg({ svd: 1, type: 'capture-download', id: 1, name: 'Dup', mode: 'complete', reqId: 27 });   // before the first job ends
  await tick(60);
  ok(reply(busy.p, 26).started === true && reply(busy.p, 27).ok === false && /Already loading/.test(reply(busy.p, 27).error), 'pressing Download twice does not start a second job');
  ok(busy.p.anchors.length === 1, 'and only one file is saved');

  const noInfo = loadInject({ auto: true });
  const msn = new noInfo.MediaSource(); noInfo.sb.URL.createObjectURL(msn); msn.duration = 6;
  const nv = msn.addSourceBuffer('video/mp4'); nv.appendBuffer(DV[0]); nv.appendBuffer(DV[1]);   // no updateend, so no buffered info
  await download(noInfo, 1, 28, 'complete', 'NoInfo');
  ok(reply(noInfo, 28).ok && !reply(noInfo, 28).started && noInfo.anchors.length === 1, 'when the player gives no buffered-range information, it saves what it has instead of guessing');

  console.log('page world: quality switches become separate parts');
  const q = loadInject();
  const ms2 = new q.MediaSource(); q.sb.URL.createObjectURL(ms2);
  const sb2 = ms2.addSourceBuffer('video/mp4; codecs="avc1.64001e, mp4a.40.2"');
  const lo = ['hls-fmp4/init.mp4', 'hls-fmp4/s_0.m4s', 'hls-fmp4/s_1.m4s', 'hls-fmp4/s_2.m4s'].map(fix);
  sb2.appendBuffer(lo[0]); sb2.appendBuffer(lo[1]);           // quality A
  sb2.appendBuffer(V[0]); sb2.appendBuffer(V[1]);             // switch to quality B (different init)
  sb2.appendBuffer(lo[0]); sb2.appendBuffer(lo[2]);           // back to A (init already known)
  q.runTimers();
  const cap2 = lastCap(q);
  ok(cap2.tracks[0].role === 'media' && cap2.tracks[0].parts === 2, 'two distinct init segments make two parts; muxed track has role "media"');
  await download(q, cap2.id, 1, 'asis', 'clip'); q.runTimers();
  ok(q.anchors.map((a) => a.download).join('|') === 'clip.part1.mp4|clip.part2.mp4', 'parts are saved as clip.part1.mp4 / clip.part2.mp4');
  if (hasFfprobe) {
    fs.writeFileSync(path.join(tmp, 'part1.mp4'), await q.bytesOf(q.blobs.get(q.anchors[0].href)));
    ok(probe(path.join(tmp, 'part1.mp4')) === 'audio,video', 'ffprobe: each part is a standalone valid file');
  }
  // separate video + audio tracks that each switched quality cannot be merged: saved as parts, with a reason
  const sw = loadInject();
  const mss = new sw.MediaSource(); sw.sb.URL.createObjectURL(mss);
  const swv = mss.addSourceBuffer('video/mp4; codecs="avc1.64001e"'), swa = mss.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
  swv.appendBuffer(V[0]); swv.appendBuffer(V[1]); swv.appendBuffer(lo[0]); swv.appendBuffer(lo[1]); swa.appendBuffer(A[0]); swa.appendBuffer(A[1]);
  sw.runTimers();
  await download(sw, lastCap(sw).id, 2, 'asis', 'sw'); sw.runTimers();
  ok(sw.anchors.length === 3 && /Could not merge/.test(reply(sw, 2).note), 'MP4 video that switched to an incompatible quality + audio: saved as separate parts and the reply says why it was not merged');

  console.log('page world: WebM (YouTube style) video + audio -> ONE file');
  const cutAt = (buf) => { const id = Buffer.from([0x1f, 0x43, 0xb6, 0x75]); const at = []; for (let i = buf.indexOf(id); i >= 0; i = buf.indexOf(id, i + 1)) at.push(i); return [buf.subarray(0, at[0])].concat(at.map((x, k) => buf.subarray(x, at[k + 1]))); };
  const WV = cutAt(fix('webm/v.webm')), WL = cutAt(fix('webm/v_low.webm')), WA = cutAt(fix('webm/a.webm'));
  ok(WV.length >= 5 && WA.length >= 2, 'the WebM fixtures split into an init segment and several clusters (' + WV.length + ' / ' + WA.length + ')');
  const feedAll = (sbuf, chunks) => chunks.forEach((c) => sbuf.appendBuffer(c));
  const wm = loadInject();
  const wms = new wm.MediaSource(); wm.sb.URL.createObjectURL(wms);
  feedAll(wms.addSourceBuffer('video/webm; codecs="vp9"'), WV); feedAll(wms.addSourceBuffer('audio/webm; codecs="opus"'), WA);
  wm.runTimers();
  await download(wm, lastCap(wm).id, 3, 'asis', 'yt'); wm.runTimers();
  ok(wm.anchors.length === 1 && wm.anchors[0].download === 'yt.webm' && reply(wm, 3).merged === true && !reply(wm, 3).note, 'WebM video + WebM audio are saved as ONE file, yt.webm, flagged as merged, no warning');
  if (hasFfprobe) {
    fs.writeFileSync(path.join(tmp, 'yt.webm'), await wm.bytesOf(wm.blobs.get(wm.anchors[0].href)));
    ok(probe(path.join(tmp, 'yt.webm')) === 'audio,video', 'ffprobe: the file has the video and the audio stream');
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(tmp, 'yt.webm'), '-f', 'null', '-'], { encoding: 'utf8' });
    ok(dec.status === 0 && dec.stderr.trim() === '', 'ffmpeg decodes all of it without errors');
  }
  const wq = loadInject();
  const wqs = new wq.MediaSource(); wq.sb.URL.createObjectURL(wqs);
  const wqv = wqs.addSourceBuffer('video/webm; codecs="vp9"');
  feedAll(wqv, WL.slice(0, 3)); feedAll(wqv, WV.slice(0, 1).concat(WV.slice(3)));    // low quality first, then the high-quality init and its later clusters
  feedAll(wqs.addSourceBuffer('audio/webm; codecs="opus"'), WA);
  wq.runTimers();
  ok(lastCap(wq).tracks.find((t) => t.role === 'video').parts === 2, 'the quality switch made two video parts');
  await download(wq, lastCap(wq).id, 4, 'asis', 'sw'); wq.runTimers();
  ok(wq.anchors.length === 1 && wq.anchors[0].download === 'sw.webm' && reply(wq, 4).merged === true && /changed quality/.test(reply(wq, 4).note), 'a video that switched quality + audio is STILL one file (with an explanation)');
  if (hasFfprobe) {
    fs.writeFileSync(path.join(tmp, 'sw.webm'), await wq.bytesOf(wq.blobs.get(wq.anchors[0].href)));
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-i', path.join(tmp, 'sw.webm'), '-f', 'null', '-'], { encoding: 'utf8' });
    ok(probe(path.join(tmp, 'sw.webm')) === 'audio,video' && dec.status === 0 && dec.stderr.trim() === '', 'and ffmpeg decodes that file without errors');
  }
  const mx = loadInject();
  const mxs = new mx.MediaSource(); mx.sb.URL.createObjectURL(mxs);
  feedAll(mxs.addSourceBuffer('video/mp4; codecs="avc1.64001e"'), [V[0], V[1]]); feedAll(mxs.addSourceBuffer('audio/webm; codecs="opus"'), WA);
  mx.runTimers();
  await download(mx, lastCap(mx).id, 5, 'asis', 'mx'); mx.runTimers();
  ok(mx.anchors.length === 2 && /different containers/.test(reply(mx, 5).note), 'MP4 video + WebM audio cannot share a container: two files, with the reason');

  console.log('page world: encrypted playback is refused');
  const d = loadInject();
  const ms3 = new d.MediaSource(); const u3 = d.sb.URL.createObjectURL(ms3);
  const sb3 = ms3.addSourceBuffer('video/mp4; codecs="avc1.64001e"');
  sb3.appendBuffer(V[0]); sb3.appendBuffer(V[1]);
  const el = new d.sb.HTMLMediaElement(); el.currentSrc = u3;
  ok(el.setMediaKeys({}) === 'set', 'setMediaKeys still works for the page');
  d.runTimers();
  const cap3 = lastCap(d);
  ok(cap3.protected === true, 'attaching MediaKeys marks the capture protected');
  await download(d, cap3.id, 2, 'complete'); d.runTimers();
  const refused = reply(d, 2);
  ok(refused && !refused.ok && /DRM|encrypted/i.test(refused.error) && d.anchors.length === 0, 'download is refused with an explanation and nothing is saved');
  const e2 = loadInject();
  const msE = new e2.MediaSource(); const uE = e2.sb.URL.createObjectURL(msE);
  msE.addSourceBuffer('video/mp4').appendBuffer(V[0]);
  e2.docL.encrypted({ target: { currentSrc: uE } }); e2.runTimers();
  ok(lastCap(e2).protected, 'an "encrypted" media event marks the capture protected');
  const probeOnly = loadInject();
  probeOnly.sb.URL.createObjectURL(new probeOnly.MediaSource());
  probeOnly.runTimers();
  ok(!probeOnly.posted.some((m) => m.type === 'capture'), 'a MediaSource with no data is not reported');

  console.log('page world: blob: files, unknown ids, limits');
  const w = loadInject();
  const big = Buffer.concat([...V, ...A]);
  w.sb.URL.createObjectURL(new Blob([big], { type: 'video/mp4' }));
  w.sb.URL.createObjectURL(new Blob([Buffer.alloc(1000)], { type: 'video/mp4' }));
  w.sb.URL.createObjectURL(new Blob([big], { type: 'image/png' }));
  const caps = w.posted.filter((m) => m.type === 'capture');
  ok(caps.length === 1 && caps[0].capture.whole && caps[0].capture.tracks[0].bytes === big.length, 'a complete video Blob is captured; tiny blobs and images are not');
  await download(w, caps[0].capture.id, 3, 'complete', 'whole'); w.runTimers();
  ok(w.anchors.length === 1 && w.anchors[0].download === 'whole.mp4' && (await w.bytesOf(w.blobs.get(w.anchors[0].href))).equals(big), 'a whole-file blob is saved byte for byte, immediately');
  w.sb.URL.createObjectURL(new Blob([Buffer.concat([V[0], V[1], Buffer.alloc(60000)])]));   // untyped blob that is really an MP4
  await tick(20);
  ok(w.posted.filter((m) => m.type === 'capture').length === 2, 'an untyped blob is recognised as MP4 from its first bytes, and saving the first capture did not create a phantom capture of itself');
  await download(w, 999, 4, 'complete');
  ok(/no longer available/.test(reply(w, 4).error), 'unknown capture id gives a clear error');
  for (let i = 0; i < 8; i++) w.sb.URL.createObjectURL(new Blob([Buffer.alloc(60000, i + 1)], { type: 'video/mp4' }));
  ok(w.posted.filter((m) => m.type === 'capture-gone').length >= 3, 'old captures are dropped (and reported gone) beyond the memory limit');
  const sanitize = loadInject();
  const msS = new sanitize.MediaSource(); sanitize.sb.URL.createObjectURL(msS); msS.addSourceBuffer('video/mp4').appendBuffer(V[0]);
  await download(sanitize, 1, 6, 'asis', 'a/b\\c:d*e'); sanitize.runTimers();
  ok(sanitize.anchors[0].download === 'a_b_c_d_e.mp4', 'file names from the page title are sanitised');
}

// ================================================== content script bridge ====
function loadContent(elements = []) {
  const sent = [], winL = {}, posted = [], timers = [];
  let onMsg;
  const document = { nodeType: 9, baseURI: 'https://example.com/dir/page.html', readyState: 'complete', title: 'Great Reel', hidden: false,
    querySelectorAll: () => elements, addEventListener() {} };
  const window = { addEventListener: (t, f) => { winL[t] = f; }, postMessage: (m) => posted.push(m) };
  window.top = window;
  const ctx = { document, window, chrome: { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); }, onMessage: { addListener: (f) => { onMsg = f; } } } }, URL,
    MutationObserver: class { observe() {} }, PerformanceObserver: class { observe() {} }, performance: { getEntriesByType: () => [] },
    setTimeout: (f) => { timers.push(f); return 1; }, setInterval: () => 1 };
  vm.createContext(ctx);
  vm.runInContext(read('lib/sniff.js'), ctx);   // content scripts get lib/sniff.js first (see manifest)
  vm.runInContext(read('content.js'), ctx);
  const found = () => sent.filter((m) => m.type === 'video-found').map((m) => m.video);
  return { sent, posted, found, timers, win: (data, source) => winL.message({ source: source === undefined ? window : source, data }), onMsg: (...a) => onMsg(...a) };
}
const el = (tag, attrs = {}, extra = {}) => ({ nodeType: 1, tagName: tag, parentElement: null, _a: attrs, getAttribute(n) { return n in attrs ? attrs[n] : null; }, querySelectorAll: () => [], ...extra });

async function testContent() {
  console.log('content script: static page data');
  const og = el('META', { property: 'og:video', content: 'https://cdn.example.com/v/reel.mp4' });
  const ogEmbed = el('META', { property: 'og:video:url', content: 'https://www.example.com/embed/123' });
  const ld = el('SCRIPT', { type: 'application/ld+json' }, { textContent: JSON.stringify({ '@type': 'VideoObject', contentUrl: 'https://cdn.example.com/v/ld.mp4' }) });
  const state = el('SCRIPT', { type: 'application/json' }, { textContent: JSON.stringify({ require: [{ video: { playable_url: 'https://video.fbcdn.net/v/s.mp4?x=1' } }] }) });
  const plain = el('SCRIPT', { type: 'application/json' }, { textContent: '{"hello":"world"}' });
  const bad = el('SCRIPT', { type: 'application/json' }, { textContent: '{broken mp4' });
  const c = loadContent([og, ogEmbed, ld, state, plain, bad]);
  c.onMsg({ type: 'rescan' });
  const urls = c.found().map((v) => v.url);
  ok(urls.includes('https://cdn.example.com/v/reel.mp4'), 'og:video with a media extension is reported');
  ok(!urls.some((u) => /embed\/123/.test(u)), 'og:video pointing at an embed page is not reported');
  ok(urls.includes('https://cdn.example.com/v/ld.mp4') && urls.includes('https://video.fbcdn.net/v/s.mp4?x=1'), 'JSON-LD contentUrl and JSON state-blob video URLs are reported');
  ok(new Set(urls).size === 3, 'scripts without media, and invalid JSON, are ignored');

  console.log('content script: page-world bridge');
  const b = loadContent();
  b.win({ svd: 1, type: 'found', url: 'https://cdn.example.com/play?id=3', mime: '', kindHint: 'hls', media: '', note: 'n' });
  ok(b.found().length === 1 && b.found()[0].kindHint === 'hls' && b.found()[0].source === 'page' && b.found()[0].note === 'n', 'a URL found by the page world is forwarded with its kind hint');
  b.win({ svd: 1, type: 'found', url: 'https://cdn.example.com/p.mp4', audioUrl: 'https://cdn.example.com/p.audio.mp4', note: 'pair' });
  b.win({ svd: 1, type: 'found', url: 'https://cdn.example.com/q.mp4', audioUrl: 'javascript:alert(1)' });
  const pv = b.found().find((v) => v.url.endsWith('/p.mp4')), qv = b.found().find((v) => v.url.endsWith('/q.mp4'));
  ok(pv && pv.audioUrl === 'https://cdn.example.com/p.audio.mp4' && qv && qv.audioUrl === '', 'the audio URL of a pair is forwarded; a non-http audio URL is dropped');
  b.sent.length = 0;
  b.win({ svd: 1, type: 'found', url: 'https://cdn.example.com/evil.mp4' }, {});
  b.win({ type: 'found', url: 'https://cdn.example.com/nosvd.mp4' });
  b.win({ svd: 1, type: 'found', url: 'blob:https://example.com/abc' });
  b.win({ svd: 1, type: 'found', url: 'javascript:alert(1)' });
  ok(b.found().length === 0, 'messages from other windows, without the marker, or with non-http URLs are ignored');
  b.win({ svd: 1, type: 'capture', capture: { id: 4, tracks: [] } });
  b.win({ svd: 1, type: 'capture-gone', id: 4 });
  ok(b.sent.some((m) => m.type === 'capture-update' && m.capture.id === 4 && m.title === 'Great Reel') && b.sent.some((m) => m.type === 'capture-gone' && m.id === 4), 'capture updates / removals are forwarded with the page title');

  let answered = null;
  const keep = b.onMsg({ type: 'capture-download', id: 4, name: 'x' }, {}, (r) => { answered = r; });
  const req = b.posted.find((m) => m.type === 'capture-download');
  ok(keep === true && req && req.id === 4 && req.name === 'x' && Number.isInteger(req.reqId), 'popup download request is relayed to the page world (async reply)');
  b.win({ svd: 1, type: 'download-result', reqId: req.reqId, ok: true, files: [{ name: 'x.mp4', bytes: 5 }] });
  ok(answered && answered.ok && answered.files[0].name === 'x.mp4', 'the page world answer goes back to the popup');
  let started = null;
  b.onMsg({ type: 'capture-download', id: 4, name: 'z' }, {}, (r) => { started = r; });
  const req2 = b.posted.filter((m) => m.type === 'capture-download').at(-1);
  b.win({ svd: 1, type: 'download-result', reqId: req2.reqId, ok: true, started: true, merged: true, partial: true, note: 'n' });
  ok(started && started.started === true && started.merged === true && started.partial === true && started.note === 'n', 'started / merged / partial / note reach the popup too (they used to be dropped)');
  let late = null;
  b.onMsg({ type: 'capture-download', id: 5, name: 'y' }, {}, (r) => { late = r; });
  b.timers.at(-1)();
  ok(late && !late.ok && /did not answer/.test(late.error), 'no answer from the page gives an error instead of hanging');
  b.onMsg({ type: 'rescan' });
  ok(b.posted.some((m) => m.type === 'rescan'), 'Refresh also asks the page world to report again');
  b.onMsg({ type: 'capture-download', id: 4, name: 'x', mode: 'asis' }, {}, () => {});
  b.onMsg({ type: 'capture-download', id: 4, name: 'x', mode: 'bogus' }, {}, () => {});
  const modes = b.posted.filter((m) => m.type === 'capture-download').map((m) => m.mode);
  ok(modes.at(-2) === 'asis' && modes.at(-1) === 'complete', 'the download mode is relayed ("asis"); anything unknown means "complete"');
  b.onMsg({ type: 'capture-cancel', id: 4 });
  ok(b.posted.some((m) => m.type === 'capture-cancel' && m.id === 4), 'Cancel is relayed to the page world');
}

// ===================================================================== background ====
function loadBackground() {
  const store = {}, listeners = {};
  const ctx = {
    atob: (s) => Buffer.from(s, "base64").toString("latin1"),
    chrome: {
      action: { setBadgeBackgroundColor() {}, setBadgeText: async () => {} },
      storage: { session: { get: async (k) => (k in store ? { [k]: JSON.parse(JSON.stringify(store[k])) } : {}), set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))), remove: async (k) => { delete store[k]; } } },
      runtime: { id: 'ext', onMessage: { addListener: (f) => { listeners.msg = f; } } },
      tabs: { onRemoved: { addListener: () => {} } },
      webRequest: { onHeadersReceived: { addListener: (f, filter, extra) => { listeners.web = f; listeners.filter = filter; listeners.extra = extra; } } },
    }, URL, console,
  };
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(read(f), ctx);
  vm.createContext(ctx);
  vm.runInContext(read('background.js'), ctx);
  const msg = async (m, tabId = 3, frameId = 0) => { listeners.msg(m, { tab: { id: tabId }, frameId }); await tick(); };
  const web = async (d) => { listeners.web({ tabId: 3, frameId: 0, statusCode: 200, type: 'xmlhttprequest', ...d }); await tick(); };
  const hdr = (ct, len, range) => [{ name: 'Content-Type', value: ct }, ...(len ? [{ name: 'Content-Length', value: String(len) }] : []), ...(range ? [{ name: 'Content-Range', value: range }] : [])];
  return { store, listeners, msg, web, hdr, list: (t = 3) => store['videos_' + t] || [] };
}

async function testBackground() {
  console.log('background: webRequest sniffer');
  const b = loadBackground();
  ok(b.listeners.extra.includes('responseHeaders') && !b.listeners.extra.includes('blocking'), 'listener is read-only (responseHeaders, never blocking)');
  ok(b.listeners.filter.types.includes('xmlhttprequest') && b.listeners.filter.types.includes('media'), 'listens to media and XHR/fetch requests');
  await b.web({ url: 'https://v.cdn.com/blob?id=1', responseHeaders: b.hdr('video/mp4', 5e6) });
  ok(b.list().length === 1 && b.list()[0].kind === 'file' && b.list()[0].source === 'webreq' && /\.mp4$/.test(b.list()[0].filename), 'extensionless video/mp4 is listed as a downloadable file with an .mp4 name');
  await b.web({ url: 'https://v.cdn.com/small?id=2', responseHeaders: b.hdr('video/mp4', 90000) });
  await b.web({ url: 'https://v.cdn.com/img.png', responseHeaders: b.hdr('image/png', 9e6) });
  await b.web({ tabId: -1, url: 'https://v.cdn.com/other?id=9', responseHeaders: b.hdr('video/mp4', 9e6) });
  ok(b.list().length === 1, 'small fetches, images and requests not tied to a tab are ignored');
  await b.web({ url: 'https://v.cdn.com/play?id=5', responseHeaders: b.hdr('application/vnd.apple.mpegurl') });
  const hls = b.list().find((v) => v.url.includes('play?id=5'));
  ok(hls && hls.kind === 'hls' && /\.m3u8$/.test(hls.filename), 'extensionless HLS manifest is listed as an HLS stream');
  await b.web({ url: 'https://v.cdn.com/o/v.mp4?bytestart=0&byteend=900000&x=1', responseHeaders: b.hdr('video/mp4', 900001) });
  const sp = b.list().find((v) => v.url.includes('/o/v.mp4'));
  ok(sp && sp.url === 'https://v.cdn.com/o/v.mp4?x=1' && /one track/i.test(sp.note), 'byte-range URL is stored as the whole track, with a warning note');
  await b.web({ url: 'https://v.cdn.com/o/v.mp4?bytestart=900001&byteend=1800000&x=1', responseHeaders: b.hdr('video/mp4', 900000) });
  ok(b.list().filter((v) => v.url.includes('/o/v.mp4')).length === 1, 'further pieces of the same track do not add duplicates');
  await b.web({ url: 'https://v.cdn.com/small?id=2', type: 'media', responseHeaders: b.hdr('video/mp4', 90000) });
  ok(b.list().some((v) => v.url.includes('small?id=2') && v.source === 'media'), 'a small file requested by a real <video> is listed');

  console.log('background: split tracks found separately become ONE "video + audio" entry');
  const efg = (tag) => encodeURIComponent(Buffer.from(JSON.stringify({ vencode_tag: tag })).toString('base64'));
  const ig = loadBackground();
  await ig.web({ tabId: 7, url: `https://scontent.cdninstagram.com/o1/v/t16/f2/m86/vid1.mp4?efg=${efg('dash_baseline_1_v1')}&bytestart=0&byteend=900000&_nc=1`, responseHeaders: ig.hdr('video/mp4', 900001, 'bytes 0-900000/5000000') });
  ok(ig.list(7).length === 1 && ig.list(7)[0].kind === 'file' && /one track/i.test(ig.list(7)[0].note), 'a lone split video track is listed as before (with the warning)');
  await ig.web({ tabId: 7, url: `https://scontent.cdninstagram.com/o1/v/t16/f2/m86/aud1.mp4?efg=${efg('dash_ln_heaac_vbr3_audio')}&bytestart=0&byteend=400000&_nc=1`, responseHeaders: ig.hdr('video/mp4', 400001, 'bytes 0-400000/800000') });
  const igl = ig.list(7);
  ok(igl.length === 1 && igl[0].kind === 'pair' && igl[0].url.includes('vid1.mp4') && igl[0].audioUrl.includes('aud1.mp4') && !/bytestart/.test(igl[0].url + igl[0].audioUrl), 'Instagram/Facebook style: video and audio (told apart by the efg tag, both served as video/mp4) become ONE pair entry with whole-track URLs');
  ok(/merged into one file/.test(igl[0].note) && igl[0].downloadable, 'the entry says it is merged on download');
  await ig.web({ tabId: 7, url: `https://scontent.cdninstagram.com/o1/v/t16/f2/m86/vid1.mp4?efg=${efg('dash_baseline_1_v1')}&bytestart=900001&byteend=1800000&_nc=1`, responseHeaders: ig.hdr('video/mp4', 900000, 'bytes 900001-1800000/5000000') });
  ok(ig.list(7).length === 1, 'later pieces of an already paired track do not bring the old entries back');

  const yt = loadBackground();
  const ytu = (itag, mime, clen) => `https://rr1---sn-x.googlevideo.com/videoplayback?id=o-AB12&itag=${itag}&mime=${encodeURIComponent(mime)}&clen=${clen}&range=0-999999&sig=zz`;
  await yt.web({ tabId: 8, url: ytu(247, 'video/webm', 4000000), responseHeaders: yt.hdr('video/webm', 1000000) });
  await yt.web({ tabId: 8, url: ytu(248, 'video/webm', 9000000), responseHeaders: yt.hdr('video/webm', 1000000) });
  await yt.web({ tabId: 8, url: ytu(251, 'audio/webm', 1200000), responseHeaders: yt.hdr('audio/webm', 1000000) });
  const ytl = yt.list(8);
  ok(ytl.length === 1 && ytl[0].kind === 'pair' && /itag=248/.test(ytl[0].url) && /itag=251/.test(ytl[0].audioUrl), 'YouTube style (shared id): the BIGGEST video and the audio are paired; the smaller alternative is dropped');
  ok(!/range=/.test(ytl[0].url + ytl[0].audioUrl) && /\.webm$/.test(ytl[0].filename), 'range parameters are removed and the file is named .webm');
  const two = loadBackground();
  await two.web({ tabId: 9, url: `https://x.cdn.com/a/v1.mp4?bytestart=0&byteend=900000`, responseHeaders: two.hdr('video/mp4', 900001, 'bytes 0-900000/5000000') });
  await two.web({ tabId: 9, url: `https://x.cdn.com/a/v2.mp4?bytestart=0&byteend=900000`, responseHeaders: two.hdr('video/mp4', 900001, 'bytes 0-900000/6000000') });
  ok(two.list(9).length === 2 && two.list(9).every((v) => v.kind === 'file'), 'two video tracks and no audio are never paired with each other');

  console.log('background: segment bursts');
  const s = loadBackground();
  for (let i = 1; i <= 4; i++) await s.web({ url: `https://c.example.com/seg/chunk-000${i}.mp4`, responseHeaders: s.hdr('video/mp4', 600000) });
  ok(s.list().length === 0, 'numbered pieces fetched by a player (chunk-0001.mp4 ...) are treated as segments and dropped');
  const g = loadBackground();
  for (let i = 1; i <= 5; i++) await g.web({ url: `https://c.example.com/clips/clip-${i}.mp4`, type: 'media', responseHeaders: g.hdr('video/mp4', 90000) });
  ok(g.list().length === 5, 'five numbered <video> elements (a gallery) are all kept');
  const ids = loadBackground();
  for (const id of ['123456789012', '223456789012', '323456789012', '423456789012']) await ids.web({ url: `https://scontent.example.com/v/${id}_n.mp4?x=1`, responseHeaders: ids.hdr('video/mp4', 4e6) });
  ok(ids.list().length === 4, 'different videos with long numeric IDs in one folder (a reels feed) are all kept');
  await b.msg({ type: 'reset' });
  ok(b.list().length === 0, 'reset still clears the tab');

  console.log('background: kind hints from the page');
  const h = loadBackground();
  const F = (video) => ({ type: 'video-found', video: { source: 'page', ...video } });
  await h.msg(F({ url: 'https://cdn.example.com/play?id=3', kindHint: 'hls' }));
  await h.msg(F({ url: 'https://cdn.example.com/m?x=1', kindHint: 'dash' }));
  await h.msg(F({ url: 'https://cdn.example.com/f?x=1', kindHint: 'bogus', mime: 'video/webm', note: 'Video only 720p' }));
  const kinds = Object.fromEntries(h.list().map((v) => [v.url, v]));
  ok(kinds['https://cdn.example.com/play?id=3'].kind === 'hls' && /\.m3u8$/.test(kinds['https://cdn.example.com/play?id=3'].filename), 'kindHint hls makes an extensionless URL an HLS stream');
  ok(kinds['https://cdn.example.com/m?x=1'].kind === 'dash', 'kindHint dash makes it a DASH stream');
  ok(kinds['https://cdn.example.com/f?x=1'].kind === 'file' && /\.webm$/.test(kinds['https://cdn.example.com/f?x=1'].filename) && kinds['https://cdn.example.com/f?x=1'].note === 'Video only 720p', 'unknown hints are ignored; notes are kept');

  console.log('background: video + audio pairs');
  const pr = loadBackground();
  await pr.msg(F({ url: 'https://scontent.cdninstagram.com/v/vid.mp4?a=1', audioUrl: 'https://scontent.cdninstagram.com/v/aud.mp4?a=2', note: 'Video + audio 1280p, merged into one file when downloaded' }));
  await pr.msg(F({ url: 'https://scontent.cdninstagram.com/v/bad.mp4?a=1', audioUrl: 'javascript:alert(1)' }));
  await pr.msg(F({ url: 'https://scontent.cdninstagram.com/v/vid.mp4?a=1', audioUrl: 'https://scontent.cdninstagram.com/v/other.mp4' }));
  const pe = pr.list().find((v) => v.url.includes('vid.mp4'));
  ok(pe && pe.kind === 'pair' && pe.audioUrl === 'https://scontent.cdninstagram.com/v/aud.mp4?a=2' && /\.mp4$/.test(pe.filename) && /merged/.test(pe.note), 'a video URL with an audio URL is stored as a "pair" entry');
  const be = pr.list().find((v) => v.url.includes('bad.mp4'));
  ok(be && be.kind === 'file' && !be.audioUrl, 'an invalid audio URL is dropped (the video stays a normal file)');
  ok(pr.list().length === 2, 'the same video URL is not added twice');

  console.log('background: blob captures');
  const c = loadBackground();
  const cap = (over = {}) => ({ type: 'capture-update', title: 'My: Reel?', capture: { id: 7, protected: false, truncated: false, whole: false, duration: 6, tracks: [{ role: 'video', bytes: 1000, covered: 2, parts: 1 }, { role: 'audio', bytes: 500, covered: 2, parts: 1 }], ...over } });
  await c.msg(cap(), 3, 2);
  ok(c.list().length === 1 && c.list()[0].kind === 'capture' && c.list()[0].url === 'capture://2/7' && c.list()[0].frameId === 2 && c.list()[0].captureId === 7, 'capture-update creates a capture entry tied to its frame');
  ok(c.list()[0].capture.bytes === 1500 && c.list()[0].capture.covered === 2 && c.list()[0].capture.duration === 6 && c.list()[0].filename === 'My_ Reel_.mp4', 'entry summarises size/coverage and gets a safe name');
  await c.msg(cap({ tracks: [{ role: 'video', bytes: 4000, covered: 6, parts: 2 }] }), 3, 2);
  ok(c.list().length === 1 && c.list()[0].capture.bytes === 4000 && c.list()[0].capture.parts === 2, 'later updates change the same entry instead of adding more');
  await c.msg(cap({ job: { phase: 'loading', message: 'Loading the rest of the video… 40%' } }), 3, 2);
  ok(c.list()[0].capture.job.phase === 'loading' && /40%/.test(c.list()[0].capture.job.message), 'the page\'s loading job (phase + progress text) is stored on the entry');
  await c.msg(cap({ job: { phase: 'evil', message: 'x' } }), 3, 2);
  ok(c.list()[0].capture.job === null, 'an unknown job phase is ignored');
  await c.msg(cap({ tracks: [{ role: 'video', bytes: 1000, covered: 6, parts: 1 }, { role: 'audio', bytes: 500, covered: 2, parts: 1 }] }), 3, 2);
  ok(c.list()[0].capture.covered === 2, 'coverage of a video+audio capture is the smaller of the two tracks');
  await c.msg(cap({ protected: true }), 3, 2);
  ok(c.list()[0].downloadable === false && c.list()[0].capture.protected === true, 'protected captures are not downloadable');
  await c.msg(cap({ id: 8 }), 3, 0);
  ok(c.list().length === 2, 'a capture in another frame is a separate entry');
  await c.msg({ type: 'capture-update', capture: { id: 'x', tracks: [] } });
  await c.msg({ type: 'capture-update', capture: { id: 9, tracks: new Array(50).fill({}) } });
  await c.msg({ type: 'capture-update', capture: { id: 10, tracks: [{ role: 'evil', bytes: -5, covered: NaN, parts: 1e9 }] } });
  const bad = c.list().find((v) => v.captureId === 10);
  ok(c.list().length === 3 && bad.capture.tracks[0].role === 'media' && bad.capture.tracks[0].bytes === 0 && bad.capture.tracks[0].parts === 99, 'malformed capture messages are rejected or clamped');
  await c.msg({ type: 'capture-gone', id: 7 }, 3, 2);
  ok(!c.list().some((v) => v.url === 'capture://2/7'), 'capture-gone removes the entry');
}

function testManifest() {
  console.log('manifest');
  const mf = JSON.parse(read('manifest.json'));
  const main = mf.content_scripts.find((c) => c.world === 'MAIN');
  const iso = mf.content_scripts.find((c) => c.world !== 'MAIN');
  ok(main && main.run_at === 'document_start' && main.all_frames && main.match_about_blank, 'page-world script runs at document_start in all frames, including about:blank');
  ok(main.js.join() === 'lib/sniff.js,lib/mux.js,lib/webm.js,inject.js' && iso.js.join() === 'lib/sniff.js,content.js', 'sniff.js, mux.js and webm.js are loaded before inject.js (page world); sniff.js before content.js (isolated world)');
  ok(mf.permissions.includes('webRequest') && mf.permissions.includes('downloads') && mf.permissions.includes('storage'), 'permissions: downloads, storage, webRequest');
  ok(!mf.permissions.includes('webRequestBlocking') && !mf.permissions.includes('declarativeNetRequest'), 'no blocking / request-rewriting permission');
  ok(parseInt(mf.minimum_chrome_version, 10) >= 111, 'minimum Chrome is 111+ (needed for content-script world: MAIN)');
  for (const f of [...main.js, ...iso.js]) ok(fs.existsSync(path.join(root, f)), `referenced file exists: ${f}`);
  ok(/^importScripts\('lib\/sniff\.js'\)/m.test(read('background.js')), 'service worker loads lib/sniff.js with importScripts (classic worker, as declared)');
  ok(!('type' in mf.background), 'background is a classic service worker (importScripts allowed)');
}

(async () => {
  try {
    testManifest();
    testSniff();
    await testInjectNetwork();
    await testCapture();
    await testContent();
    await testBackground();
    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error('\nFAILED:', e && e.stack ? e.stack : e);
    process.exit(1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
