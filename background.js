// Service worker: keeps a de-duplicated list of detected media per tab in
// chrome.storage.session, classifies each as a downloadable file, an HLS/DASH stream or a
// blob: capture, and shows the count on the toolbar badge. It also looks at response headers
// (webRequest, read-only) to find media that has no telltale URL.
'use strict';

importScripts('lib/sniff.js');
const Sniff = self.SVDSniff;

const MAX_PER_TAB = 200;
const MAX_URL_LENGTH = 2048;
const keyFor = (tabId) => `videos_${tabId}`;
const FILE_EXT = /\.(mp4|webm|m4v|ogv|mov|mkv|3gp|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
const AUDIO_EXT = /\.(mp3|m4a|aac|oga|opus|wav|flac)$/i;
const GENERIC_NAME = /^(video|audio|index|master|playlist|manifest|stream|media|file|download|main|\d+|[0-9a-f]{16,})$/i;
const MIME_EXT = [
  [/webm/i, '.webm'], [/audio\/(mp4|x-m4a|m4a)/i, '.m4a'], [/quicktime/i, '.mov'], [/matroska/i, '.mkv'], [/3gpp/i, '.3gp'], [/mp4/i, '.mp4'],
  [/audio\/mpeg|mp3/i, '.mp3'], [/ogg/i, '.ogg'], [/wav/i, '.wav'], [/aac/i, '.aac'], [/flac/i, '.flac'],
];

chrome.action.setBadgeBackgroundColor({ color: '#1a73e8' });

// Storage read-modify-write must not interleave, so run everything through one chain.
let chain = Promise.resolve();
function serial(fn) {
  chain = chain.then(fn).catch((e) => console.error('[SVD]', e));
  return chain;
}

function isHttp(value) {
  try {
    const p = new URL(value).protocol;
    return p === 'http:' || p === 'https:';
  } catch (e) {
    return false;
  }
}

// 'hls' and 'dash' are manifests (downloaded by the stream downloader page); everything else is a plain file.
function classify(url, mime, kindHint) {
  if (kindHint === 'hls' || kindHint === 'dash') return kindHint;
  const path = new URL(url).pathname;
  if (/\.m3u8$/i.test(path) || /mpegurl/i.test(mime)) return 'hls';
  if (/\.mpd$/i.test(path) || /dash\+xml/i.test(mime)) return 'dash';
  return 'file';
}

function cleanName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120);
}

// Builds a safe, relative filename. Files always end in a media extension; streams keep
// .m3u8/.mpd. Order: <a download> hint, URL path name, page title (only if the URL name is
// generic like "index"), hostname.
function makeFilename(url, mime, kind, media, hint, title) {
  const u = new URL(url);
  let name = u.pathname.split('/').filter(Boolean).pop() || '';
  try { name = decodeURIComponent(name); } catch (e) { /* keep raw */ }
  name = cleanName(name);

  const hinted = cleanName(hint);
  if (hinted) name = hinted;
  else if (name && GENERIC_NAME.test(name.replace(/\.[^.]*$/, '')) && cleanName(title)) name = cleanName(title);
  if (!name) name = cleanName(u.hostname) || 'video';

  if (kind === 'hls') return /\.m3u8$/i.test(name) ? name : name + '.m3u8';
  if (kind === 'dash') return /\.mpd$/i.test(name) ? name : name + '.mpd';
  if (FILE_EXT.test(name)) return name;
  const hit = MIME_EXT.find(([re]) => re.test(mime || ''));
  return name + (hit ? hit[1] : media === 'audio' ? '.mp3' : '.mp4');
}

async function save(tabId, list) {
  await chrome.storage.session.set({ [keyFor(tabId)]: list });
  try {
    await chrome.action.setBadgeText({ tabId, text: list.length ? String(list.length) : '' });
  } catch (e) { /* tab may already be closed */ }
}

// Segmented streams fetched by a player look like dozens of files named seg-1, seg-2 ...
// If three network-sniffed URLs share one name pattern we treat them as segments and drop them.
const blocked = new Set(); // `${tabId}|${patternKey}`
const BURST = 3;


