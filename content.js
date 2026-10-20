// Content script (isolated world): finds media URLs in <video>, <audio>, <source>, <embed>,
// <object>, links, og:video / JSON-LD / JSON <script> data, and network resource timings.
// It also relays what inject.js (page world) found: API-response URLs and blob: captures.
// It never downloads anything itself; the background worker classifies each URL.
(() => {
  'use strict';

  const FILE_EXT = /\.(mp4|webm|m4v|ogv|mov|mkv|3gp|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
  const STREAM_EXT = /\.(m3u8|mpd)$/i;
  const seen = new Set(); // per-page optimisation only; the background is the source of truth
  const pending = new Set();
  let timer = null;

  function send(message) {
    try {
      const p = chrome.runtime.sendMessage(message);
      if (p && p.catch) p.catch(() => {});
    } catch (e) {
      // Extension was reloaded/updated; this orphaned script can no longer talk to it.
    }
  }

  // Returns a URL object for valid http(s) URLs, otherwise null.
  function parseUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
      const u = new URL(raw.trim(), document.baseURI);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null; // skips blob:, data:, javascript:
      u.hash = '';
      return u;
    } catch (e) {
      return null;
    }
  }

  // Prefer the browser-resolved property (handles <base>, srcdoc, about:blank frames);
  // fall back to the raw attribute.
  function attr(el, prop, name) {
    const v = el[prop];
    return typeof v === 'string' && v ? v : el.getAttribute(name);
  }

  // opts: source, mime, media ('audio'|'video'), requireExt, hint (download= attribute)
  function report(raw, opts) {
    const u = parseUrl(raw);
    if (!u) return;
    if (opts.requireExt && !FILE_EXT.test(u.pathname) && !STREAM_EXT.test(u.pathname)) return;
    if (seen.has(u.href)) return;
    seen.add(u.href);
    send({
      type: 'video-found',
      video: {
        url: u.href,
        source: opts.source,
        mime: opts.mime || '',
        media: opts.media || '',
        hint: opts.hint || '',
        kindHint: opts.kindHint || '',
        note: opts.note || '',
        audioUrl: (parseUrl(opts.audioUrl) || {}).href || '',
        title: (document.title || '').slice(0, 100),
      },
    });
  }

  function inspect(el) {
    const tag = el.tagName;
    if (tag === 'VIDEO' || tag === 'AUDIO') {
      const media = tag === 'AUDIO' ? 'audio' : 'video';
      if (tag === 'VIDEO') Overlay.track(el);
      report(attr(el, 'src', 'src'), { source: media, media });
      report(el.currentSrc, { source: media, media });
      report(el.getAttribute('data-src'), { source: media, media, requireExt: true }); // lazy-loaded players
    } else if (tag === 'SOURCE') {
      const parent = el.parentElement;
      const ptag = parent && parent.tagName;
      if (ptag === 'VIDEO' || ptag === 'AUDIO') {
        const media = ptag === 'AUDIO' ? 'audio' : 'video';
        const mime = el.getAttribute('type');
        report(attr(el, 'src', 'src'), { source: 'source', mime, media });
        report(el.getAttribute('data-src'), { source: 'source', mime, media, requireExt: true });
      }
    } else if (tag === 'A') {
      report(attr(el, 'href', 'href'), { source: 'link', requireExt: true, hint: el.getAttribute('download') });
    } else if (tag === 'EMBED') {
      report(attr(el, 'src', 'src'), { source: 'embed', mime: el.getAttribute('type'), requireExt: true });
    } else if (tag === 'OBJECT') {
      report(attr(el, 'data', 'data'), { source: 'object', mime: el.getAttribute('type'), requireExt: true });
    } else if (tag === 'META') {
      report(el.getAttribute('content'), { source: 'meta', requireExt: true });
    } else if (tag === 'SCRIPT') {
      inspectScript(el);
    }
  }

  // Many sites ship their video data as JSON inside the page: JSON-LD (contentUrl) and
  // <script type="application/json"> state blobs (Instagram, Facebook, Next.js apps ...).
  const scriptLen = new WeakMap(); // parse each script once (again only if its text changed)
  function inspectScript(el) {
    const S = typeof SVDSniff !== 'undefined' ? SVDSniff : null;
    if (!S) return;
    const text = el.textContent || '';
    if (!text || text.length > 4 * 1024 * 1024 || scriptLen.get(el) === text.length) return;
    scriptLen.set(el, text.length);
    if (!S.mightHaveMedia(text)) return;
    for (const doc of S.parseJsonLoose(text)) {
      for (const m of S.findMedia(doc)) {
        report(m.url, { source: 'page-data', media: m.media, kindHint: m.kind, note: m.note, audioUrl: m.audioUrl });
      }
    }
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === 1) inspect(root);
    if (root.nodeType === 1 || root.nodeType === 9) {
      root.querySelectorAll('video, audio, source, embed, object, a[href], meta[property^="og:video"], meta[name="twitter:player:stream"], script[type="application/ld+json"], script[type="application/json"]').forEach(inspect);
    }
  }

  // Players (hls.js, dash.js, ...) fetch manifests via XHR/fetch, so they never appear in the DOM.
  // Resource Timing lists them without needing any extra permission.
  function inspectResource(entry) {
    const u = parseUrl(entry && entry.name);
    if (!u) return;
    const isManifest = STREAM_EXT.test(u.pathname);
    const isNativeMedia = FILE_EXT.test(u.pathname) && /^(video|audio)$/.test(entry.initiatorType);
    if (isManifest || isNativeMedia) {
      report(u.href, { source: 'network', media: entry.initiatorType === 'audio' ? 'audio' : '' });
    }
  }

  function scanResources() {
    try { performance.getEntriesByType('resource').forEach(inspectResource); } catch (e) { /* unsupported */ }
  }

  function flush() {
    timer = null;
    const nodes = Array.from(pending);
    pending.clear();
    nodes.forEach(scan);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === 'attributes') pending.add(m.target);
      else m.addedNodes.forEach((n) => pending.add(n));
    }
    if (!timer) timer = setTimeout(flush, 100); // batch bursts of DOM changes
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'href', 'data', 'data-src'],
  });

  try {
    new PerformanceObserver((list) => list.getEntries().forEach(inspectResource))
      .observe({ type: 'resource', buffered: true });
  } catch (e) { /* PerformanceObserver unavailable */ }

  // currentSrc is only known once the browser has picked a <source>.
  // (Capture phase: media events don't bubble.)
  document.addEventListener('loadstart', (e) => {
    if (e.target && (e.target.tagName === 'VIDEO' || e.target.tagName === 'AUDIO')) inspect(e.target);
  }, true);

  // ---- bridge to inject.js (page world) ----
  const waiting = new Map(); // reqId -> sendResponse for capture downloads
  let reqCounter = 0;
  const toPage = (msg) => { try { window.postMessage(Object.assign({ svd: 1 }, msg), '*'); } catch (e) { /* ignore */ } };

  try {
    window.addEventListener('message', (ev) => {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || d.svd !== 1) return;
      if (d.type === 'found') {
        report(d.url, { source: 'page', mime: d.mime, media: d.media, kindHint: d.kindHint, note: d.note, audioUrl: d.audioUrl });
      } else if (d.type === 'capture') {
        send({ type: 'capture-update', capture: d.capture, title: (document.title || '').slice(0, 100) });
        Overlay.onCapture(d.capture);
      } else if (d.type === 'pick-result') {
        Overlay.onPick(d);
      } else if (d.type === 'capture-gone') {
        send({ type: 'capture-gone', id: d.id });
      } else if (d.type === 'download-result' && waiting.has(d.reqId)) {
        // Everything the page world reports is passed on (the popup needs started/merged/partial/note).
        waiting.get(d.reqId)({
          ok: !!d.ok, error: d.error || '', files: d.files || [],
          started: !!d.started, merged: !!d.merged, partial: !!d.partial, note: d.note || '',
        });
        waiting.delete(d.reqId);
      }
    });
  } catch (e) { /* ignore */ }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === 'rescan') {
        // Popup "Refresh": forget what we already sent and look again.
        seen.clear();
        scan(document);
        scanResources();
        toPage({ type: 'rescan' });
      } else if (msg.type === 'capture-download' && typeof sendResponse === 'function') {
        const reqId = ++reqCounter;
        waiting.set(reqId, sendResponse);
        toPage({ type: 'capture-download', id: msg.id, name: msg.name, mode: msg.mode === 'asis' ? 'asis' : 'complete', reqId });
        setTimeout(() => {
          if (waiting.has(reqId)) { waiting.delete(reqId); sendResponse({ ok: false, error: 'The page did not answer. Reload it and play the video again.' }); }
        }, 10000);
        return true; // answer asynchronously
      } else if (msg.type === 'capture-cancel') {
        toPage({ type: 'capture-cancel', id: msg.id });
      } else if (msg.type === 'overlay-status') {
        Overlay.onStatus(msg);
      }
    });
  } catch (e) { /* ignore */ }

  // ---- download icon in the corner of every video ----
  // A small round button (play triangle + download arrow) sits in the top-left corner of each
  // visible <video> of the page. Clicking it downloads THAT video, so nobody has to hunt for the
  // right entry in the popup. It lives in a closed shadow root (the page's CSS cannot touch it)
  // and reads/changes nothing in the page. It can be switched off in the popup.
  //   - video with an http(s) address  -> background worker (file: downloads API, HLS/DASH: download tab)
  //   - blob: video (MediaSource)      -> the capture belonging to that element (inject.js)
  const Overlay = (() => {
    const MIN_W = 120, MIN_H = 68;       // smaller videos (ads, thumbnails, icons) get no button
    const SETTING = 'svd_overlay';
    const ICON = '<svg viewBox="0 0 28 28" width="28" height="28" aria-hidden="true">' +
      '<path d="M9 7.5v11l9-5.5z" fill="#fff"/>' +
      '<circle cx="20.5" cy="20.5" r="6.5" fill="#fff"/>' +
      '<path d="M20.5 17.2v6M17.9 21l2.6 2.6 2.6-2.6" fill="none" stroke="#1a73e8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>';
    const CSS = ':host{all:initial}' +
      '.item{position:fixed;left:0;top:0;z-index:2147483647;display:none;align-items:center;gap:6px;pointer-events:none;font:12px/1.3 system-ui,sans-serif}' +
      '.item.on{display:flex}.item.flip{flex-direction:row-reverse}' +
      'button{pointer-events:auto;display:block;width:28px;height:28px;padding:0;border:0;border-radius:50%;background:#1a73e8;cursor:pointer;' +
      'box-shadow:0 0 0 2px rgba(255,255,255,.92),0 2px 8px rgba(0,0,0,.45);opacity:.8;transition:opacity .15s,transform .15s}' +
      '.item.hot button,button:hover,button:focus-visible{opacity:1}button:hover{transform:scale(1.1)}' +
      'button:focus-visible{outline:none;box-shadow:0 0 0 2px #fff,0 0 0 4px #1a73e8}' +
      '.item.busy button{background:#5f6368}' +
      '.tip{pointer-events:none;max-width:240px;padding:6px 10px;border-radius:8px;background:rgba(23,27,36,.96);color:#fff;font-weight:500;box-shadow:0 4px 14px rgba(0,0,0,.35);opacity:0;transition:opacity .15s}' +
      '.tip.show{opacity:1}.item.err .tip{background:#c5221f}' +
      '@media(prefers-reduced-motion:reduce){button,.tip{transition:none}button:hover{transform:none}}';

    let enabled = false;                 // becomes true once the saved setting has been read
    const tracked = new Map();           // <video> -> record (created when it first becomes visible)
    const known = new WeakSet();
    const visible = new Set();           // videos that are on screen right now
    const byCapture = new Map();         // capture id -> record, to show "loading the rest" progress
    let host = null, shadow = null, io = null, raf = 0, listening = false, last = null, pickWaiter = null;
    const pointer = { x: -1, y: -1 };

    function ensureHost() {
      if (!host) {
        host = document.createElement('svd-overlay');
        shadow = host.attachShadow({ mode: 'closed' });
        const style = document.createElement('style');
        style.textContent = CSS;
        shadow.append(style);
      }
      if (!host.isConnected) (document.documentElement || document).appendChild(host);
    }

    function makeRecord(video) {
      ensureHost();
      const item = document.createElement('div');
      item.className = 'item';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Download this video');
      btn.title = 'Download this video';
      btn.innerHTML = ICON;           // our own constant markup
      const tip = document.createElement('div');
      tip.className = 'tip';
      item.append(btn, tip);
      // Clicks on our button must not reach the page (it would toggle play, close menus ...).
      ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'touchstart'].forEach((t) =>
        item.addEventListener(t, (e) => e.stopPropagation()));
      const rec = { video, item, btn, tip, busy: false, job: false, captureId: 0, dlId: 0, timer: 0, pos: '', hot: false, flip: false };
      btn.addEventListener('click', (e) => { e.preventDefault(); onClick(rec); });
      shadow.append(item);
      return rec;
    }

    function say(rec, text, opts) {
      const o = opts || {};
      rec.tip.textContent = text;
      rec.tip.classList.add('show');
      rec.item.classList.toggle('err', !!o.error);
      clearTimeout(rec.timer);
      if (!o.sticky) rec.timer = setTimeout(() => rec.tip.classList.remove('show'), o.error ? 9000 : 6000);
    }
    const setBusy = (rec, on) => { rec.busy = on; rec.item.classList.toggle('busy', on); rec.btn.title = on && rec.job ? 'Cancel' : 'Download this video'; };

    // ---- positioning (only while at least one video is on screen) ----
    function untrack(v) {
      const rec = tracked.get(v);
      if (rec) { rec.item.remove(); if (rec.captureId) byCapture.delete(rec.captureId); }
      tracked.delete(v); visible.delete(v);
      if (io) io.unobserve(v);
    }

    function tick() {
      raf = 0;
      if (host && !host.isConnected) ensureHost();        // the page rewrote its document
      const fs = document.fullscreenElement;
      const cw = document.documentElement.clientWidth, ch = document.documentElement.clientHeight;
      for (const v of Array.from(visible)) {
        if (!v.isConnected) { untrack(v); continue; }
        let rec = tracked.get(v);
        const r = v.getBoundingClientRect();
        const show = enabled && !fs && r.width >= MIN_W && r.height >= MIN_H;
        if (!show) { if (rec) rec.item.classList.remove('on'); continue; }
        if (!rec) { rec = makeRecord(v); tracked.set(v, rec); }
        const x = Math.round(Math.max(8, Math.min(Math.max(r.left, 0) + 8, r.right - 36, cw - 36)));
        const y = Math.round(Math.max(8, Math.min(Math.max(r.top, 0) + 8, r.bottom - 36, ch - 36)));
        const pos = x + ',' + y;
        if (pos !== rec.pos) { rec.pos = pos; rec.item.style.transform = 'translate(' + x + 'px,' + y + 'px)'; }
        const hot = pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
        if (hot !== rec.hot) { rec.hot = hot; rec.item.classList.toggle('hot', hot); }
        const flip = x > cw - 290;
        if (flip !== rec.flip) { rec.flip = flip; rec.item.classList.toggle('flip', flip); }
        rec.item.classList.add('on');
      }
      kick();
    }
    function kick() {
      if (!raf && enabled && visible.size && !document.hidden) raf = requestAnimationFrame(tick);
    }
    function hideAll() { tracked.forEach((rec) => rec.item.classList.remove('on')); }

    function track(v) {
      if (known.has(v) || !v || v.tagName !== 'VIDEO') return;
      known.add(v);
      if (typeof IntersectionObserver !== 'function') return;
      if (!io) {
        io = new IntersectionObserver((entries) => {
          for (const e of entries) {
            if (e.isIntersecting) visible.add(e.target);
            else { visible.delete(e.target); const rec = tracked.get(e.target); if (rec) rec.item.classList.remove('on'); }
          }
          kick();
        });
      }
      io.observe(v);
      if (!listening) {
        listening = true;
        document.addEventListener('pointermove', (e) => { pointer.x = e.clientX; pointer.y = e.clientY; }, { capture: true, passive: true });
        document.addEventListener('visibilitychange', kick);
        document.addEventListener('fullscreenchange', kick);
      }
    }

    function setEnabled(on) {
      enabled = !!on;
      if (!enabled) hideAll();
      else { document.querySelectorAll('video').forEach(track); kick(); }
    }
    try {
      chrome.storage.local.get({ [SETTING]: true }).then((s) => setEnabled(s[SETTING] !== false), () => {});
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[SETTING]) setEnabled(changes[SETTING].newValue !== false);
      });
    } catch (e) { /* extension context lost */ }

    // ---- what a click does ----
    function srcOf(v) {
      const cur = v.currentSrc || v.src || '';
      if (cur) return cur;
      const s = v.querySelector('source[src]');      // preload="none": nothing chosen yet
      return s ? s.src : '';
    }
    const noAnswer = 'The extension was updated or the page is not ready. Reload this page and try again.';

    function pick(video) {                  // which capture belongs to this <video>?
      return new Promise((resolve) => {
        const timer = setTimeout(() => { if (pickWaiter === done) pickWaiter = null; resolve(null); }, 1500);
        const done = (d) => { clearTimeout(timer); resolve(d); };
        pickWaiter = done;
        try { video.dispatchEvent(new CustomEvent('svd-pick', { bubbles: true, composed: true })); } catch (e) { done(null); }
      });
    }

    async function downloadBlob(rec) {
      const p = await pick(rec.video);
      if (!p) return { ok: false, error: noAnswer };
      if (p.protected) return { ok: false, error: 'This video uses encrypted playback (DRM). Protected video is not captured.' };
      if (!p.id || !p.bytes) return { ok: false, error: 'Nothing has been captured from this video yet. Let it play for a moment, then click again.' };
      if (rec.captureId && rec.captureId !== p.id) byCapture.delete(rec.captureId);
      rec.captureId = p.id;
      byCapture.set(p.id, rec);
      return new Promise((resolve) => {
        const reqId = ++reqCounter;
        waiting.set(reqId, resolve);
        toPage({ type: 'capture-download', id: p.id, name: (document.title || 'video').slice(0, 100), mode: 'complete', reqId });
        setTimeout(() => { if (waiting.has(reqId)) { waiting.delete(reqId); resolve({ ok: false, error: noAnswer }); } }, 10000);
      });
    }

    // ---- Instagram: ask Instagram for exactly THIS reel's file (by its shortcode) ----
    // Guessing from network traffic picks the wrong reel when several are preloaded. The reel's own link
    // (/reel/CODE/) next to the video gives its id, and Instagram's web API (called from the page, like the site
    // itself does) returns that reel's real file, including sound. Any doubt (no code, carousel, length differs
    // from the player's, rate limit) returns null and the network/capture route is used instead.
    const IG_APP_ID = '936619743392459';
    const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let igPausedUntil = 0;
    const codeIn = (href, feedOk) => {
      const path = String(href || '').replace(/^https?:\/\/[^/]+/i, '').split(/[?#]/)[0];
      const kinds = feedOk ? 'p|reels?|tv' : 'p|reel|tv';
      const m = new RegExp('^/(?:' + kinds + ')/([A-Za-z0-9_-]{5,})(?:/|$)').exec(path) || new RegExp('^/[A-Za-z0-9._]+/(?:' + kinds + ')/([A-Za-z0-9_-]{5,})(?:/|$)').exec(path);
      return m ? m[1] : null;
    };
    // Which post is this <video> part of? Looks at links around it, never at the whole page.
    function codeForVideo(el) {
      const inScope = (root) => { for (const a of root.querySelectorAll('a[href]')) { const c = codeIn(a.getAttribute('href'), false); if (c) return c; } return null; };
      // Home feed: every post is an <article> whose header/time link holds the post's code (Instagram nests deeply,
      // so walking up a fixed number of levels does not always reach it).
      const art = el.closest && el.closest('article');
      if (art) { const c = inScope(art); if (c) return c; }
      let n = el;
      for (let i = 0; n && i < 40; i++, n = n.parentElement) {
        if (n.querySelectorAll('video').length > 1) break;              // holds several videos: cannot tell which link is ours
        const c = inScope(n); if (c) return c;
      }
      return codeIn(location.pathname, true);                           // a single reel/post page
    }
    function mediaIdOf(code) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return null;
      let id = 0n;
      for (const ch of code.slice(0, 11)) id = id * 64n + BigInt(B64.indexOf(ch));
      return id.toString();
    }
    async function igDirect(video) {
      try {
        if (Date.now() < igPausedUntil) return null;
        const code = codeForVideo(video);
        const id = code && mediaIdOf(code);
        if (!id) return null;
        let claim = '0'; try { claim = sessionStorage.getItem('www-claim-v2') || '0'; } catch (e) { /* none */ }
        const res = await fetch('/api/v1/media/' + id + '/info/', { credentials: 'include', headers: { 'x-ig-app-id': IG_APP_ID, 'x-asbd-id': '129477', 'x-ig-www-claim': claim, 'x-requested-with': 'XMLHttpRequest' } });
        if (res.status === 429) { igPausedUntil = Date.now() + 10 * 60 * 1000; return null; }
        if (!res.ok) return null;
        const item = ((await res.json()).items || [])[0];
        if (!item || (item.carousel_media && item.carousel_media.length)) return null;
        const v = item.video_versions && item.video_versions[0];
        if (!v || !/^https:\/\//i.test(v.url || '') || !/(^|\.)(cdninstagram\.com|fbcdn\.net)$/i.test(new URL(v.url).hostname)) return null;
        const dur = Number(item.video_duration);
        if (Number.isFinite(video.duration) && dur > 0 && Math.abs(dur - video.duration) > 2) return null;   // not the video on screen
        return { url: v.url, name: 'instagram-' + code + '.mp4' };
      } catch (e) { return null; }
    }

    async function onClick(rec) {
      if (rec.job) {                                    // a "load the rest" run is going: click cancels it
        toPage({ type: 'capture-cancel', id: rec.captureId });
        say(rec, 'Canceling…', { sticky: true });
        return;
      }
      if (rec.busy) return;
      last = rec;
      setBusy(rec, true);
      say(rec, 'Working…', { sticky: true });
      let r;
      try {
        const src = srcOf(rec.video);
        if (/^https?:/i.test(src)) {
          r = await chrome.runtime.sendMessage({ type: 'overlay-download', url: src, title: document.title || '', ref: location.origin, duration: rec.video && rec.video.duration });
          if (!r) r = { ok: false, error: noAnswer };
          if (r.ok && r.downloadId) rec.dlId = r.downloadId;
        } else if (/^blob:/i.test(src)) {
          // Instagram: the reel's own file, looked up by its id. Otherwise the network file (matched by length), then playback capture.
          r = null;
          if (/(^|\.)instagram\.com$/i.test(location.hostname)) {
            const ig = await igDirect(rec.video);
            if (ig) {
              r = await chrome.runtime.sendMessage({ type: 'overlay-download', url: ig.url, name: ig.name, title: document.title || '', ref: location.origin });
              if (!r || !r.ok) r = null;
            }
          }
          // On Instagram the network files cannot be tied to one video (feeds preload many), so there the fallback is the
          // playback capture, which belongs to this very <video>. Other sites keep the network route first.
          const onIg = /(^|\.)instagram\.com$/i.test(location.hostname);
          if (!r && !onIg) r = await chrome.runtime.sendMessage({ type: 'overlay-download', url: src, title: document.title || '', ref: location.origin, duration: rec.video && rec.video.duration });
          if (r && r.ok && r.downloadId) rec.dlId = r.downloadId;
          if (!r || r.noNetwork) r = await downloadBlob(rec);
        } else {
          r = { ok: false, error: 'This video has no address yet. Press play for a moment, then click again.' };
        }
      } catch (e) {
        r = { ok: false, error: noAnswer };
      }
      if (!r.ok) { setBusy(rec, false); return say(rec, r.error || 'Download failed.', { error: true }); }
      if (r.started) {                                  // blob that was not fully loaded: it finishes by itself
        rec.job = true;
        setBusy(rec, true);
        return say(rec, 'Loading the rest of the video… saved automatically. Click the icon to cancel.', { sticky: true });
      }
      setBusy(rec, false);
      if (r.files && r.files.length) {
        say(rec, 'Saved: ' + r.files.map((f) => f.name).join(', ') + (r.merged ? ' (audio + video merged)' : '') +
          (r.partial ? ' (incomplete: parts of the video are missing)' : '') + (r.note ? ' ' + r.note : ''));
      } else say(rec, r.message || 'Download started.');
    }

    // ---- answers coming back ----
    function onPick(d) { const w = pickWaiter; pickWaiter = null; if (w) w(d); }

    function onCapture(c) {                             // progress of a "load the rest" run
      const rec = c && byCapture.get(c.id);
      const job = c && c.job;
      if (!rec || !job) return;
      if (job.phase === 'loading') {
        rec.job = true;
        if (!rec.busy) setBusy(rec, true);
        rec.item.classList.remove('err');
        say(rec, job.message + ' (click the icon to cancel)', { sticky: true });
      } else if (rec.job) {
        rec.job = false;
        setBusy(rec, false);
        say(rec, job.message, { error: job.phase === 'failed' });
      }
    }

    function onStatus(m) {                              // a plain download finished or failed
      if (!m) return;
      const rec = last && (!m.downloadId || last.dlId === m.downloadId) ? last : null;
      if (rec) say(rec, String(m.message || ''), { error: !m.ok });
    }

    return { track, onPick, onCapture, onStatus };
  })();

  // A new top-level page load clears the previous list for this tab.
  if (window === window.top) send({ type: 'reset' });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => scan(document));
  } else {
    scan(document);
  }

  // Safety net: pages that rewrite their document (document.open/write, as in online code
  // editors) can drop our observers and listeners. A cheap periodic rescan still finds media.
  setInterval(() => { if (!document.hidden) scan(document); }, 3000);
})();
