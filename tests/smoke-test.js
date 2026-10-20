// Optional developer check (needs Node, NOT needed to use the extension).
// Runs the real content.js and background.js against minimal fake browser APIs.
// Run from the project root:  node tests/smoke-test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ok -', msg); };

// ---------- fake background environment ----------
function loadBackground() {
  const store = {};
  const listeners = {};
  const badges = {};
  const chrome = {
    action: { setBadgeBackgroundColor() {}, setBadgeText: async ({ tabId, text }) => { badges[tabId] = text; } },
    storage: { session: {
      get: async (k) => (k in store ? { [k]: JSON.parse(JSON.stringify(store[k])) } : {}),
      set: async (o) => Object.assign(store, JSON.parse(JSON.stringify(o))),
      remove: async (k) => { delete store[k]; },
    } },
    runtime: { id: 'ext-id', onMessage: { addListener: (f) => { listeners.msg = f; } } },
    tabs: { onRemoved: { addListener: (f) => { listeners.removed = f; } } },
    webRequest: { onHeadersReceived: { addListener: (f, filter, extra) => { listeners.web = f; listeners.webFilter = filter; listeners.webExtra = extra; } } },
  };
  const ctx = { chrome, URL, console, setTimeout };
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(read(f), ctx);
  vm.createContext(ctx);
  vm.runInContext(read('background.js'), ctx);
  return { store, listeners, badges };
}

// ---------- fake page environment ----------
function makeEl(tag, attrs = {}, extra = {}) {
  return { nodeType: 1, tagName: tag, parentElement: null, _kids: [], _a: attrs,
    getAttribute(n) { return n in this._a ? this._a[n] : null; },
    querySelectorAll() { return this._kids; }, ...extra };
}
function loadContent(elements, isTop = true, entries = []) {
  const sent = [];
  let observerCb, observeArgs, perfCb, rescan, interval;
  const docListeners = {};
  const document = { nodeType: 9, baseURI: 'https://example.com/dir/page.html', readyState: 'loading', title: 'My Page', hidden: false,
    querySelectorAll: () => elements,
    addEventListener: (t, f) => { docListeners[t] = f; } };
  const window = { addEventListener() {}, postMessage() {} }; window.top = isTop ? window : {};
  class MutationObserver { constructor(cb) { observerCb = cb; } observe(...a) { observeArgs = a; } }
  class PerformanceObserver { constructor(cb) { perfCb = cb; } observe() {} }
  const timers = [];
  const chrome = { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); },
    onMessage: { addListener: (f) => { rescan = f; } } } };
  vm.runInNewContext(read('content.js'),
    { document, window, MutationObserver, PerformanceObserver, chrome, URL,
      performance: { getEntriesByType: () => entries },
      setTimeout: (f) => { timers.push(f); return 1; }, setInterval: (f) => { interval = f; return 1; } });
  return { sent, docListeners, observeArgs, document,
    mutate: (m) => { observerCb(m); timers.splice(0).forEach((f) => f()); },
    perf: (list) => perfCb({ getEntries: () => list }),
    rescan: () => rescan({ type: 'rescan' }), tick: () => interval() };
}

