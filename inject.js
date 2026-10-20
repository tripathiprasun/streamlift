// Runs inside the PAGE itself (manifest "world": "MAIN"), before the page's own scripts.
// It only observes: it never changes what the page sends or receives.
//   1. fetch / XMLHttpRequest: reads API responses to find video URLs and manifests that
//      are never present in the DOM (JSON with video_versions, playable_url, embedded DASH...).
//   2. MediaSource / SourceBuffer: records the bytes a player feeds to a blob: video, so a
//      "blob:" video can be saved. Encrypted (EME/DRM) playback is detected and refused.
//   3. URL.createObjectURL: blob: videos that are complete files are captured as they are.
//   4. On Download, a capture that is not complete is completed by making the player load
//      the missing parts itself (muted, fast, seeking into the gaps), then the video and audio
//      tracks are merged into one MP4 (lib/mux.js) and saved.
// Results go to content.js (isolated world) with window.postMessage.
(() => {
  'use strict';
  const g = window;
  if (g.__svd_injected) return;
  try { Object.defineProperty(g, '__svd_injected', { value: true }); } catch (e) { return; }
  const S = g.SVDSniff, Mux = g.SVDMux, Webm = g.SVDWebm;
  try { delete g.SVDSniff; delete g.SVDMux; delete g.SVDWebm; } catch (e) { /* leave nothing global if we can */ }
  if (!S) return;

  // YouTube: ask for WebM. YouTube sends AV1/H.264 in MP4 when the browser says it can play them, and then picture
  // (MP4) and sound (WebM/Opus) are different containers. When the page is told that MP4 codecs are not
  // available, it picks VP9 + Opus, both WebM, which this extension merges into one clean .webm (lib/webm.js).
  // Only on YouTube hosts, and only if this browser really plays VP9 + Opus; playback itself is unaffected.
  try {
    if (/(^|\.)(youtube\.com|youtube-nocookie\.com)$/i.test(g.location.hostname) && g.MediaSource && g.MediaSource.isTypeSupported &&
        g.MediaSource.isTypeSupported('video/webm; codecs="vp9"') && g.MediaSource.isTypeSupported('audio/webm; codecs="opus"')) {
      const mp4 = /(^|[\s;,])(video|audio)\/mp4|avc1|av01|hev1|hvc1|mp4a/i;
      const origIts = g.MediaSource.isTypeSupported.bind(g.MediaSource);
      g.MediaSource.isTypeSupported = function (type) { return mp4.test(String(type)) ? false : origIts(type); };
      const origCpt = g.HTMLMediaElement.prototype.canPlayType;
      g.HTMLMediaElement.prototype.canPlayType = function (type) { return mp4.test(String(type)) ? '' : origCpt.call(this, type); };
    }
  } catch (e) { /* never break the page */ }

  const MAX_BODY = 5 * 1024 * 1024;           // largest API response we will read as text
  const MAX_CAPTURE_BYTES = 2 * 1024 ** 3;    // per captured video
  const MAX_CAPTURES = 6;                     // older captures are dropped (memory)
  const BATCH_BYTES = 4 * 1024 * 1024;        // small chunks are merged into Blobs of about this size

  const post = (msg) => { try { g.postMessage(Object.assign({ svd: 1 }, msg), '*'); } catch (e) { /* ignore */ } };
  const abs = (u) => { try { return new URL(u, g.location.href).href; } catch (e) { return ''; } };

  // ---------------------------------------------------------------- 1. fetch / XHR ----
  const sent = new Set();
  function found(item) {
    const url = abs(item.url);
    if (!url || sent.has(url) || sent.size > 2000) return;
    sent.add(url);
    post({ type: 'found', url, mime: item.mime || '', kindHint: item.kind || '', media: item.media || '', note: item.note || '', audioUrl: item.audioUrl ? abs(item.audioUrl) : '' });
  }
  function foundJson(value) {
    for (const m of S.findMedia(value)) found(m);
  }
  function handleText(url, text) {
    if (!text) return;
    const kind = S.sniffManifestText(text);
    if (kind) return found({ url, kind });
    if (text.length > MAX_BODY || !S.mightHaveMedia(text)) return;
    for (const v of S.parseJsonLoose(text)) foundJson(v);
  }

  const TEXTISH = /json|javascript|text\/plain|[+/]xml|octet-stream/i;

  function inspectFetch(res, reqUrl) {
    const ct = (res.headers && res.headers.get('content-type')) || '';
    const url = res.url || reqUrl;
    const cls = S.classifyMime(ct);
    if (cls === 'hls' || cls === 'dash') return found({ url, kind: cls });
    if (!TEXTISH.test(ct) || /event-stream|html/i.test(ct)) return;
    const len = parseInt(res.headers.get('content-length') || '', 10);
    const isJson = /json/i.test(ct);
    if (Number.isFinite(len) ? len > MAX_BODY : !isJson) return;       // unknown size: only JSON
    if (/octet-stream/i.test(ct) && !(len <= 2e6)) return;             // never read unknown/large binaries
    res.clone().text().then((t) => handleText(url, t)).catch(() => {});
  }

  if (typeof g.fetch === 'function') {
    const origFetch = g.fetch;
    g.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const a = args[0];
        const reqUrl = a && typeof a === 'object' && 'url' in a ? a.url : String(a);
        p.then((res) => { try { inspectFetch(res, reqUrl); } catch (e) { /* ignore */ } }, () => {});
      } catch (e) { /* never break the page */ }
      return p;
    };
  }

  if (typeof g.XMLHttpRequest === 'function') {
    const proto = g.XMLHttpRequest.prototype;
    const origOpen = proto.open, origSend = proto.send;
    const urls = new WeakMap(), hooked = new WeakSet();
    const inspectXhr = (x) => {
      try {
        if (x.status !== 200) return;
        const ct = x.getResponseHeader('content-type') || '';
        const url = x.responseURL || urls.get(x) || '';
        const cls = S.classifyMime(ct);
        if (cls === 'hls' || cls === 'dash') return found({ url, kind: cls });
        if (!TEXTISH.test(ct) || /event-stream|html/i.test(ct)) return;
        const t = x.responseType;
        if (t === '' || t === 'text') handleText(url, x.responseText);
        else if (t === 'json') { if (x.response && S.mightHaveMedia(JSON.stringify(x.response).slice(0, MAX_BODY))) foundJson(x.response); }
        else if (t === 'arraybuffer' && x.response && x.response.byteLength <= MAX_BODY) {
          handleText(url, new TextDecoder().decode(x.response));
        }
      } catch (e) { /* ignore */ }
    };
    proto.open = function (method, url) {
      try { urls.set(this, String(url)); } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    proto.send = function () {
      try {
        if (!hooked.has(this)) { hooked.add(this); this.addEventListener('loadend', () => inspectXhr(this)); }
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  // ------------------------------------------------- 2. MediaSource (blob: video) ----
  const captures = new Map();          // id -> capture
  const blobToMs = new Map();          // blob: URL -> MediaSource
  const msToCapture = new WeakMap();   // MediaSource -> capture
  const sbToTrack = new WeakMap();     // SourceBuffer -> track
  const drmElements = [];              // media elements that had MediaKeys attached
  let nextId = 1, reportTimer = null;

  const newPart = () => ({ chunks: [], pending: [], pendingBytes: 0, bytes: 0, open: null, cuts: [] });

  // A player that aborts a half-appended segment (seek, quality change, cancelled request) and later appends the
  // whole segment again leaves an INCOMPLETE mp4 box in the stream. Read back as a file, that unfinished mdat
  // swallows the next fragment's header and part of its frames, which is what makes picture freeze and sound
  // drop. So: follow the top-level mp4 boxes while they are appended; when a new chunk starts with a box header
  // while the previous box is still unfinished, remember the unfinished bytes as a range to cut out.
  const TOP_BOX = /^(moof|styp|sidx|emsg|ftyp|moov|prft)$/;
  function trackBoxes(part, view) {
    try {
      let pos = 0;
      const at = part.bytes;                                  // stream offset where this chunk begins
      const be32 = (o) => ((view[o] << 24) | (view[o + 1] << 16) | (view[o + 2] << 8) | view[o + 3]) >>> 0;
      const tag = (o) => String.fromCharCode(view[o + 4], view[o + 5], view[o + 6], view[o + 7]);
      if (part.open && view.length >= 8 && be32(0) >= 8 && TOP_BOX.test(tag(0))) {
        part.cuts.push([part.open.start, at]);                // the unfinished box can never be completed
        part.open = null;
      }
      while (pos < view.length) {
        if (part.open) {
          const left = part.open.end - (at + pos);
          if (left > view.length - pos) return;               // still unfinished
          pos += left; part.open = null; continue;
        }
        if (view.length - pos < 8) return;
        const size = be32(pos);
        if (size < 8) return;                                  // 64-bit / open-ended / not an mp4 box: stop tracking
        if (!/^[a-z0-9 ]{4}$/i.test(tag(pos))) return;         // not an mp4 box (WebM etc.): stop tracking
        if (pos + size > view.length) { part.open = { start: at + pos, end: at + pos + size }; return; }
        pos += size;
      }
    } catch (e) { part.open = null; }
  }
  function flush(part) {
    if (part.pending.length) { part.chunks.push(new Blob(part.pending)); part.pending = []; part.pendingBytes = 0; }
  }

  function isProtected(c) {
    if (c.protected) return true;
    if (!c.ms) return false;
    return drmElements.some((el) => { try { return blobToMs.get(el.currentSrc || el.src) === c.ms; } catch (e) { return false; } });
  }
  function totalBytes(c) { return c.tracks.reduce((n, t) => n + t.bytes, 0); }

  function summary(c) {
    let duration = 0;
    try { if (c.ms && Number.isFinite(c.ms.duration)) duration = c.ms.duration; } catch (e) { /* ignore */ }
    return {
      id: c.id, whole: !!c.whole, protected: isProtected(c), truncated: c.truncated, duration,
      job: c.job ? { phase: c.job.phase, message: c.job.message } : null,
      tracks: c.tracks.map((t) => ({ role: t.role, mime: t.mime.slice(0, 120), bytes: t.bytes, covered: S.rangeTotal(t.covered), parts: t.parts.length })),
    };
  }
  function report(c) { if (totalBytes(c) > 0) post({ type: 'capture', capture: summary(c) }); }
  function scheduleReport() {
    if (reportTimer) return;
    reportTimer = setTimeout(() => {
      reportTimer = null;
      captures.forEach(report);
    }, 1500);
  }

  function addCapture(c) {
    captures.set(c.id, c);
    while (captures.size > MAX_CAPTURES) {
      const oldest = captures.keys().next().value;
      captures.delete(oldest);
      post({ type: 'capture-gone', id: oldest });
    }
  }

  function captureFor(ms) {
    let c = msToCapture.get(ms);
    if (!c) { c = { id: nextId++, ms, tracks: [], protected: false, truncated: false }; msToCapture.set(ms, c); addCapture(c); }
    return c;
  }

  function onAppend(c, t, data) {
    if (c.truncated) return;
    let view;
    try { view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data); }
    catch (e) { return; }
    if (!view.length) return;
    if (totalBytes(c) + view.length > MAX_CAPTURE_BYTES) { c.truncated = true; scheduleReport(); return; }
    const copy = view.slice();                      // the page may reuse its buffer
    const fp = S.fingerprint(copy);
    if (S.isInitSegment(copy)) {
      // Each distinct init segment starts its own standalone part (a quality switch).
      // Seeing an init we already have just switches back to that part.
      if (t.initParts.has(fp)) { t.cur = t.initParts.get(fp); return; }
      if (t.cur.bytes > 0) { const p = newPart(); t.parts.push(p); t.cur = p; }
      t.initParts.set(fp, t.cur);
      t.seen.add(fp);
    } else {
      if (t.seen.has(fp)) return;                   // same segment appended again (seek, buffer eviction)
      t.seen.add(fp);
    }
    const part = t.cur;
    trackBoxes(part, copy);
    part.pending.push(copy);
    part.pendingBytes += copy.length;
    part.bytes += copy.length;
    t.bytes += copy.length;
    if (part.pendingBytes >= BATCH_BYTES) flush(part);
    scheduleReport();
  }

  if (typeof g.MediaSource === 'function' && g.MediaSource.prototype) {
    const origAdd = g.MediaSource.prototype.addSourceBuffer;
    g.MediaSource.prototype.addSourceBuffer = function (mime) {
      const sb = origAdd.apply(this, arguments);
      try {
        const c = captureFor(this);
        const first = newPart();
        const t = { mime: String(mime), role: S.roleOfMime(mime), bytes: 0, parts: [first], cur: first, initParts: new Map(), seen: new Set(), covered: [] };
        c.tracks.push(t);
        sbToTrack.set(sb, { c, t });
        sb.addEventListener('updateend', () => {
          try {
            const b = sb.buffered;
            for (let i = 0; i < b.length; i++) t.covered = S.addRange(t.covered, b.start(i), b.end(i));
          } catch (e) { /* SourceBuffer removed */ }
        });
      } catch (e) { /* never break the page */ }
      return sb;
    };
  }
  if (typeof g.SourceBuffer === 'function' && g.SourceBuffer.prototype) {
    const origAppend = g.SourceBuffer.prototype.appendBuffer;
    g.SourceBuffer.prototype.appendBuffer = function (data) {
      try { const e = sbToTrack.get(this); if (e) onAppend(e.c, e.t, data); } catch (err) { /* ignore */ }
      return origAppend.apply(this, arguments);
    };
  }

  // Encrypted playback: we never capture it. Mark it so the popup can say why.
  function markProtected(el) {
    try {
      if (el && drmElements.indexOf(el) < 0) drmElements.push(el);
      const ms = blobToMs.get(el && (el.currentSrc || el.src));
      const c = ms && msToCapture.get(ms);
      if (c) { c.protected = true; scheduleReport(); }
    } catch (e) { /* ignore */ }
  }
  try {
    g.document.addEventListener('encrypted', (e) => markProtected(e.target), true);
  } catch (e) { /* ignore */ }
  if (typeof g.HTMLMediaElement === 'function' && g.HTMLMediaElement.prototype.setMediaKeys) {
    const origSet = g.HTMLMediaElement.prototype.setMediaKeys;
    g.HTMLMediaElement.prototype.setMediaKeys = function (keys) {
      if (keys) markProtected(this);
      return origSet.apply(this, arguments);
    };
  }

  // -------------------------------------------- 3. blob: URLs (MediaSource or a file) ----
  const origCreate = g.URL && g.URL.createObjectURL; // also used to save, so our own downloads are not "captured"
  if (typeof origCreate === 'function') {
    g.URL.createObjectURL = function (obj) {
      const url = origCreate.apply(this, arguments);
      try {
        if (typeof g.MediaSource === 'function' && obj instanceof g.MediaSource) {
          blobToMs.set(url, obj);
        } else if (typeof g.Blob === 'function' && obj instanceof g.Blob && obj.size >= 50000) {
          const consider = (type) => {
            if (!/^(video|audio)\//i.test(type) || /mp2t/i.test(type)) return;
            const c = { id: nextId++, whole: true, blobUrl: url, tracks: [], protected: false, truncated: false };
            const whole = { chunks: [obj], pending: [], pendingBytes: 0, bytes: obj.size };
            c.tracks.push({ mime: type, role: S.classifyMime(type) === 'audio' ? 'audio' : 'media', bytes: obj.size, parts: [whole], cur: whole, initParts: new Map(), seen: new Set(), covered: [] });
            addCapture(c);
            report(c);
          };
          if (obj.type) consider(obj.type);
          else obj.slice(0, 16).arrayBuffer().then((b) => { // untyped blob: look at the bytes
            const u = new Uint8Array(b);
            if (S.isInitSegment(u)) consider('video/mp4');
          }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return url;
    };
  }

  // ------------------------------------ corner icon on a video (content.js asks) ----
  // content.js (isolated world) dispatches an 'svd-pick' event on the <video> whose corner icon
  // was clicked. DOM nodes are shared between worlds, so e.target is that very element, and we
  // can answer which capture (if any) belongs to it. Nothing is sent to the page.
  function captureOfElement(el) {
    try {
      const u = el.currentSrc || el.src;
      if (!u) return null;
      const ms = blobToMs.get(u);
      const viaMs = ms && msToCapture.get(ms);
      if (viaMs) return viaMs;
      for (const c of captures.values()) if (c.blobUrl && c.blobUrl === u) return c;   // a whole-file Blob
    } catch (e) { /* ignore */ }
    return null;
  }
  try {
    g.document.addEventListener('svd-pick', (e) => {
      const el = e.target;
      const c = el && el.tagName === 'VIDEO' ? captureOfElement(el) : null;
      post({ type: 'pick-result', id: c ? c.id : 0, protected: c ? isProtected(c) : false, bytes: c ? totalBytes(c) : 0 });
    }, true);
  } catch (e) { /* ignore */ }

  // ---------------------------------------------------------- save (from the popup) ----
  function saveBlob(blob, filename) {
    const a = g.document.createElement('a');
    const href = origCreate.call(g.URL, blob);
    a.href = href;
    a.download = filename;
    a.style.display = 'none';
    (g.document.body || g.document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => { a.remove(); g.URL.revokeObjectURL(href); }, 60000);
  }

  const extOf = (t) => (/webm|matroska/i.test(t.mime) ? 'webm' : t.role === 'audio' ? 'm4a' : 'mp4');

  // Turns a capture into files. Fragments are put in time order (a seeking player appends them
  // out of order); a video track + an audio track become ONE merged MP4 when possible.
  // Resolves {files:[{name, blob}], merged, note}.
  async function buildFiles(c, base) {
    const used = c.tracks.filter((t) => t.bytes > 0);
    const note = [];
    const prepared = [];   // {track, partBlobs:[Blob]}
    for (const t of used) {
      t.parts.forEach(flush);
      const type = t.mime.split(';')[0] || 'application/octet-stream';
      const blobs = [];
      for (const p of t.parts.filter((x) => x.bytes > 0)) {
        let b = new Blob(p.chunks, { type });
        if (p.cuts && p.cuts.length) {                         // drop the unfinished boxes (see trackBoxes)
          const keep = []; let from = 0;
          for (const [a, z] of p.cuts.slice().sort((x, y) => x[0] - y[0])) { if (a > from) keep.push(b.slice(from, a)); from = Math.max(from, z); }
          keep.push(b.slice(from));
          b = new Blob(keep, { type });
        }
        if (Mux && extOf(t) !== 'webm' && !c.whole) { try { b = await Mux.reorderFragments(b); } catch (e) { /* keep as captured */ } }
        blobs.push(b);
      }
      prepared.push({ t, blobs });
    }
    const video = prepared.find((x) => x.t.role === 'video'), audio = prepared.find((x) => x.t.role === 'audio');
    const container = (x) => (extOf(x.t) === 'webm' ? 'webm' : 'mp4');
    const switched = prepared.some((x) => x.blobs.length > 1);        // the player changed quality while loading
    // WebM can change picture size inside one video stream, so quality parts become ONE file.
    const switchNote = 'The player changed quality while loading, so the picture changes quality partway through.';
    try {
      if (prepared.length === 2 && video && audio && container(video) === container(audio)) {
        if (container(video) === 'webm') {
          if (!Webm) throw new Error('WebM support is missing');
          const merged = await Webm.mergeWebm(video.blobs, audio.blobs);
          return { files: [{ name: base + '.webm', blob: merged }], merged: true, note: switched ? switchNote : '' };
        }
        if (Mux && video.blobs.length === 1 && audio.blobs.length === 1) {
          const merged = await Mux.mergeMp4(video.blobs[0], audio.blobs[0]);
          return { files: [{ name: base + '.mp4', blob: merged }], merged: true, note: '' };
        }
        if (Mux && video.blobs.length > 1 && audio.blobs.length === 1) {
          // MP4 pictures of different quality cannot share one file that all players read correctly:
          // every quality part gets its own slice of the audio.
          const files = [];
          for (let i = 0; i < video.blobs.length; i++) {
            const span = await Mux.fragmentSpan(video.blobs[i]);
            const slice = await Mux.sliceFragments(audio.blobs[0], span.from, span.to);
            files.push({ name: base + '.part' + (i + 1) + '.mp4', blob: await Mux.mergeMp4(video.blobs[i], slice) });
          }
          return { files, merged: true, note: 'The player changed quality while loading. MP4 cannot hold different picture sizes in one file that every player reads correctly, so it is saved as ' + files.length + ' parts, each with sound; they play one after the other.' };
        }
        throw new Error('the audio changed quality while loading');
      } else if (prepared.length === 2 && video && audio && container(video) === 'mp4' && container(audio) === 'webm' &&
                 Mux && Webm && Webm.opusToMp4 && video.blobs.length === 1 && audio.blobs.length === 1) {
        // MP4 picture + Opus WebM sound (YouTube): the Opus frames are copied into an MP4 audio track, then merged.
        const merged = await Mux.mergeMp4(video.blobs[0], await Webm.opusToMp4(audio.blobs[0]));
        return { files: [{ name: base + '.mp4', blob: merged }], merged: true, note: '' };
      } else if (prepared.length === 1 && prepared[0].blobs.length > 1 && container(prepared[0]) === 'webm') {
        const x = prepared[0];
        return { files: [{ name: base + '.webm', blob: await Webm.mergeWebm(x.blobs, []) }], merged: false, note: switchNote };
      } else if (prepared.length === 2 && video && audio) {
        note.push('The video is ' + container(video).toUpperCase() + ' and the audio is ' + container(audio).toUpperCase() + ' (different containers), so they are saved as two files.');
      }
    } catch (e) {
      note.push('Could not merge into one file (' + (e && e.message ? e.message : e) + '), so the parts are saved separately.');
    }
    const files = [];
    const seen = {};
    for (const x of prepared) {
      const t = x.t;
      seen[t.role] = (seen[t.role] || 0) + 1;
      let suffix = t.role === 'audio' ? '.audio' : prepared.length > 1 ? '.video' : '';
      if (seen[t.role] > 1) suffix += '.' + seen[t.role];
      x.blobs.forEach((blob, i) => files.push({ name: base + suffix + (x.blobs.length > 1 ? '.part' + (i + 1) : '') + '.' + extOf(t), blob }));
    }
    return { files, merged: false, note: note.join(' ') };
  }

  // How much of the video the player has loaded, as ranges both audio and video share.
  function commonCovered(c) {
    const tracks = c.tracks.filter((t) => t.bytes > 0);
    if (!tracks.length) return [];
    return tracks.map((t) => t.covered).reduce((acc, r) => S.intersectRanges(acc, r));
  }
  const durationOf = (c) => { try { return c.ms && Number.isFinite(c.ms.duration) && c.ms.duration > 0 ? c.ms.duration : 0; } catch (e) { return 0; } };
  function isComplete(c) {
    if (c.whole) return true;
    // A track that never reported what it buffered: we cannot tell what is missing, so do not guess.
    if (c.tracks.some((t) => t.bytes > 0 && !t.covered.length)) return true;
    const dur = durationOf(c);
    return dur > 0 && !S.firstGap(commonCovered(c), 0, dur, 0.35);
  }
  function findElement(c) {
    try {
      const els = g.document.querySelectorAll('video, audio');
      for (const el of Array.from(els)) if (blobToMs.get(el.currentSrc || el.src) === c.ms) return el;
    } catch (e) { /* ignore */ }
    return null;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pct = (c) => { const d = durationOf(c); return d ? Math.min(100, Math.round((S.rangeTotal(commonCovered(c)) / d) * 100)) : 0; };

  // Makes the player load the parts that were never loaded: muted, 16x speed, seeking into
  // every gap. The element's position, volume, speed and loop setting are restored afterwards.
  // Resolves true when the whole video has been loaded.
  async function loadRest(c, el) {
    const dur = durationOf(c);
    const saved = { t: el.currentTime, paused: el.paused, muted: el.muted, rate: el.playbackRate, loop: el.loop };
    const t0 = Date.now();
    const deadline = t0 + Math.min(15 * 60 * 1000, 45000 + dur * 4000);
    let lastTotal = -1, lastGrow = t0, stalls = 0;
    try {
      el.muted = true; el.loop = false;
      while (!c.job.cancel && Date.now() < deadline) {
        const gap = S.firstGap(commonCovered(c), 0, dur, 0.35);
        if (!gap) return true;
        c.job.message = `Loading the rest of the video… ${pct(c)}%`;
        scheduleReport();
        const ct = el.currentTime;
        if (gap.start - ct > 1 || gap.start < ct - 0.3 || stalls > 0) {
          try { el.currentTime = Math.min(Math.max(0, gap.start + 0.01 + stalls * 0.5), Math.max(0, dur - 0.05)); } catch (e) { /* ignore */ }
        }
        try { el.playbackRate = 16; } catch (e) { /* ignore */ }
        try { const p = el.play(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
        await sleep(250);
        const total = S.rangeTotal(commonCovered(c));
        if (total > lastTotal + 0.01) { lastTotal = total; lastGrow = Date.now(); stalls = 0; }
        else if (Date.now() - lastGrow > 6000) {
          if (++stalls > 3) return false;
          lastGrow = Date.now();
        }
      }
      return !S.firstGap(commonCovered(c), 0, dur, 0.35);
    } finally {
      try {
        el.playbackRate = saved.rate; el.loop = saved.loop; el.muted = saved.muted;
        el.currentTime = saved.t;
        if (saved.paused) el.pause();
        else { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
      } catch (e) { /* the page may have replaced the element */ }
    }
  }

  async function saveCapture(c, base, partial) {
    const built = await buildFiles(c, base);
    if (!built.files.length) return { ok: false, error: 'Nothing has been captured yet. Play the video, then try again.' };
    built.files.forEach((f, i) => setTimeout(() => saveBlob(f.blob, f.name), i * 700));
    return { ok: true, files: built.files.map((f) => ({ name: f.name, bytes: f.blob.size })), merged: built.merged, note: built.note, partial: !!partial };
  }

  // mode 'complete' (default): finish loading first if needed. mode 'asis': save what is there.
  async function download(id, name, reqId, mode) {
    const reply = (r) => post(Object.assign({ type: 'download-result', reqId }, r));
    const c = captures.get(id);
    if (!c) return reply({ ok: false, error: 'This capture is no longer available (the page dropped it). Play the video again.' });
    if (isProtected(c)) return reply({ ok: false, error: 'This video uses encrypted playback (DRM). Protected video is not captured by this extension.' });
    if (c.job && c.job.phase === 'loading') return reply({ ok: false, error: 'Already loading this video. Wait for it to finish or cancel it.' });
    const base = String(name || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 100) || 'video';
    if (!totalBytes(c)) return reply({ ok: false, error: 'Nothing has been captured yet. Play the video, then try again.' });

    const complete = isComplete(c);
    const el = !complete && mode !== 'asis' ? findElement(c) : null;
    if (complete || mode === 'asis' || !el || !durationOf(c)) {
      const r = await saveCapture(c, base, !complete);
      if (r.ok && !complete && mode !== 'asis') {
        r.note = ((!el ? 'The video element was not found, so the missing parts could not be loaded. ' : 'The video length is unknown, so the missing parts could not be loaded. ') + (r.note || '')).trim();
      }
      return reply(r);
    }

    // Not complete: load the rest by ourselves, then save. Runs on after the reply (the popup may close).
    c.job = { phase: 'loading', message: 'Loading the rest of the video… ' + pct(c) + '%', cancel: false };
    reply({ ok: true, started: true });
    scheduleReport();
    let ok;
    try { ok = await loadRest(c, el); } catch (e) { ok = false; }
    if (c.job.cancel) { c.job = { phase: 'canceled', message: 'Canceled.' }; return report(c); }
    if (!ok) {
      c.job = { phase: 'failed', message: `Could not load the whole video (${pct(c)}% loaded). Keep this tab in front and press Download again, or use "Save as is".` };
      return report(c);
    }
    try {
      const r = await saveCapture(c, base, false);
      c.job = r.ok
        ? { phase: 'done', message: 'Saved: ' + r.files.map((f) => f.name).join(', ') + (r.note ? ' (' + r.note + ')' : '') }
        : { phase: 'failed', message: r.error };
    } catch (e) { c.job = { phase: 'failed', message: 'Saving failed: ' + (e && e.message ? e.message : e) }; }
    report(c);
  }

  g.addEventListener('message', (ev) => {
    if (ev.source !== g) return;
    const d = ev.data;
    if (!d || d.svd !== 1) return;
    if (d.type === 'capture-download') download(d.id, d.name, d.reqId, d.mode).catch((e) => post({ type: 'download-result', reqId: d.reqId, ok: false, error: 'Unexpected error: ' + (e && e.message ? e.message : e) }));
    else if (d.type === 'capture-cancel') { const c = captures.get(d.id); if (c && c.job && c.job.phase === 'loading') c.job.cancel = true; }
    else if (d.type === 'rescan') { sent.clear(); captures.forEach(report); }
  });
})();