// Many CDNs (HTTP 412/403) only serve a manifest or segment when the request looks like it came from the
// website's own page. Requests made by this extension (popup, download tab) would carry no such Referer/Origin,
// so for every media host we find, a session rule sets them to the page the media was found on.
// It only touches requests started by this extension itself (initiatorDomains), never the browsing itself.
async function allowHost(tabId, mediaUrl, refOrigin) {
  try {
    let origin = refOrigin && /^https?:\/\/[^/]+$/i.test(refOrigin) ? refOrigin : '';
    if (!origin) {
      const tab = await chrome.tabs.get(tabId);
      if (!tab || !isHttp(tab.url || '')) return;
      origin = new URL(tab.url).origin;
    }
    const host = new URL(mediaUrl).hostname;
    let id = 7;
    for (const c of host) id = (id * 31 + c.charCodeAt(0)) % 2147483000;
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [id + 1],
      addRules: [{
        id: id + 1, priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [
          { header: 'Referer', operation: 'set', value: origin + '/' },
          { header: 'Origin', operation: 'set', value: origin },
        ] },
        condition: { requestDomains: [host], initiatorDomains: [chrome.runtime.id], resourceTypes: ['xmlhttprequest', 'media', 'other'] },
      }],
    });
  } catch (e) { /* tab gone or unsupported */ }
}

// The download tab (downloader.html?ref=<site>) asks for the same Referer/Origin on EVERY host it fetches from
// (manifest, segments, keys often sit on different CDN hosts). The rule is tied to that one tab.
async function refRuleForTab(downloadTabId, ref) {
  if (!/^https?:\/\/[^/]+$/i.test(ref || '')) return;
  const id = 1000000 + downloadTabId;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id, priority: 2,
      action: { type: 'modifyHeaders', requestHeaders: [
        { header: 'Referer', operation: 'set', value: ref + '/' },
        { header: 'Origin', operation: 'set', value: ref },
      ] },
      condition: { tabIds: [downloadTabId], resourceTypes: ['xmlhttprequest', 'media', 'other'] },
    }],
  });
}

// YouTube-style adaptive track: the address says it is video-only or audio-only (mime=video/..., mime=audio/...).
// Muxed formats (picture and sound in one file) are excluded: they need no pairing.
const MUXED_ITAGS = new Set(['5', '6', '13', '17', '18', '22', '34', '35', '36', '37', '38', '43', '44', '45', '46', '59', '78']);
function adaptiveTrack(href) {
  try {
    const u = new URL(href);
    return /^(audio|video)\//i.test(u.searchParams.get('mime') || '') && !!u.searchParams.get('id') && !MUXED_ITAGS.has(u.searchParams.get('itag') || '');
  } catch (e) { return false; }
}

