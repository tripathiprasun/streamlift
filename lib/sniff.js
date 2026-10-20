// Detection helpers shared by the service worker, the content script, the page-world hook
// (inject.js) and the Node tests. Pure functions only: no DOM, no chrome.* APIs.
(function (root) {
  'use strict';

  const FILE_EXT = /\.(mp4|webm|m4v|ogv|mov|mkv|3gp|mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i;
  const STREAM_EXT = /\.(m3u8|mpd)$/i;
  const SEGMENT_EXT = /\.(ts|m4s|m4f|cmfv|cmfa|cmft|fmp4)$/i;
  const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp)$/i;
  const MIN_BYTES = 300000; // network-sniffed files smaller than this are probably segments

  // ---- content / mime ----
  function sniffManifestText(text) {
    const t = String(text || '').slice(0, 4096).replace(/^\uFEFF/, '').trimStart();
    if (t.startsWith('#EXTM3U')) return 'hls';
    // must BE an XML document; a JSON payload that merely contains manifest text is not one
    if (t.startsWith('<') && /<(\w+:)?MPD[\s>]/.test(t)) return 'dash';
    return null;
  }

  // 'hls' | 'dash' | 'segment' | 'video' | 'audio' | null
  function classifyMime(mime) {
    const m = String(mime || '').split(';')[0].trim().toLowerCase();
    if (!m) return null;
    if (/mpegurl/.test(m)) return 'hls';
    if (/dash\+xml/.test(m)) return 'dash';
    if (m === 'video/mp2t' || m === 'video/iso.segment' || m === 'audio/iso.segment') return 'segment';
    if (m.startsWith('video/')) return 'video';
    if (m.startsWith('audio/')) return 'audio';
    return null;
  }

  // ---- URLs ----
  // Players that fetch one big file in pieces put the byte range in the query string
  // (bytestart/byteend, range=a-b). Dropping those gives the whole track.
  function stripRangeParams(href) {
    let u;
    try { u = new URL(href); } catch (e) { return { url: href, stripped: false }; }
    let stripped = false;
    for (const k of ['bytestart', 'byteend']) {
      if (u.searchParams.has(k)) { u.searchParams.delete(k); stripped = true; }
    }
    const r = u.searchParams.get('range');
    if (r !== null && /^\d+-\d*$/.test(r)) { u.searchParams.delete('range'); stripped = true; }
    u.hash = '';
    return { url: u.href, stripped };
  }

  // Which half of a split stream does this URL carry? Some CDNs say so in the address itself:
  // YouTube: mime=audio%2Fwebm   Instagram/Facebook: efg=<base64 JSON with "vencode_tag":"..._audio">
  function trackRole(href) {
    let u;
    try { u = new URL(href); } catch (e) { return ''; }
    const m = /^(audio|video)\//i.exec(u.searchParams.get('mime') || '');
    if (m) return m[1].toLowerCase();
    const efg = u.searchParams.get('efg');
    if (efg && efg.length < 2000) {
      try {
        const json = typeof atob === 'function' ? atob(efg.replace(/-/g, '+').replace(/_/g, '/')) : Buffer.from(efg, 'base64').toString('latin1');
        const tag = /"vencode_tag"\s*:\s*"([^"]*)"/.exec(json);
        if (tag) return /audio/i.test(tag[1]) ? 'audio' : 'video';
      } catch (e) { /* not base64 JSON */ }
    }
    return '';
  }
  // Instagram/Facebook: the efg field also says how long the video is ("duration_s"). It is how a track is matched to the
  // reel that is on screen (several reels are preloaded at once). Returns seconds or 0.
  function efgDuration(href) {
    try {
      const efg = new URL(href).searchParams.get('efg');
      if (!efg || efg.length > 2000) return 0;
      const json = typeof atob === 'function' ? atob(efg.replace(/-/g, '+').replace(/_/g, '/')) : Buffer.from(efg, 'base64').toString('latin1');
      const m = /"duration_s"\s*:\s*([0-9.]+)/.exec(json);
      return m ? +m[1] : 0;
    } catch (e) { return 0; }
  }
  // Both halves of one YouTube stream share the id= parameter.
  function streamKey(href) {
    try { return new URL(href).searchParams.get('id') || ''; } catch (e) { return ''; }
  }

  // Groups URLs that differ only by a short counter (seg-1.m4s, seg-2.m4s ...).
  function patternKey(href) {
    try {
      const u = new URL(href);
      return u.host + u.pathname.replace(/(?<![0-9])\d{1,6}(?![0-9])/g, '#');
    } catch (e) {
      return href;
    }
  }

  // ---- network response judgement (service worker, from response headers) ----
  // r: {url, status, mime, length, range, type}. Returns {ok, url, mime, kindHint, media, note}.
  function judgeResponse(r) {
    const no = { ok: false };
    if (!r || (r.status !== 200 && r.status !== 206)) return no;
    let u;
    try { u = new URL(r.url); } catch (e) { return no; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return no;
    const mime = String(r.mime || '').split(';')[0].trim().toLowerCase();
    const cls = classifyMime(mime);
    const path = u.pathname;
    u.hash = '';

    if (cls === 'hls' || cls === 'dash') return { ok: true, url: u.href, mime, kindHint: cls, media: '', note: '' };
    if (STREAM_EXT.test(path) && !/html/.test(mime)) {
      return { ok: true, url: u.href, mime, kindHint: /\.m3u8$/i.test(path) ? 'hls' : 'dash', media: '', note: '' };
    }
    if (cls === 'segment' || SEGMENT_EXT.test(path)) return no;
    const isMedia = cls === 'video' || cls === 'audio' ||
      (FILE_EXT.test(path) && (mime === '' || /octet-stream|binary/.test(mime)));
    if (!isMedia) return no;

    const strip = stripRangeParams(u.href);
    let total = Number.isFinite(r.length) ? r.length : NaN;
    const cr = /^bytes\s+\d+-\d+\/(\d+|\*)/i.exec(r.range || '');
    if (cr && cr[1] !== '*') total = +cr[1];
    // <video>/<audio> requests are trusted; anything else (fetch/XHR) must be big enough
    // to be a real file rather than one piece of a segmented stream.
    if (r.type !== 'media' || strip.stripped) {
      if (!Number.isFinite(total) || total < MIN_BYTES) return no;
    }
    const clen = parseInt(u.searchParams.get('clen'), 10);            // YouTube: size of the whole track
    if (Number.isFinite(clen) && (!Number.isFinite(total) || clen > total)) total = clen;
    const role = cls === 'audio' ? 'audio' : trackRole(strip.url);
    return {
      ok: true, url: strip.url, mime, kindHint: '', media: role === 'audio' ? 'audio' : '',
      split: strip.stripped, total: Number.isFinite(total) ? total : 0, key: streamKey(strip.url), duration: efgDuration(strip.url),
      note: strip.stripped ? 'One track of a split stream: it may have no sound (or no picture). Merge audio and video with FFmpeg if needed.' : '',
    };
  }

  // ---- JSON payloads (fetch/XHR responses, <script type="application/json">) ----
  // Facebook prefixes JSON with "for (;;);", Google with ")]}'", and some APIs send one
  // JSON document per line.
  function parseJsonLoose(text) {
    let s = String(text || '').replace(/^\uFEFF/, '').trimStart();
    s = s.replace(/^for\s*\(;;\);/, '').replace(/^\)\]\}'/, '').trim();
    if (!s) return [];
    try { return [JSON.parse(s)]; } catch (e) { /* try line by line */ }
    const out = [];
    for (const line of s.split(/\r?\n/)) {
      const l = line.trim();
      if (!l || (l[0] !== '{' && l[0] !== '[')) continue;
      try { out.push(JSON.parse(l)); } catch (e) { /* skip */ }
    }
    return out;
  }

  // Cheap pre-filter so we do not JSON.parse every payload on busy pages.
  const MEDIA_HINT = /\.(mp4|m3u8|mpd|webm|m4a|mp3)\b|playable_url|video_versions|video_dash_manifest|playAddr|downloadAddr|contentUrl|fallback_url|hls_url|dash_url|browser_native|<MPD|mp4_url|video_url|"variants"/i;
  const mightHaveMedia = (text) => MEDIA_HINT.test(String(text || ''));

  const URL_KEYS = /^(playable_url(_quality_hd)?|browser_native_(hd|sd)_url|video_url|videourl|video_src|videosrc|contenturl|content_url|playaddr|downloadaddr|play_addr|download_addr|play_url|fallback_url|hls_url|hlsurl|dash_url|dashurl|stream_url|streamurl|mp4_url|mp4url|hd_src|sd_src|hd_src_no_ratelimit|sd_src_no_ratelimit|hd_url|sd_url|progressive_url|progressive_download_url|playback_url|playbackurl|audio_url|audiourl|video_hd_url|video_sd_url)$/i;
  const LIST_KEYS = /^(video_versions|videoversions|variants|renditions|sources|streams|formats|video_resources|playback_urls|media_variants)$/i;
  const DASH_KEYS = /(dash_manifest|dashmanifest|manifest_xml|mpd)$/i;

  function decodeXml(s) {
    return String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  }

  // Instagram/Facebook embed a DASH manifest as an XML string inside JSON. Its Representations
  // use absolute <BaseURL>s that each point at one complete video-only or audio-only MP4.
  function extractDashBaseUrls(xml) {
    const out = [];
    const sets = String(xml).split(/<(?:\w+:)?AdaptationSet\b/i).slice(1);
    for (const chunk of sets) {
      const head = chunk.slice(0, chunk.indexOf('>') + 1);
      const setAttr = (n) => { const m = new RegExp('\\b' + n + '="([^"]*)"', 'i').exec(head); return m ? m[1] : ''; };
      const re = /<(?:\w+:)?Representation\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Representation>/gi;
      let m;
      while ((m = re.exec(chunk))) {
        const rAttr = (n) => { const x = new RegExp('\\b' + n + '="([^"]*)"', 'i').exec(m[1]); return x ? x[1] : ''; };
        const b = /<(?:\w+:)?BaseURL[^>]*>([\s\S]*?)<\/(?:\w+:)?BaseURL>/i.exec(m[2]);
        if (!b) continue;
        const url = decodeXml(b[1].trim());
        if (!/^https?:\/\//i.test(url)) continue;
        const mime = rAttr('mimeType') || setAttr('mimeType');
        const codecs = rAttr('codecs') || setAttr('codecs');
        const type = setAttr('contentType') || (/^(video|audio)\//.exec(mime) || [])[1] ||
          (/^(avc|hvc|hev|vp|av01)/i.test(codecs) ? 'video' : /^(mp4a|opus|ac-3|ec-3)/i.test(codecs) ? 'audio' : '');
        if (type !== 'video' && type !== 'audio') continue;
        const height = parseInt(rAttr('height'), 10) || 0;
        const bandwidth = parseInt(rAttr('bandwidth'), 10) || 0;
        out.push({ url, type, height, bandwidth, mime: mime || (type + '/mp4') });
      }
    }
    return out;
  }

  function hasMediaExt(raw) {
    if (!/^https?:\/\//i.test(raw)) return false;
    try { const p = new URL(raw).pathname; return FILE_EXT.test(p) || STREAM_EXT.test(p); } catch (e) { return false; }
  }

  // Walks parsed JSON and returns [{url, kind, media, note}] (kind: 'hls'|'dash'|'').
  function findMedia(root0, limit) {
    const max = limit || 40;
    const found = new Map();
    let nodes = 0;

    function add(raw, kind, media, note, audioUrl) {
      if (found.size >= max || typeof raw !== 'string' || raw.length > 2048 || !/^https?:\/\//i.test(raw)) return;
      let u;
      try { u = new URL(raw); } catch (e) { return; }
      if (IMAGE_EXT.test(u.pathname)) return;
      u.hash = '';
      if (found.has(u.href)) return;
      const k = kind || (/\.m3u8$/i.test(u.pathname) ? 'hls' : /\.mpd$/i.test(u.pathname) ? 'dash' : '');
      const item = { url: u.href, kind: k, media: media || '', note: note || '' };
      if (audioUrl) item.audioUrl = audioUrl;
      found.set(u.href, item);
    }

    function walk(node, key, listCtx, depth) {
      if (found.size >= max || depth > 14 || ++nodes > 30000 || node === null) return;
      if (typeof node === 'string') {
        if (node.length > 40 && /<(\w+:)?MPD[\s>]/.test(node.slice(0, 600))) {
          const reps = extractDashBaseUrls(node);
          const best = (type) => reps.filter((r) => r.type === type).sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
          const vids = best('video'), auds = best('audio');
          if (vids.length && auds.length) {
            // one entry that downloads both complete files and merges them
            add(vids[0].url, '', 'video', 'Video + audio' + (vids[0].height ? ' ' + vids[0].height + 'p' : '') + ', merged into one file when downloaded', auds[0].url);
          } else {
            for (const r of reps) add(r.url, '', r.type, r.type === 'video' ? 'Video only' + (r.height ? ' ' + r.height + 'p' : '') : 'Audio only');
          }
          return;
        }
        if (node.length > 40 && DASH_KEYS.test(key) && /<(\w+:)?MPD[\s>]/.test(node)) return;
        const hint = /hls/i.test(key) ? 'hls' : /dash/i.test(key) ? 'dash' : '';
        if (URL_KEYS.test(key)) add(node, hint, /^audio/i.test(key) ? 'audio' : '', '');
        else if (listCtx && /^(url|src|source|uri)$/i.test(key)) add(node, '', '', '');
        else if (hasMediaExt(node)) add(node, '', '', '');
        return;
      }
      if (typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item, key, listCtx || LIST_KEYS.test(key), depth + 1);
        return;
      }
      const label = node.height ? node.height + 'p' : '';
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (listCtx && typeof v === 'string' && /^(url|src|source|uri)$/i.test(k)) {
          const ct = String(node.content_type || node.mimeType || node.mime_type || node.type || '');
          const kind = /mpegurl/i.test(ct) ? 'hls' : /dash/i.test(ct) ? 'dash' : '';
          add(v, kind, /^audio/i.test(ct) ? 'audio' : '', label);
        } else {
          walk(v, k, LIST_KEYS.test(k), depth + 1);
        }
      }
    }
    walk(root0, '', false, 0);
    return Array.from(found.values());
  }

  // ---- bytes ----
  const BOX = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function isInitSegment(b) {
    if (!b || b.length < 12) return false;
    if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return true; // WebM/Matroska EBML
    const t = BOX(b, 4);
    return t === 'ftyp' || t === 'moov';
  }
  // 32-bit FNV-1a over every byte + length. Identical fMP4 segments carry identical
  // timestamps, so an equal fingerprint means the player re-appended the same segment.
  function fingerprint(b) {
    let h = 0x811c9dc5;
    for (let i = 0; i < b.length; i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16) + ':' + b.length;
  }
  function roleOfMime(mime) {
    const m = String(mime || '').toLowerCase();
    const v = /avc|hvc|hev|vp0?[89]|av01|theora/.test(m), a = /mp4a|opus|ac-3|ec-3|flac|vorbis|mp3/.test(m);
    if (v && a) return 'media';
    if (/^audio\//.test(m) || (a && !v)) return 'audio';
    return 'video';
  }

  // ---- time ranges (how much of the video has been captured) ----
  function addRange(list, s, e) {
    if (!(e > s)) return list;
    const out = [];
    let placed = false;
    for (const [a, b] of list) {
      if (b < s - 0.05) out.push([a, b]);
      else if (a > e + 0.05) { if (!placed) { out.push([s, e]); placed = true; } out.push([a, b]); }
      else { s = Math.min(s, a); e = Math.max(e, b); }
    }
    if (!placed) out.push([s, e]);
    return out;
  }
  const rangeTotal = (list) => list.reduce((n, r) => n + (r[1] - r[0]), 0);
  // Overlap of two sorted, disjoint range lists.
  function intersectRanges(a, b) {
    const out = [];
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      const s = Math.max(a[i][0], b[j][0]), e = Math.min(a[i][1], b[j][1]);
      if (e > s) out.push([s, e]);
      if (a[i][1] < b[j][1]) i++; else j++;
    }
    return out;
  }
  // First stretch of [from, to] not covered by the ranges that is longer than minLen.
  function firstGap(list, from, to, minLen) {
    let pos = from;
    for (const [a, b] of list) {
      if (a - pos > minLen) return { start: pos, end: Math.min(a, to) };
      if (b > pos) pos = b;
      if (pos >= to) return null;
    }
    return to - pos > minLen ? { start: pos, end: to } : null;
  }

  const api = {
    FILE_EXT, STREAM_EXT, SEGMENT_EXT, MIN_BYTES,
    sniffManifestText, classifyMime, stripRangeParams, trackRole, efgDuration, streamKey, patternKey, judgeResponse,
    parseJsonLoose, mightHaveMedia, extractDashBaseUrls, findMedia,
    isInitSegment, fingerprint, roleOfMime, addRange, rangeTotal, intersectRanges, firstGap,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SVDSniff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