(async () => {
  console.log('manifest');
  const mf = JSON.parse(read('manifest.json'));
  ok(mf.manifest_version === 3, 'manifest_version is 3');
  for (const f of [mf.background.service_worker, mf.content_scripts[0].js[0], mf.action.default_popup, ...Object.values(mf.icons)])
    ok(fs.existsSync(path.join(__dirname, '..', f)), `referenced file exists: ${f}`);

  console.log('content script');
  const vid = makeEl('VIDEO', { src: 'clip.mp4' }, { currentSrc: 'https://example.com/dir/clip.mp4' });
  const vidBlob = makeEl('VIDEO', { src: 'blob:https://example.com/abc' }, { currentSrc: 'blob:https://example.com/abc' });
  const vidBad = makeEl('VIDEO', { src: 'http://[bad' });
  const vidHls = makeEl('VIDEO', { src: 'https://cdn.example.com/live.m3u8' });
  const vidData = makeEl('VIDEO', { src: 'data:video/mp4;base64,AAAA' });
  const srcParent = makeEl('VIDEO', {});
  const srcWebm = makeEl('SOURCE', { src: '/media/My Movie.webm?x=1#t=5', type: 'video/webm' }, { parentElement: srcParent });
  const srcNoExt = makeEl('SOURCE', { src: 'https://example.com/stream?id=7', type: 'video/webm' }, { parentElement: srcParent });
  const srcInPicture = makeEl('SOURCE', { src: 'https://example.com/img.webp' }, { parentElement: makeEl('PICTURE') });
  const linkMp4 = makeEl('A', { href: 'https://example.com/files/a.MP4' });
  const linkHtml = makeEl('A', { href: 'https://example.com/page.html' });
  const linkJs = makeEl('A', { href: 'javascript:void(0)' });
  const linkDup = makeEl('A', { href: 'https://example.com/dir/clip.mp4#again' });

  const page = loadContent([vid, vidBlob, vidBad, vidHls, vidData, srcWebm, srcNoExt, srcInPicture, linkMp4, linkHtml, linkJs, linkDup]);
  page.docListeners.DOMContentLoaded();
  const urls = page.sent.filter((m) => m.type === 'video-found').map((m) => m.video.url);
  ok(page.sent[0].type === 'reset', 'top frame sends reset first');
  ok(urls.includes('https://example.com/dir/clip.mp4'), 'detects <video src> (relative URL resolved)');
  ok(urls.includes('https://example.com/media/My%20Movie.webm?x=1'), 'detects <source> WebM, strips #hash');
  ok(urls.includes('https://example.com/stream?id=7'), 'accepts extensionless <source> inside <video>');
  ok(urls.includes('https://example.com/files/a.MP4'), 'detects <a> link to .MP4 (case-insensitive)');
  ok(!urls.some((u) => /blob:|data:|javascript:|img\.webp|page\.html/.test(u)), 'ignores blob/data/javascript/picture-source/non-video link');
  ok(urls.includes('https://cdn.example.com/live.m3u8'), 'PART 2 CHANGE: HLS manifest on <video> is now reported');
  ok(urls.filter((u) => u.endsWith('clip.mp4')).length === 1, 'duplicate (video+currentSrc+link with #hash) reported once');
  ok(urls.length === 5, `exactly 5 items reported (got ${urls.length})`);

  console.log('content script: dynamic elements');
  const before = page.sent.length;
  const dyn = makeEl('DIV', {}, { _kids: [makeEl('VIDEO', { src: 'https://example.com/late.mp4' })] });
  page.mutate([{ type: 'childList', addedNodes: [dyn] }]);
  ok(page.sent.length === before + 1 && page.sent.at(-1).video.url === 'https://example.com/late.mp4', 'detects video inside dynamically added node');
  const changed = makeEl('VIDEO', { src: 'https://example.com/swapped.webm' });
  page.mutate([{ type: 'attributes', target: changed }]);
  ok(page.sent.at(-1).video.url === 'https://example.com/swapped.webm', 'detects changed src attribute');
  ok(page.observeArgs[1].subtree && page.observeArgs[1].childList, 'observer watches subtree + childList');
  ok(page.sent.every((m) => m.type !== 'video-found' || (m.video.title === 'My Page')), 'page title is sent along');
  const iframePage = loadContent([], false);
  ok(!iframePage.sent.some((m) => m.type === 'reset'), 'sub-frame does not send reset');

  console.log('background');
  const bg = loadBackground();
  const send = async (msg, tabId = 5, frameId = 0) => { bg.listeners.msg(msg, { tab: { id: tabId }, frameId }); await new Promise((r) => setTimeout(r, 5)); };
  const found = (url, mime = '', source = 'video') => ({ type: 'video-found', video: { url, mime, source } });
  await send(found('https://example.com/a/Cool%20Clip.mp4'));
  await send(found('https://example.com/a/Cool%20Clip.mp4'));
  await send(found('https://example.com/x/y.webm', 'video/webm'));
  await send(found('https://example.com/stream?id=7', 'video/webm'));
  await send(found('https://example.com/', ''));
  await send(found('ftp://example.com/a.mp4'));
  await send(found('not a url'));
  await send({ type: 'video-found', video: null });
  await send({ type: 'video-found', video: { url: 123 } });
  await send(found('https://example.com/' + 'a'.repeat(3000) + '.mp4'));
  const list = bg.store.videos_5;
  ok(list.length === 4, `4 valid unique entries stored (got ${list.length})`);
  ok(list[0].filename === 'Cool Clip.mp4', 'filename decoded from URL');
  ok(list[2].filename === 'stream.webm', 'extensionless name gets .webm from MIME type');
  ok(list[3].filename === 'example.com.mp4', 'URL with no path falls back to hostname + .mp4');
  ok(bg.badges[5] === '4', 'badge shows count');
  await send(found('https://example.com/other.mp4'), 9);
  ok(bg.store.videos_9.length === 1 && bg.store.videos_5.length === 4, 'tabs are tracked separately');
  await send({ type: 'reset' }, 5, 3);
  ok(bg.store.videos_5.length === 4, 'reset from sub-frame is ignored');
  await send({ type: 'reset' }, 5, 0);
  ok(bg.store.videos_5.length === 0 && bg.badges[5] === '', 'top-frame reset clears list and badge');
  await send(found('https://example.com/nasty.mp4?..%2F..%2Fx', '', 'video'));
  await send(found('https://example.com/a%2F..%5Cb%3A*.mp4'));
  ok(bg.store.videos_5.every((v) => !/[\\/:*?"<>|]/.test(v.filename)), 'filenames contain no path separators or illegal characters');
  bg.listeners.removed(5); await new Promise((r) => setTimeout(r, 5));
  ok(!('videos_5' in bg.store), 'closing a tab removes its data');
  for (let i = 0; i < 250; i++) await send(found(`https://example.com/v${i}.mp4`), 7);
  ok(bg.store.videos_7.length === 200, 'per-tab list is capped at 200');

  // ================= PART 2 =================
  console.log('PART 2 content script');
  const audio = makeEl('AUDIO', { src: 'https://example.com/a/song.mp3' }, { currentSrc: '' });
  const aParent = makeEl('AUDIO', {});
  const aSource = makeEl('SOURCE', { src: 'track.ogg', type: 'audio/ogg' }, { parentElement: aParent });
  const dashSrc = makeEl('SOURCE', { src: 'https://cdn.example.com/m/manifest.mpd', type: 'application/dash+xml' }, { parentElement: srcParent });
  const lazy = makeEl('VIDEO', { 'data-src': 'https://example.com/lazy.mp4' });
  const lazyBad = makeEl('VIDEO', { 'data-src': 'https://example.com/lazy-page' });
  const dlLink = makeEl('A', { href: 'https://example.com/get?id=3.mp4', download: 'My Holiday.mp4' });
  const mp3Link = makeEl('A', { href: 'https://example.com/pod.mp3' });
  const hlsLink = makeEl('A', { href: 'https://example.com/live/index.m3u8?token=1' });
  const embed = makeEl('EMBED', { src: 'https://example.com/e.webm', type: 'video/webm' });
  const embedPdf = makeEl('EMBED', { src: 'https://example.com/doc.pdf' });
  const obj = makeEl('OBJECT', { data: 'https://example.com/o.mp4' });
  const resolved = makeEl('VIDEO', { src: 'rel.mp4' }, { src: 'https://other.example.org/base/rel.mp4' });
  const p2 = loadContent([audio, aSource, dashSrc, lazy, lazyBad, dlLink, mp3Link, hlsLink, embed, embedPdf, obj, resolved]);
  p2.docListeners.DOMContentLoaded();
  const v2 = p2.sent.filter((m) => m.type === 'video-found').map((m) => m.video);
  const u2 = v2.map((v) => v.url);
  const by = (u) => v2.find((v) => v.url === u);
  ok(by('https://example.com/a/song.mp3').media === 'audio', 'detects <audio src> with media=audio');
  ok(by('https://example.com/dir/track.ogg').media === 'audio' && by('https://example.com/dir/track.ogg').mime === 'audio/ogg', 'detects <source> inside <audio> with its type');
  ok(u2.includes('https://cdn.example.com/m/manifest.mpd'), 'detects DASH <source>');
  ok(u2.includes('https://example.com/lazy.mp4') && !u2.includes('https://example.com/lazy-page'), 'data-src accepted only when it looks like media');
  ok(by('https://example.com/get?id=3.mp4') === undefined, 'link whose extension is only in the query is not guessed');
  ok(u2.includes('https://example.com/pod.mp3'), 'detects audio link');
  ok(u2.includes('https://example.com/live/index.m3u8?token=1'), 'detects HLS link (query kept)');
  ok(u2.includes('https://example.com/e.webm') && !u2.includes('https://example.com/doc.pdf'), '<embed> media accepted, PDF ignored');
  ok(u2.includes('https://example.com/o.mp4'), 'detects <object data>');
  ok(u2.includes('https://other.example.org/base/rel.mp4'), 'prefers the browser-resolved .src property over the raw attribute');
  const dl2 = makeEl('A', { href: 'https://example.com/dl/clip.mp4', download: 'My Holiday.mp4' });
  const p2b = loadContent([dl2]); p2b.docListeners.DOMContentLoaded();
  ok(p2b.sent.find((m) => m.video).video.hint === 'My Holiday.mp4', 'download= attribute is sent as filename hint');

  console.log('PART 2 dynamic pages, SPA, rescan');
  const spa = loadContent([]);
  spa.docListeners.DOMContentLoaded();
  const route = makeEl('SECTION', {}, { _kids: [makeEl('AUDIO', { src: 'https://example.com/spa.m4a' })] });
  spa.mutate([{ type: 'childList', addedNodes: [route] }]);
  ok(spa.sent.some((m) => m.video && m.video.url === 'https://example.com/spa.m4a'), 'SPA route change inserting <audio> is detected');
  const late = makeEl('VIDEO', { src: 'https://example.com/late-no-observer.mp4' });
  spa.document.querySelectorAll = () => [late];
  spa.tick();
  ok(spa.sent.some((m) => m.video && m.video.url.endsWith('late-no-observer.mp4')), 'periodic rescan finds media even if the observer was lost (document.write case)');
  spa.document.hidden = true; const n = spa.sent.length;
  spa.document.querySelectorAll = () => [makeEl('VIDEO', { src: 'https://example.com/hidden.mp4' })];
  spa.tick();
  ok(spa.sent.length === n, 'periodic rescan is skipped while the tab is hidden');
  spa.document.hidden = false;
  spa.document.querySelectorAll = () => [late];
  const n2 = spa.sent.length; spa.tick();
  ok(spa.sent.length === n2, 'already-reported URL is not re-sent by the periodic rescan');
  spa.rescan();
  ok(spa.sent.length === n2 + 1, 'rescan message clears the sent-set so the page is reported again');

  console.log('PART 2 network (Resource Timing)');
  const net = loadContent([], true, [
    { name: 'https://cdn.example.com/hls/master.m3u8?sig=abc', initiatorType: 'xmlhttprequest' },
    { name: 'https://cdn.example.com/dash/stream.mpd', initiatorType: 'fetch' },
    { name: 'https://cdn.example.com/seg/chunk1.mp4', initiatorType: 'fetch' },
    { name: 'https://cdn.example.com/native.mp4', initiatorType: 'video' },
    { name: 'https://cdn.example.com/bundle.js', initiatorType: 'script' },
    { name: 'blob:https://example.com/zzz', initiatorType: 'video' },
  ]);
  net.docListeners.DOMContentLoaded();
  net.perf([{ name: 'https://cdn.example.com/late/live.m3u8', initiatorType: 'fetch' }]);
  net.rescan();
  const nu = [...new Set(net.sent.filter((m) => m.video).map((m) => m.video.url))];
  ok(nu.includes('https://cdn.example.com/hls/master.m3u8?sig=abc') && nu.includes('https://cdn.example.com/dash/stream.mpd'), 'manifests fetched by players are detected from resource timings');
  ok(nu.includes('https://cdn.example.com/late/live.m3u8'), 'PerformanceObserver entries are detected live');
  ok(nu.includes('https://cdn.example.com/native.mp4'), 'natively loaded media is detected');
  ok(!nu.some((u) => /chunk1|bundle|blob:/.test(u)), 'fetched .mp4 segments, scripts and blob: are NOT listed');
  const mf2 = JSON.parse(read('manifest.json'));
  ok(mf2.content_scripts[0].match_about_blank === true && mf2.content_scripts[0].all_frames === true, 'manifest injects into about:blank frames (fixes online code-editor result frames)');

  console.log('PART 2 background');
  const b2 = loadBackground();
  const s2 = async (msg, tabId = 1, frameId = 0, sender) => { b2.listeners.msg(msg, sender || { tab: { id: tabId }, frameId }); await new Promise((r) => setTimeout(r, 5)); };
  const F = (video) => ({ type: 'video-found', video });
  await s2(F({ url: 'https://c.example.com/live/master.m3u8?x=1', source: 'network' }));
  await s2(F({ url: 'https://c.example.com/v/manifest.mpd', source: 'source' }));
  await s2(F({ url: 'https://c.example.com/api/stream?id=9', mime: 'application/vnd.apple.mpegurl', source: 'source' }));
  await s2(F({ url: 'https://c.example.com/s/song.mp3', media: 'audio', source: 'audio' }));
  await s2(F({ url: 'https://c.example.com/s/noext', media: 'audio', source: 'audio' }));
  await s2(F({ url: 'https://c.example.com/s/noext2', mime: 'audio/mp4', media: 'audio' }));
  await s2(F({ url: 'https://c.example.com/s/noext3', mime: 'video/webm', media: 'video' }));
  await s2(F({ url: 'https://c.example.com/s/movie.ogg', mime: 'video/ogg', media: 'video' }));
  const L = b2.store.videos_1; const g = (u) => b2.store.videos_1.find((v) => v.url.includes(u));
  ok(g('master.m3u8').kind === 'hls' && g('master.m3u8').downloadable === true && g('master.m3u8').filename === 'master.m3u8', 'HLS classified, downloadable (PART 3), keeps .m3u8 name');
  ok(g('manifest.mpd').kind === 'dash' && g('manifest.mpd').downloadable === true, 'DASH classified, downloadable (PART 3)');
  ok(g('api/stream').kind === 'hls' && g('api/stream').filename === 'stream.m3u8', 'HLS detected from MIME type when URL has no extension');
  ok(g('song.mp3').kind === 'file' && g('song.mp3').downloadable === true && g('song.mp3').media === 'audio', 'MP3 is a downloadable audio file');
  ok(g('noext').filename === 'noext.mp3', 'extensionless audio defaults to .mp3');
  ok(g('noext2').filename === 'noext2.m4a', 'audio/mp4 MIME gives .m4a');
  ok(g('noext3').filename === 'noext3.webm', 'video/webm MIME gives .webm');
  ok(g('movie.ogg').filename === 'movie.ogg', 'existing .ogg extension kept');
  ok(L.every((v) => v.downloadable === true), 'PART 3: files and streams are all marked downloadable');

  await s2(F({ url: 'https://c.example.com/dl/get', hint: 'My: Holiday?.mp4' }));
  await s2(F({ url: 'https://c.example.com/hls/index.m3u8?a=1', title: 'Big Show / Ep 1' }));
  await s2(F({ url: 'https://c.example.com/clips/12345.mp4', title: 'Cat Video' }));
  await s2(F({ url: 'https://c.example.com/clips/named.mp4', title: 'Should Not Win' }));
  ok(g('dl/get').filename === 'My_ Holiday_.mp4', 'download= hint wins and is sanitized');
  ok(g('hls/index.m3u8').filename === 'Big Show _ Ep 1.m3u8', 'generic "index" name is replaced by the page title (sanitized)');
  ok(g('12345.mp4').filename === 'Cat Video.mp4', 'numeric name replaced by page title');
  ok(g('named.mp4').filename === 'named.mp4', 'meaningful URL names are not replaced by the title');

  const before2 = b2.store.videos_1.length;
  await s2(F({ url: 'https://c.example.com/s/song.mp3', source: 'link' }), 1, 4);
  ok(b2.store.videos_1.length === before2, 'same URL reported again (e.g. from another frame) is not duplicated');

  console.log('PART 2 popup messages (clear / remove)');
  const popup = (m) => s2(m, 0, 0, { id: 'ext-id' });
  await popup({ type: 'remove', tabId: 1, url: 'https://c.example.com/s/song.mp3' });
  ok(!b2.store.videos_1.some((v) => v.url.endsWith('song.mp3')) && b2.store.videos_1.length === before2 - 1, 'remove deletes one entry');
  await s2({ type: 'clear', tabId: 1 }, 0, 0, { id: 'evil-ext' });
  ok(b2.store.videos_1.length === before2 - 1, 'clear from a foreign sender id is ignored');
  await s2({ type: 'clear', tabId: 'abc' }, 0, 0, { id: 'ext-id' });
  ok(b2.store.videos_1.length === before2 - 1, 'clear with non-integer tabId is ignored');
  await s2({ type: 'clear', tabId: 1 }, 1, 0, { id: 'ext-id', tab: { id: 2 }, frameId: 0 });
  ok(b2.store.videos_1.length === before2 - 1, 'a content script cannot clear another tab via the popup path');
  await popup({ type: 'clear', tabId: 1 });
  ok(b2.store.videos_1.length === 0 && b2.badges[1] === '', 'clear empties the list and the badge');

  // ---------- popup UI with a tiny fake DOM ----------
  console.log('PART 2 popup UI');
  const makePopup = async (stored) => {
    const mk = (tag) => { const e = { tag, style: {}, children: [], _text: '', className: '', hidden: false, listeners: {}, disabled: false, title: '',
      classList: { toggle(c, on) { const set = new Set(e.className.split(' ').filter(Boolean)); on ? set.add(c) : set.delete(c); e.className = [...set].join(' '); } },
      append(...k) { e.children.push(...k); }, addEventListener(t, f) { e.listeners[t] = f; },
      set textContent(v) { e._text = v; if (v === '') e.children = []; }, get textContent() { return e._text; } }; return e; };
    const ids = Object.fromEntries(['list', 'empty', 'msg', 'refresh', 'clear'].map((i) => [i, mk('x')]));
    const sentMsgs = [], tabMsgs = [], dls = [], created = []; let onChanged, dlChanged;
    const chrome = {
      tabs: { create: async (o) => { created.push(o); }, query: async () => [{ id: 42 }], sendMessage: async (id, m, o) => { tabMsgs.push([id, m, o]); if (stored.__fail) throw new Error('no receiver'); return stored.__reply; } },
      storage: { session: { get: async (k) => ({ [k]: stored.list }) }, onChanged: { addListener: (f) => { onChanged = f; } } },
      runtime: { sendMessage: async (m) => { sentMsgs.push(m); }, getURL: (p) => 'chrome-extension://x/' + p },
      downloads: { download: async (o) => { dls.push(o); if (stored.__reject) throw new Error('Invalid filename'); return 7; }, onChanged: { addListener: (f) => { dlChanged = f; } } },
    };
    const ctx = { chrome, URL, URLSearchParams, SVDStream: require('../lib/stream.js'), fetch: async () => ({ ok: true, status: 200, text: async () => stored.manifest || '' }), navigator: { clipboard: { writeText: async () => {} } },
      document: { getElementById: (i) => ids[i], createElement: mk } };
    vm.runInNewContext(read('popup/popup.js'), ctx);
    await new Promise((r) => setTimeout(r, 10));
    const flat = (e) => [e, ...e.children.flatMap(flat)];
    const btns = (li) => flat(li).filter((e) => e.tag === 'button' || e.listeners.click).map((e) => e._text);
    return { created, ids, sentMsgs, tabMsgs, dls, onChanged: (c) => onChanged(c, 'session'), dlChanged: (d) => dlChanged(d), flat, btns };
  };
  const mixed = [
    { url: 'https://e.com/a.m3u8', filename: 'a.m3u8', kind: 'hls', downloadable: false },
    { url: 'https://e.com/b.mp4', filename: 'b.mp4', kind: 'file', downloadable: true },
    { url: 'https://e.com/old.mp4', filename: 'old.mp4' }, // Part 1 style entry, no kind
    { url: 'https://e.com/c.mpd', filename: 'c.mpd', kind: 'dash', downloadable: false },
  ];
  const ui = await makePopup({ list: mixed });
  const items = ui.ids.list.children;
  ok(items.length === 4, 'popup renders all entries');
  ok(items[0].children.length && items[2].children.length, 'items have content');
  const labelsOf = (li) => ui.flat(li).map((e) => e._text).filter(Boolean);
  ok(items.every((li) => ui.btns(li).includes('Download')), 'PART 3: files (sorted first) and HLS/DASH streams all have a Download button');
  ok(labelsOf(items[2]).some((t) => /^HLS stream/.test(t)) && labelsOf(items[3]).some((t) => /^DASH stream/.test(t)), 'streams are labelled HLS/DASH');
  ok(labelsOf(items[0]).some((t) => /MP4 file/.test(t)), 'files show their format');
  ok(items.slice(2).every((li) => ui.btns(li).includes('Copy URL') && ui.btns(li).includes('Remove')), 'streams still offer Copy URL / Remove');

  const clickBtn = async (li, label) => { await ui.flat(li).find((e) => e._text === label).listeners.click(); await new Promise((r) => setTimeout(r, 5)); };
  await clickBtn(items[0], 'Download');
  ok(ui.dls.length === 1 && ui.dls[0].url === 'https://e.com/b.mp4' && ui.dls[0].filename === 'b.mp4', 'Download calls chrome.downloads.download with url + filename');
  ui.dlChanged({ id: 7, error: { current: 'SERVER_FORBIDDEN' } }); await new Promise((r) => setTimeout(r, 5));
  ok(ui.flat(ui.ids.list).some((e) => /refused the request/.test(e._text)), 'later download failure shows a readable error');
  await ui.ids.refresh.listeners.click(); await new Promise((r) => setTimeout(r, 5));
  ok(ui.tabMsgs[0][0] === 42 && ui.tabMsgs[0][1].type === 'rescan', 'Refresh sends rescan to the active tab');
  await ui.ids.clear.listeners.click();
  ok(ui.sentMsgs.some((m) => m.type === 'clear' && m.tabId === 42), 'Clear asks the background to clear this tab');
  await clickBtn(ui.ids.list.children[1], 'Remove');
  ok(ui.sentMsgs.some((m) => m.type === 'remove' && m.tabId === 42 && m.url), 'Remove asks the background to delete one entry');
  ui.onChanged({ videos_42: { newValue: [mixed[1]] } });
  ok(ui.ids.list.children.length === 1, 'popup re-renders live when storage changes');
  const ui2 = await makePopup({ list: [], __fail: true });
  ok(ui2.ids.empty.hidden === false, 'empty state is shown with no entries');
  await ui2.ids.refresh.listeners.click(); await new Promise((r) => setTimeout(r, 5));
  ok(/Can.t scan this page/.test(ui2.ids.msg._text) && ui2.ids.msg.className.includes('error'), 'Refresh failure shows a helpful error');
  const ui3 = await makePopup({ list: [mixed[1]], __reject: true });
  await clickBtn(ui3.ids.list.children[0], 'Download');
  ok(ui3.dls.length === 2 && ui3.dls[1].filename === undefined, 'rejected filename falls back to a download without one');

  // ----- PART 4 popup: blob captures -----
  console.log('PART 4 popup blob captures');
  const capEntry = (over = {}) => ({ url: 'capture://3/7', kind: 'capture', filename: 'My Reel.mp4', frameId: 3, captureId: 7, downloadable: true, note: '',
    capture: { bytes: 12.4 * 1048576, covered: 4, duration: 6, protected: false, truncated: false, whole: false, parts: 1, tracks: [{ role: 'video', bytes: 1, covered: 4, parts: 1 }, { role: 'audio', bytes: 1, covered: 4, parts: 1 }], ...over } });
  const withCap = [{ url: 'https://e.com/a.m3u8', filename: 'a.m3u8', kind: 'hls', downloadable: false }, capEntry(), { url: 'https://e.com/b.mp4', filename: 'b.mp4', kind: 'file', downloadable: true }];
  const uc = await makePopup({ list: withCap, manifest: '', __reply: { ok: true, merged: true, files: [{ name: 'My Reel.mp4' }] } });
  const citems = uc.ids.list.children;
  const text = (li) => uc.flat(li).map((e) => e._text).filter(Boolean);
  ok(text(citems[0]).includes('MP4 file') && text(citems[1]).some((t) => /^Blob video/.test(t)) && text(citems[2]).some((t) => /^HLS stream/.test(t)), 'PART 4: order is files, then blob captures, then streams');
  ok(text(citems[1]).some((t) => /12\.4 MB/.test(t) && /captured 0:04 of 0:06 \(67%\)/.test(t) && /merged into one file/.test(t)), 'capture row shows size, coverage and that audio+video are merged');
  ok(text(citems[1]).some((t) => /loads the rest of the video by itself/.test(t)), 'an incomplete capture explains that Download loads the rest automatically (no need to play it)');
  ok(uc.btns(citems[1]).includes('Save as is'), 'an incomplete capture offers "Save as is"');
  ok(!uc.btns(citems[1]).includes('Copy URL') && uc.btns(citems[1]).includes('Download') && uc.btns(citems[1]).includes('Remove'), 'capture row has Download and Remove but no Copy URL (there is no URL)');
  await clickBtn(citems[1], 'Download');
  const dlMsg = uc.tabMsgs.find(([, m]) => m.type === 'capture-download');
  ok(dlMsg && dlMsg[0] === 42 && dlMsg[1].id === 7 && dlMsg[1].name === 'My Reel' && dlMsg[1].mode === 'complete' && dlMsg[2].frameId === 3, 'capture Download messages the right tab AND frame, with the base name, asking to complete the video first');
  ok(uc.flat(uc.ids.list).some((e) => /Saved: My Reel\.mp4 \(audio \+ video merged\)/.test(e._text)), 'success shows the single merged file name');
  ok(uc.dls.length === 0, 'blob captures are saved by the page, not through chrome.downloads');
  await clickBtn(citems[1], 'Save as is');
  ok(uc.tabMsgs.some(([, m]) => m.type === 'capture-download' && m.mode === 'asis'), '"Save as is" asks the page to save without loading the rest');
  const ust = await makePopup({ list: [capEntry()], __reply: { ok: true, started: true } });
  await clickBtn(ust.ids.list.children[0], 'Download');
  ok(ust.flat(ust.ids.list).some((e) => /Loading the rest of the video/.test(e._text)), 'a started job says it is loading and will save automatically');
  const uj = await makePopup({ list: [capEntry({ job: { phase: 'loading', message: 'Loading the rest of the video… 67%' } })] });
  const jli = uj.ids.list.children[0];
  ok(uj.flat(jli).some((e) => e._text === 'Loading the rest of the video… 67%') && uj.flat(jli).find((e) => e._text === 'Download').disabled === true, 'while loading: progress is shown (from the page) and Download is disabled');
  ok(uj.btns(jli).includes('Cancel') && !uj.btns(jli).includes('Save as is'), 'while loading: Cancel is offered instead of Save as is');
  await clickBtn(jli, 'Cancel');
  ok(uj.tabMsgs.some(([id, m, o]) => id === 42 && m.type === 'capture-cancel' && m.id === 7 && o.frameId === 3), 'Cancel messages the right tab and frame');
  const ujf = await makePopup({ list: [capEntry({ job: { phase: 'failed', message: 'Could not load the whole video (40% loaded).' } })] });
  ok(ujf.flat(ujf.ids.list).some((e) => /Could not load the whole video/.test(e._text) && /error/.test(e.className)) && ujf.btns(ujf.ids.list.children[0]).includes('Save as is'), 'a failed job shows the reason as an error and offers Save as is');
  const ucomplete = await makePopup({ list: [capEntry({ covered: 6 })] });
  ok(!ucomplete.btns(ucomplete.ids.list.children[0]).includes('Save as is') && ucomplete.flat(ucomplete.ids.list).some((e) => /merged into one file/.test(e._text)), 'a complete capture has no "Save as is" and says it will be merged');
  const pairEntry = { url: 'https://cdn.e.com/v.mp4?x=1', audioUrl: 'https://cdn.e.com/a.mp4?x=2', kind: 'pair', filename: 'Reel.mp4', note: 'Video + audio 1280p, merged into one file when downloaded', downloadable: true };
  const upair = await makePopup({ list: [pairEntry, { url: 'https://e.com/b.mp4', filename: 'b.mp4', kind: 'file' }] });
  const pitems = upair.ids.list.children;
  ok(upair.flat(pitems[1]).some((e) => /^Video \+ audio \(merged/.test(e._text)) && upair.flat(pitems[1]).some((e) => /1280p/.test(e._text)), 'a pair entry is labelled "Video + audio" and shows its quality note');
  ok(upair.btns(pitems[1]).includes('Download') && upair.btns(pitems[1]).includes('Copy URL') && !upair.flat(pitems[1]).some((e) => e.tag === 'select'), 'a pair has Download and Copy URL but no quality picker');
  await clickBtn(pitems[1], 'Download');
  ok(upair.created.length === 1 && /downloader\.html\?/.test(upair.created[0].url) && /audio=https%3A%2F%2Fcdn\.e\.com%2Fa\.mp4/.test(upair.created[0].url) && /url=https%3A%2F%2Fcdn\.e\.com%2Fv\.mp4/.test(upair.created[0].url), 'pair Download opens the downloader tab with both URLs');
  const ue = await makePopup({ list: [capEntry()], __reply: { ok: false, error: 'This capture is no longer available.' } });
  await clickBtn(ue.ids.list.children[0], 'Download');
  ok(ue.flat(ue.ids.list).some((e) => /Failed: This capture is no longer available/.test(e._text) && /error/.test(e.className)), 'page-side errors are shown as errors');
  const un = await makePopup({ list: [capEntry()], __fail: true });
  await clickBtn(un.ids.list.children[0], 'Download');
  ok(un.flat(un.ids.list).some((e) => /^Failed:/.test(e._text)), 'an unreachable page (reloaded tab) gives a Failed message');
  const ud = await makePopup({ list: [capEntry({ protected: true })] });
  ok(ud.flat(ud.ids.list).some((e) => /Encrypted playback \(DRM\)/.test(e._text)) && ud.flat(ud.ids.list).find((e) => e._text === 'Download').disabled === true, 'protected capture: explained and Download disabled');
  const ut = await makePopup({ list: [capEntry({ truncated: true, parts: 2, duration: 0 })] });
  ok(ut.flat(ut.ids.list).some((e) => /size limit reached/.test(e._text) && /2 parts/.test(e._text)), 'truncated / multi-part captures say so');
  const un2 = await makePopup({ list: [{ url: 'https://e.com/v.mp4?x=1', kind: 'file', filename: 'v.mp4', note: 'One track of a split stream: it may have no sound.' }] });
  ok(un2.flat(un2.ids.list).some((e) => /One track of a split stream/.test(e._text)), 'notes on normal entries (split-track warning) are displayed');

  // ----- PART 3 popup: stream quality + download tab -----
  console.log('PART 3 popup streams');
  const hlsText = fs.readFileSync(path.join(__dirname, 'fixtures/hls/master.m3u8'), 'utf8');
  const ui4 = await makePopup({ list: [mixed[0]], manifest: hlsText });
  const hli = ui4.ids.list.children[0];
  const sel = ui4.flat(hli).find((e) => e.tag === 'select');
  ok(sel && sel.children.length === 3 && /120p/.test(sel.children[1]._text) && /72p/.test(sel.children[2]._text), 'HLS entry lists detected qualities (Best + 120p + 72p)');
  sel.value = '1';
  await clickBtn(hli, 'Download');
  ok(ui4.created.length === 1 && /downloader\.html\?/.test(ui4.created[0].url) && /quality=1/.test(ui4.created[0].url) && /url=https%3A%2F%2Fe\.com%2Fa\.m3u8/.test(ui4.created[0].url), 'stream Download opens the downloader tab with url + quality');
  const ui5 = await makePopup({ list: [mixed[0]], manifest: fs.readFileSync(path.join(__dirname, 'fixtures/hls/encrypted.m3u8'), 'utf8') });
  ok(ui5.flat(ui5.ids.list).some((e) => /encrypted/.test(e._text) && /error/.test(e.className)) && ui5.flat(ui5.ids.list).find((e) => e._text === 'Download').disabled === true, 'encrypted HLS shows an explanation and Download is disabled');
  const ui6 = await makePopup({ list: [mixed[3]], manifest: '<html>expired</html>' });
  ok(ui6.flat(ui6.ids.list).some((e) => /did not return an HLS or DASH manifest/.test(e._text) && /error/.test(e.className)), 'non-manifest response shows an explanatory error');
  ok(ui6.flat(ui6.ids.list).find((e) => e._text === 'Download').disabled === true, 'Download is disabled when the manifest is unusable');

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