async function addVideo(tabId, video, refOrigin) {
  if (!video || typeof video.url !== 'string') return;
  if (video.url.length > MAX_URL_LENGTH || !isHttp(video.url)) return;

  const k = keyFor(tabId);
  const stored = await chrome.storage.session.get(k);
  let list = stored[k] || [];
  if (list.length >= MAX_PER_TAB || list.some((v) => v.url === video.url || (v.parts && v.parts.includes(video.url)))) return;

  const mime = String(video.mime || '').slice(0, 100);
  const kindHint = video.kindHint === 'hls' || video.kindHint === 'dash' ? video.kindHint : '';
  // A "pair" is a complete video-only file plus a complete audio-only file; they are merged on download.
  const audioUrl = typeof video.audioUrl === 'string' && video.audioUrl.length <= MAX_URL_LENGTH && isHttp(video.audioUrl) ? video.audioUrl : '';
  const kind = audioUrl ? 'pair' : classify(video.url, mime, kindHint);
  const source = String(video.source || '').slice(0, 20);

  if (source === 'webreq' && kind === 'file' && !video.split && !adaptiveTrack(video.url)) {     // (a range-stripped track is a whole track, never a segment)
    const pk = Sniff.patternKey(video.url);
    const bk = tabId + '|' + pk;
    if (blocked.has(bk)) return;
    const same = list.filter((v) => v.source === 'webreq' && v.kind === 'file' && !v.split && Sniff.patternKey(v.url) === pk);
    if (same.length + 1 >= BURST) {
      blocked.add(bk);
      await save(tabId, list.filter((v) => !same.includes(v)));
      return;
    }
  }

  const media = video.media === 'audio' || AUDIO_EXT.test(new URL(video.url).pathname) || /^audio\//i.test(new URL(video.url).searchParams.get('mime') || '') ? 'audio' : 'video';
  const entry = {
    url: video.url,
    filename: makeFilename(video.url, mime, kind === 'pair' ? 'file' : kind, media, video.hint, video.title),
    source,
    kind,
    media,
    note: String(video.note || '').slice(0, 200),
    downloadable: true,
  };
  if (audioUrl) entry.audioUrl = audioUrl;
  if (kind === 'file' && (video.split || adaptiveTrack(video.url))) {   // one half of a split stream: remember how to pair it
    entry.split = true;
    entry.total = Number.isFinite(video.total) && video.total > 0 ? Math.floor(video.total) : 0;
    entry.key = String(video.key || '').slice(0, 64);
    entry.duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;   // Instagram/Facebook: seconds, from the address
    entry.at = Date.now();
  }
  if (/^https?:\/\/[^/]+$/i.test(refOrigin || '')) entry.ref = refOrigin.slice(0, 200);
  list.push(entry);
  await allowHost(tabId, entry.url, refOrigin);
  if (audioUrl) await allowHost(tabId, audioUrl, refOrigin);
  await save(tabId, autoPair(list));
}

// Video-only and audio-only halves of a split stream that were sniffed separately become ONE entry
// ("Video + audio"), which the download tab fetches and merges. With a shared stream id (YouTube) the
// biggest video and the biggest audio are taken and the smaller alternatives are dropped; without one
// they are paired in the order they were found.
// Instagram "progressive" files already hold picture AND sound; pairing one with an audio track would give two sound tracks.
const isProgressive = (u) => { try { const e = new URL(u).searchParams.get('efg'); return !!e && /progressive/i.test(atob(e.replace(/-/g, '+').replace(/_/g, '/'))); } catch (err) { return false; } };
function autoPair(list) {
  const groups = new Map();
  for (const v of list) {
    if (!v.split || v.kind !== 'file' || v.audioUrl) continue;
    const g = groups.get(v.key) || { key: v.key, v: [], a: [] };
    (v.media === 'audio' ? g.a : g.v).push(v);
    groups.set(v.key, g);
  }
  let out = list;
  const NEAR = 1.5;                      // seconds: how close a track's length must be to the reel it belongs to
  for (const g of groups.values()) {
    // Instagram/Facebook: no shared id, but every track says how long it is. Several reels (and several qualities of each)
    // are loaded at once, so pair by LENGTH: the newest audio, with the biggest video of the same length. Taking the first
    // video and first audio found is what made the wrong reel download.
    while (!g.key && g.a.some((x) => x.duration) && g.v.some((x) => x.duration && !isProgressive(x.url))) {
      const a = g.a.filter((x) => x.duration).sort((x, y) => (y.at || 0) - (x.at || 0))[0];
      const vs = g.v.filter((x) => x.duration && !isProgressive(x.url) && Math.abs(x.duration - a.duration) <= NEAR);
      if (!vs.length) { g.a = g.a.filter((x) => x !== a); continue; }          // its picture has not been seen (yet)
      const v = vs.reduce((m, x) => ((x.total || 0) > (m.total || 0) ? x : m));
      const gone = new Set(vs.concat(g.a.filter((x) => x.duration && Math.abs(x.duration - a.duration) <= NEAR)));
      g.v = g.v.filter((x) => !gone.has(x)); g.a = g.a.filter((x) => !gone.has(x));
      const pair = {
        url: v.url, audioUrl: a.url, parts: [v.url, a.url], kind: 'pair', source: v.source, media: 'video',
        filename: v.filename, downloadable: true, duration: a.duration, at: Math.max(v.at || 0, a.at || 0), ref: v.ref || a.ref,
        note: 'Video and audio were found as separate tracks on this page; they are merged into one file when downloaded.',
      };
      const at = out.indexOf(v);
      out = out.map((x) => (x === v ? pair : x)).filter((x) => x === pair || !gone.has(x));
      if (at < 0) out.push(pair);
    }
    while (g.v.length && g.a.length) {
      const best = (arr) => (g.key ? arr.reduce((b, x) => ((x.total || 0) > (b.total || 0) ? x : b)) : arr[0]);
      const a = best(g.a);
      // Prefer a video in the same container as the audio (WebM + WebM = one file that plays everywhere);
      // MP4 video + Opus audio is merged too, but not every desktop player plays Opus inside MP4.
      const cont = (x) => { try { return /webm/i.test(new URL(x.url).searchParams.get('mime') || '') ? 'webm' : 'other'; } catch (e) { return 'other'; } };
      const same = g.v.filter((x) => cont(x) === cont(a));
      const v = g.key ? best(same.length ? same : g.v) : best(g.v);
      const gone = g.key ? new Set(g.v.concat(g.a)) : new Set([v, a]);
      g.v = g.key ? [] : g.v.filter((x) => x !== v);
      g.a = g.key ? [] : g.a.filter((x) => x !== a);
      const pair = {
        url: v.url, audioUrl: a.url, parts: [v.url, a.url], kind: 'pair', source: v.source, media: 'video',
        filename: v.filename, downloadable: true,
        note: 'Video and audio were found as separate tracks on this page; they are merged into one file when downloaded.',
      };
      const at = out.indexOf(v);
      out = out.map((x) => (x === v ? pair : x)).filter((x) => x === pair || !gone.has(x));
      if (at < 0) out.push(pair);
    }
  }
  return out;
}

// Blob/MediaSource captures live inside the page. We only keep a small description here;
// the bytes stay in the page until the user presses Download.
const num = (n) => (Number.isFinite(n) && n >= 0 ? n : 0);
async function upsertCapture(tabId, frameId, cap, title) {
  if (!cap || !Number.isInteger(cap.id) || !Array.isArray(cap.tracks) || cap.tracks.length > 8) return;
  const url = `capture://${frameId}/${cap.id}`;
  const tracks = cap.tracks.map((t) => ({
    role: ['audio', 'video', 'media'].includes(t.role) ? t.role : 'media',
    bytes: num(t.bytes), covered: num(t.covered), parts: Math.max(1, Math.min(99, num(t.parts))),
  }));
  const k = keyFor(tabId);
  const stored = await chrome.storage.session.get(k);
  const list = stored[k] || [];
  const entry = {
    url, kind: 'capture', source: 'blob', media: tracks.every((t) => t.role === 'audio') ? 'audio' : 'video',
    filename: (cleanName(title) || 'video') + '.mp4',
    frameId, captureId: cap.id, downloadable: !cap.protected,
    note: '',
    capture: {
      bytes: tracks.reduce((n, t) => n + t.bytes, 0),
      covered: Math.min(...tracks.map((t) => t.covered)),
      duration: num(cap.duration), protected: !!cap.protected, truncated: !!cap.truncated, whole: !!cap.whole,
      job: cap.job && ['loading', 'done', 'failed', 'canceled'].includes(cap.job.phase)
        ? { phase: cap.job.phase, message: String(cap.job.message || '').slice(0, 300) } : null,
      parts: Math.max(...tracks.map((t) => t.parts)), tracks,
    },
  };
  const i = list.findIndex((v) => v.url === url);
  if (i >= 0) list[i] = entry;
  else if (list.length < MAX_PER_TAB) list.push(entry);
  else return;
  await save(tabId, list);
}

async function removeVideo(tabId, url) {
  const k = keyFor(tabId);
  const stored = await chrome.storage.session.get(k);
  await save(tabId, (stored[k] || []).filter((v) => v.url !== url));
}

// ---- corner icon on a video (content.js): download this one address ----
function friendlyDownloadError(code) {
  code = String(code || '');
  if (/FORBIDDEN|UNAUTHORIZED/.test(code)) return 'The server refused the request (login or hotlink protection).';
  if (/BAD_CONTENT|FILE_NOT_FOUND/.test(code)) return 'The file was not found on the server.';
  if (/^NETWORK|SERVER_FAILED|TIMEOUT/.test(code)) return 'Network error. Check your connection and try again.';
  if (/FILE_/.test(code)) return 'Could not save the file to disk (' + code + ').';
  if (code === 'USER_CANCELED') return 'Download canceled.';
  return 'Download failed' + (code ? ' (' + code + ')' : '') + '.';
}

// For a blob: video the real file/stream was usually seen on the network. Pick the best such entry
// for this tab (merged pair > HLS/DASH > plain video file); captures are never used here.
async function networkEntryFor(tabId, duration) {
  const k = keyFor(tabId);
  const list = ((await chrome.storage.session.get(k))[k] || []).filter((v) => v.kind !== 'capture' && v.downloadable !== false);
  const last = (f) => list.filter(f).pop();
  // Instagram/Facebook: the reel on screen is the pair whose length matches the player's (newest if several match).
  if (Number.isFinite(duration) && duration > 0) {
    const m = list.filter((v) => v.kind === 'pair' && v.duration && Math.abs(v.duration - duration) <= 1.5).sort((x, y) => (x.at || 0) - (y.at || 0)).pop();
    if (m) return m;
  }
  return last((v) => v.kind === 'pair') ||
    last((v) => (v.kind === 'hls' || v.kind === 'dash')) ||
    last((v) => v.kind === 'file' && v.media !== 'audio' && !v.split) || null;   // a lone split track (video only, no sound) is never used: the playback capture merges picture and sound
}

async function overlayDownload(tabId, frameId, msg) {
  let url = typeof msg.url === 'string' ? msg.url.split('#')[0] : '';
  let entry = null;
  if (/^blob:/i.test(url)) {                                // playback source: look for what was sniffed on the network
    entry = await networkEntryFor(tabId, Number(msg.duration));
    if (!entry) return { ok: false, noNetwork: true, error: 'No network file found for this video.' };
    url = entry.url;
  }
  if (!url || url.length > MAX_URL_LENGTH || !isHttp(url)) return { ok: false, error: 'This video has no downloadable web address.' };
  const kind = entry ? entry.kind : classify(url, '', '');  // 'file', 'hls', 'dash' or 'pair'
  const given = typeof msg.name === 'string' && /^[\w.-]{1,100}$/.test(msg.name) ? msg.name : '';
  const filename = entry ? entry.filename : given || makeFilename(url, '', kind, 'video', '', String(msg.title || '').slice(0, 100));
  if (kind === 'pair') {
    const q = new URLSearchParams({ url, audio: entry.audioUrl, name: filename, ref: entry.ref || '' });
    await chrome.tabs.create({ url: chrome.runtime.getURL('downloader/downloader.html') + '?' + q });
    return { ok: true, message: 'Video + audio download opened in a new tab.' };
  }
  if (kind === 'hls' || kind === 'dash') {
    // HLS/DASH run in their own tab (progress and the saved file are handled there).
    const q = new URLSearchParams({ url, quality: 'best', name: filename, ref: (entry && entry.ref) || msg.ref || '' });
    await chrome.tabs.create({ url: chrome.runtime.getURL('downloader/downloader.html') + '?' + q });
    return { ok: true, message: 'Stream download opened in a new tab.' };
  }
  let id;
  try {
    id = await chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
  } catch (e) {
    if (/filename/i.test(e.message)) id = await chrome.downloads.download({ url });   // let the browser pick a name
    else throw e;
  }
  // Remember who asked, so a failure after the download started (HTTP 403, network drop) can be reported.
  if (id !== undefined) await chrome.storage.session.set({ ['dl_' + id]: { tabId, frameId } });
  return { ok: true, downloadId: id, message: 'Download started: ' + filename };
}

if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener(async (delta) => {
    const failed = delta.error && delta.error.current;
    if (!failed && !(delta.state && delta.state.current === 'complete')) return;
    const k = 'dl_' + delta.id;
    const stored = await chrome.storage.session.get(k);
    if (!stored[k]) return;                                  // not one of ours
    await chrome.storage.session.remove(k);
    const { tabId, frameId } = stored[k];
    chrome.tabs.sendMessage(tabId, {
      type: 'overlay-status', downloadId: delta.id, ok: !failed,
      message: failed ? friendlyDownloadError(failed) : 'Download complete.',
    }, { frameId }).catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;
  const tabId = sender.tab && sender.tab.id;
  if (msg.type === 'ref-rule' && sender.id === chrome.runtime.id && sender.url && sender.url.startsWith(chrome.runtime.getURL('downloader/')) && typeof tabId === 'number') {
    refRuleForTab(tabId, msg.ref).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: false }));
    return true;
  }
  if (typeof tabId === 'number' && tabId >= 0) {
    // From a content script.
    if (msg.type === 'reset' && sender.frameId === 0) {
      for (const b of Array.from(blocked)) if (b.startsWith(tabId + '|')) blocked.delete(b);
      serial(() => save(tabId, []));
    }
    else if (msg.type === 'video-found') { let o = ''; try { o = new URL(sender.url).origin; } catch (e) { /* about:blank */ } serial(() => addVideo(tabId, msg.video, o)); }
    else if (msg.type === 'capture-update') serial(() => upsertCapture(tabId, sender.frameId || 0, msg.capture, msg.title));
    else if (msg.type === 'capture-gone' && Number.isInteger(msg.id)) serial(() => removeVideo(tabId, `capture://${sender.frameId || 0}/${msg.id}`));
    else if (msg.type === 'overlay-download' && typeof sendResponse === 'function') {
      // The corner icon on a video: download exactly this address (answered asynchronously).
      overlayDownload(tabId, sender.frameId || 0, msg).then(sendResponse, (e) => sendResponse({ ok: false, error: friendlyDownloadError(e && e.message) }));
      return true;
    }
  } else if (sender.id === chrome.runtime.id && Number.isInteger(msg.tabId) && msg.tabId >= 0) {
    // From our own popup (no sender.tab).
    if (msg.type === 'clear') serial(() => save(msg.tabId, []));
    else if (msg.type === 'remove' && typeof msg.url === 'string') serial(() => removeVideo(msg.tabId, msg.url));
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [1000000 + tabId] }).catch(() => {});
  serial(() => chrome.storage.session.remove(keyFor(tabId)));
});

// Read-only look at response headers. Finds media whose URL says nothing (no extension,
// signed/opaque paths) and manifests served with a generic name. Nothing is blocked or changed.
function header(headers, name) {
  const h = (headers || []).find((x) => x.name && x.name.toLowerCase() === name);
  return h ? h.value || '' : '';
}
if (chrome.webRequest && chrome.webRequest.onHeadersReceived) {
  chrome.webRequest.onHeadersReceived.addListener((d) => {
    if (!d || typeof d.tabId !== 'number' || d.tabId < 0) return;
    const r = Sniff.judgeResponse({
      url: d.url, status: d.statusCode, type: d.type,
      mime: header(d.responseHeaders, 'content-type'),
      length: parseInt(header(d.responseHeaders, 'content-length'), 10),
      range: header(d.responseHeaders, 'content-range'),
    });
    if (!r.ok) return;
    // Requests made by a real <video>/<audio> element are trusted; others may be segments.
    const source = d.type === 'media' && !r.note ? 'media' : 'webreq';
    serial(() => addVideo(d.tabId, { url: r.url, mime: r.mime, kindHint: r.kindHint, media: r.media, note: r.note, source, split: r.split, total: r.total, key: r.key, duration: r.duration }, d.initiator));
  }, { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] }, ['responseHeaders']);
}
