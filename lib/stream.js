// HLS / DASH parsing and downloading. Pure logic with an injectable fetch, so it runs in the
// extension's download page and in Node tests. It never decrypts anything: encrypted/DRM
// streams are refused with an explanation.
(function (root) {
  'use strict';

  class StreamError extends Error {
    constructor(code, message) { super(message); this.name = 'StreamError'; this.code = code; }
  }
  // Errors that retrying or choosing another quality cannot fix.
  const FATAL = new Set(['ENCRYPTED', 'DRM', 'LIVE', 'UNSUPPORTED_CODEC', 'UNSUPPORTED', 'BAD_MANIFEST']);

  // ---- codecs (we only copy bytes, never transcode) ----
  const OK_CODEC = /^(avc[1-4]|hvc1|hev1|vp0?9|vp8|av01|mp4a|opus|ac-3|ec-3|flac|vorbis|mp3)$/i;
  function unsupportedCodecs(codecs) {
    if (!codecs) return [];
    return String(codecs).split(',').map((c) => c.trim()).filter(Boolean)
      .filter((c) => !OK_CODEC.test(c.split('.')[0]));
  }

  // ---- URLs ----
  function resolve(rel, base) { return new URL(rel, base).href; }

  // ---- HLS ----
  function parseAttrs(s) {
    const out = {};
    const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
    let m;
    while ((m = re.exec(s))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
    return out;
  }

  function parseByteRange(v, prevEnd) {
    const [len, off] = String(v).split('@');
    const length = parseInt(len, 10);
    const offset = off !== undefined ? parseInt(off, 10) : prevEnd;
    return { offset, length };
  }

  // Returns {type:'master', variants, audio} or {type:'media', segments, map, endList, encrypted}.
  function parseHls(text, baseUrl) {
    const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
    if (lines[0] !== '#EXTM3U') throw new StreamError('BAD_MANIFEST', 'This is not a valid HLS playlist (missing #EXTM3U).');
    const master = { type: 'master', variants: [], audio: [] };
    const media = { type: 'media', segments: [], map: null, endList: false, encrypted: null };
    let isMaster = false, pending = null, byteEnd = 0, nextRange = null;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      if (line.startsWith('#EXT-X-STREAM-INF:')) { isMaster = true; pending = parseAttrs(line.slice(18)); }
      else if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = parseAttrs(line.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) master.audio.push({ group: a['GROUP-ID'], name: a.NAME, def: a.DEFAULT === 'YES', url: resolve(a.URI, baseUrl) });
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const a = parseAttrs(line.slice(11));
        if (a.METHOD && a.METHOD !== 'NONE') media.encrypted = a.METHOD;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const a = parseAttrs(line.slice(11));
        media.map = { url: resolve(a.URI, baseUrl), range: a.BYTERANGE ? parseByteRange(a.BYTERANGE, 0) : null };
      } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
        nextRange = parseByteRange(line.slice(17), byteEnd);
      } else if (line === '#EXT-X-ENDLIST') media.endList = true;
      else if (line.startsWith('#')) continue;
      else if (pending) {
        const res = /^(\d+)x(\d+)$/.exec(pending.RESOLUTION || '');
        master.variants.push({
          url: resolve(line, baseUrl),
          bandwidth: parseInt(pending.BANDWIDTH, 10) || 0,
          width: res ? +res[1] : 0, height: res ? +res[2] : 0,
          codecs: pending.CODECS || '', audioGroup: pending.AUDIO || '',
        });
        pending = null;
      } else {
        media.segments.push({ url: resolve(line, baseUrl), range: nextRange });
        if (nextRange) byteEnd = nextRange.offset + nextRange.length;
        nextRange = null;
      }
    }
    return isMaster ? master : media;
  }

  // ---- tiny XML parser (no DOMParser in service workers / Node) ----
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e.toLowerCase()];
    });
  }
  function parseXml(text) {
    const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
    const rootNode = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [rootNode];
    let m;
    while ((m = re.exec(text))) {
      const top = stack[stack.length - 1];
      if (m[1] !== undefined) top.text += m[1];
      else if (m[3]) {
        const name = m[3].replace(/^.*:/, '');          // drop namespace prefix
        if (m[2]) {                                      // closing tag
          if (stack.length < 2 || top.name !== name) throw new StreamError('BAD_MANIFEST', 'The manifest is not well-formed XML.');
          stack.pop();
        } else {
          const attrs = {};
          m[4].replace(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, a, b) => { attrs[k.replace(/^.*:/, '')] = decodeEntities(a !== undefined ? a : b); return ''; });
          const node = { name, attrs, children: [], text: '' };
          top.children.push(node);
          if (!m[5]) stack.push(node);
        }
      } else if (m[6]) top.text += decodeEntities(m[6]);
    }
    if (stack.length !== 1 || !rootNode.children.length) throw new StreamError('BAD_MANIFEST', 'The manifest is not well-formed XML.');
    return rootNode.children[0];
  }

  // ---- DASH ----
  const kids = (n, name) => n.children.filter((c) => c.name === name);
  const kid = (n, name) => n.children.find((c) => c.name === name);

  function isoDuration(s) {
    const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s || '');
    if (!m) return 0;
    return (+m[1] || 0) * 86400 + (+m[2] || 0) * 3600 + (+m[3] || 0) * 60 + (+m[4] || 0);
  }

  function fillTemplate(tpl, vars) {
    return tpl.replace(/\$(\w*)(?:%0(\d+)d)?\$/g, (m, name, width) => {
      if (name === '') return '$';
      if (!(name in vars)) return m;
      const v = String(vars[name]);
      return width ? v.padStart(+width, '0') : v;
    });
  }

  // Returns {tracks:[{type,id,bandwidth,width,height,codecs,init,segments,encrypted}]}.
  function parseDash(text, baseUrl) {
    const mpd = parseXml(text);
    if (mpd.name !== 'MPD') throw new StreamError('BAD_MANIFEST', 'This is not a DASH manifest (no <MPD> element).');
    if (mpd.attrs.type === 'dynamic') throw new StreamError('LIVE', 'This is a live DASH stream; only finished (on-demand) streams can be downloaded.');
    const periods = kids(mpd, 'Period');
    if (!periods.length) throw new StreamError('BAD_MANIFEST', 'The manifest contains no Period.');
    if (periods.length > 1) throw new StreamError('UNSUPPORTED', 'Multi-period DASH manifests are not supported.');
    const period = periods[0];
    const duration = isoDuration(period.attrs.duration) || isoDuration(mpd.attrs.mediaPresentationDuration);
    const baseOf = (n, b) => { const e = kid(n, 'BaseURL'); return e && e.text.trim() ? resolve(e.text.trim(), b) : b; };
    const periodBase = baseOf(period, baseOf(mpd, baseUrl));
    const tracks = [];

    for (const set of kids(period, 'AdaptationSet')) {
      const setBase = baseOf(set, periodBase);
      for (const rep of kids(set, 'Representation')) {
        const attr = (k) => rep.attrs[k] !== undefined ? rep.attrs[k] : set.attrs[k];
        const mime = attr('mimeType') || '';
        const codecs = attr('codecs') || '';
        let type = attr('contentType') || (/^(video|audio|text)\//.exec(mime) || [])[1] || '';
        if (!type && /^(avc|hvc|hev|vp|av01)/i.test(codecs)) type = 'video';
        if (!type && /^(mp4a|opus|ac-3|ec-3)/i.test(codecs)) type = 'audio';
        if (type !== 'video' && type !== 'audio') continue; // subtitles/other are skipped
        const t = {
          type, id: rep.attrs.id || String(tracks.length), codecs,
          bandwidth: parseInt(rep.attrs.bandwidth, 10) || 0,
          width: parseInt(attr('width'), 10) || 0, height: parseInt(attr('height'), 10) || 0,
          lang: set.attrs.lang || '', init: null, segments: [],
          encrypted: !!(kids(set, 'ContentProtection').length || kids(rep, 'ContentProtection').length),
        };
        const repBase = baseOf(rep, setBase);
        const tpl = kid(rep, 'SegmentTemplate') || kid(set, 'SegmentTemplate');
        const list = kid(rep, 'SegmentList') || kid(set, 'SegmentList');
        if (tpl) {
          const a = (k) => tpl.attrs[k];
          const vars = { RepresentationID: t.id, Bandwidth: t.bandwidth };
          const timescale = parseInt(a('timescale'), 10) || 1;
          if (a('initialization')) t.init = resolve(fillTemplate(a('initialization'), vars), repBase);
          if (!a('media')) throw new StreamError('BAD_MANIFEST', `Representation ${t.id}: SegmentTemplate has no media attribute.`);
          const start = a('startNumber') !== undefined ? parseInt(a('startNumber'), 10) : 1;
          const timeline = kid(tpl, 'SegmentTimeline');
          if (timeline) {
            let time = 0, n = start;
            for (const s of kids(timeline, 'S')) {
              if (s.attrs.t !== undefined) time = parseInt(s.attrs.t, 10);
              const d = parseInt(s.attrs.d, 10);
              const r = s.attrs.r !== undefined ? parseInt(s.attrs.r, 10) : 0;
              if (r < 0) throw new StreamError('UNSUPPORTED', 'Open-ended SegmentTimeline repeats are not supported.');
              for (let k = 0; k <= r; k++, n++) { t.segments.push(resolve(fillTemplate(a('media'), { ...vars, Number: n, Time: time }), repBase)); time += d; }
            }
          } else {
            const d = parseInt(a('duration'), 10);
            if (!d || !duration) throw new StreamError('BAD_MANIFEST', `Representation ${t.id}: cannot work out the segment count (no duration).`);
            const count = Math.ceil((duration * timescale) / d);
            for (let k = 0; k < count; k++) t.segments.push(resolve(fillTemplate(a('media'), { ...vars, Number: start + k, Time: k * d }), repBase));
          }
        } else if (list) {
          const ini = kid(list, 'Initialization');
          if (ini && ini.attrs.sourceURL) t.init = resolve(ini.attrs.sourceURL, repBase);
          for (const s of kids(list, 'SegmentURL')) {
            if (s.attrs.mediaRange) throw new StreamError('UNSUPPORTED', 'SegmentList with byte ranges is not supported.');
            t.segments.push(resolve(s.attrs.media || '', repBase));
          }
        } else if (kid(rep, 'BaseURL') || kid(set, 'BaseURL')) {
          t.segments.push(repBase); // on-demand profile: one complete MP4 file
        } else {
          throw new StreamError('UNSUPPORTED', `Representation ${t.id}: no supported segment addressing.`);
        }
        if (!t.segments.length) throw new StreamError('BAD_MANIFEST', `Representation ${t.id} lists no segments.`);
        tracks.push(t);
      }
    }
    if (!tracks.length) throw new StreamError('UNSUPPORTED', 'No audio or video representations found in the manifest.');
    return { tracks };
  }

  // ---- quality selection ----
  const qualityLabel = (q) => (q.height ? q.height + 'p' : 'audio') + (q.bandwidth ? ' · ' + (q.bandwidth / 1e6 >= 1 ? (q.bandwidth / 1e6).toFixed(1) + ' Mbps' : Math.round(q.bandwidth / 1000) + ' kbps') : '');

  // Pick from sorted-best-first list: 'best' (default), or an id from the list.
  function choose(list, id) {
    if (!list.length) return null;
    if (id && id !== 'best') { const hit = list.find((q) => q.id === id); if (hit) return hit; }
    return list[0];
  }

  // Normalised description of a manifest. For HLS this needs only the top playlist.
  // Returns {kind, qualities:[{id,label,...}], ...parsed}. Throws StreamError for fatal problems.
  function describe(text, baseUrl) {
    const t = String(text).trimStart();
    if (t.startsWith('#EXTM3U')) {
      const p = parseHls(text, baseUrl);
      if (p.type === 'media') {
        if (p.encrypted) throw new StreamError('ENCRYPTED', `This HLS stream is encrypted (${p.encrypted}). Encrypted streams are not downloaded by this extension.`);
        return { kind: 'hls', parsed: p, qualities: [{ id: '0', label: 'Single quality', url: baseUrl, bandwidth: 0, height: 0 }] };
      }
      const ok = p.variants.filter((v) => !unsupportedCodecs(v.codecs).length);
      if (!p.variants.length) throw new StreamError('BAD_MANIFEST', 'The master playlist lists no streams.');
      if (!ok.length) throw new StreamError('UNSUPPORTED_CODEC', 'Unsupported codec(s): ' + [...new Set(p.variants.flatMap((v) => unsupportedCodecs(v.codecs)))].join(', ') + '. This extension only copies H.264/H.265/VP9/AV1 video and AAC/Opus/AC-3 audio; it cannot convert.');
      const qualities = ok.map((v, i) => ({ ...v, id: String(i) })).sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
      qualities.forEach((q) => { q.label = qualityLabel(q); });
      return { kind: 'hls', parsed: p, qualities };
    }
    if (/^<\?xml|^<(\w+:)?MPD[\s>]/i.test(t) && /<(\w+:)?MPD[\s>]/.test(t)) {
      const p = parseDash(text, baseUrl);
      if (p.tracks.some((x) => x.encrypted)) throw new StreamError('DRM', 'This DASH stream is protected (ContentProtection/DRM). Protected streams are not downloaded by this extension.');
      const bad = [...new Set(p.tracks.flatMap((x) => unsupportedCodecs(x.codecs)))];
      const video = p.tracks.filter((x) => x.type === 'video' && !unsupportedCodecs(x.codecs).length)
        .sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
      const audio = p.tracks.filter((x) => x.type === 'audio' && !unsupportedCodecs(x.codecs).length).sort((a, b) => b.bandwidth - a.bandwidth);
      if (!video.length && !audio.length) throw new StreamError('UNSUPPORTED_CODEC', 'Unsupported codec(s): ' + bad.join(', ') + '.');
      const qs = video.length ? video : audio;
      return { kind: 'dash', parsed: p, video, audio, qualities: qs.map((q) => ({ ...q, label: qualityLabel(q) })) };
    }
    throw new StreamError('BAD_MANIFEST', 'The URL did not return an HLS or DASH manifest. It may have expired or require a login.');
  }

  // ---- fetching ----
  function httpError(status, url, what, index) {
    const signed = /[?&](expires?|exp|token|sig|signature|hdnea|x-amz-expires)=/i.test(url);
    if (status === 401) return new StreamError('AUTH', `${what} requires a login (HTTP 401). This extension does not bypass authentication.`);
    if (status === 403) return new StreamError('EXPIRED', `${what} was refused (HTTP 403).` + (signed ? ' The signed URL has probably expired: reload the page and try again.' : ' Access is denied (login, geo or hotlink protection).'));
    if (status === 404 || status === 410) return new StreamError('MISSING_SEGMENT', `${what} was not found (HTTP ${status}).` + (signed || status === 410 ? ' The URL may have expired.' : ''));
    return new StreamError('HTTP', `${what} failed with HTTP ${status}.`);
  }

  async function get(fetchFn, url, what, signal, rangeOf) {
    const headers = rangeOf ? { Range: `bytes=${rangeOf.offset}-${rangeOf.offset + rangeOf.length - 1}` } : undefined;
    let res;
    try { res = await fetchFn(url, { signal, headers, credentials: 'include' }); }
    catch (e) {
      if (signal && signal.aborted) throw new StreamError('ABORTED', 'Download canceled.');
      throw new StreamError('NETWORK', `${what} could not be fetched (network error or blocked by the server).`);
    }
    if (!res.ok) {
      const err = httpError(res.status, url, what);
      err.status = res.status;
      const ra = res.headers && res.headers.get && parseFloat(res.headers.get('retry-after'));
      if (Number.isFinite(ra)) err.retryAfter = ra;
      throw err;
    }
    return res;
  }

  async function fetchManifest(fetchFn, url, signal) {
    const res = await get(fetchFn, url, 'The manifest', signal);
    return res.text();
  }

  // Detect what the bytes really are, so an HTML error page is never saved as video.
  function sniff(bytes) {
    const b = bytes;
    if (b.length >= 189 && b[0] === 0x47) return 'ts';
    const tag = String.fromCharCode(...b.slice(4, 8));
    if (/^(ftyp|styp|moof|sidx|moov)$/.test(tag)) return 'mp4';
    if (b[0] === 0xff && (b[1] & 0xf0) === 0xf0) return 'aac';
    if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'aac';
    if (b[0] === 0x1a && b[1] === 0x45) return 'webm';
    return '';
  }

  // Some sites hide their segments behind a fake file header (a PNG/GIF/JPEG picture header, junk bytes) so that
  // they look like images to a simple downloader. The real media data follows. If the bytes are not recognisable,
  // look for where an MPEG-TS packet stream (0x47 every 188 bytes) or an MP4 box starts and drop what is in front.
  function unwrap(buf) {
    if (sniff(buf)) return buf;
    const lim = Math.min(buf.length, 256 * 1024);
    for (let o = 1; o < lim; o++) {
      if (buf[o] === 0x47 && o + 376 < buf.length && buf[o + 188] === 0x47 && buf[o + 376] === 0x47 &&
          (o + 564 >= buf.length || buf[o + 564] === 0x47)) return buf.subarray(o);
    }
    for (let o = 4; o < lim - 8; o++) {
      if (buf[o] === 0x66 && buf[o + 1] === 0x74 && buf[o + 2] === 0x79 && buf[o + 3] === 0x70 ||      // ftyp
          buf[o] === 0x73 && buf[o + 1] === 0x74 && buf[o + 2] === 0x79 && buf[o + 3] === 0x70 ||      // styp
          buf[o] === 0x6d && buf[o + 1] === 0x6f && buf[o + 2] === 0x6f && buf[o + 3] === 0x66) {      // moof
        const size = ((buf[o - 4] << 24) | (buf[o - 3] << 16) | (buf[o - 2] << 8) | buf[o - 1]) >>> 0;
        if (size >= 8 && size < 1 << 24) return buf.subarray(o - 4);
      }
    }
    return buf;
  }

  // gate: shared between the workers of one track. A server answering 429/503 ("too many requests") makes ALL
  // workers wait, then continue; the wait grows with every consecutive refusal.
  async function fetchSegment(fetchFn, seg, label, signal, retries, gate) {
    let last;
    const limited = (e) => e && (e.status === 429 || e.status === 503 || e.status === 502 || e.status === 504 || e.status === 520 || e.status === 522 || e.status === 524);
    const maxTries = retries + 8;                                   // a rate-limited segment is worth waiting for
    for (let attempt = 0; attempt <= maxTries; attempt++) {
      try {
        if (gate && gate.until > Date.now()) await new Promise((r) => setTimeout(r, gate.until - Date.now()));
        if (signal && signal.aborted) throw new StreamError('ABORTED', 'Download canceled.');
        const res = await get(fetchFn, seg.url, label, signal, seg.range);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (!buf.length) throw new StreamError('BAD_SEGMENT', `${label} is empty.`);
        if (gate) gate.strikes = 0;
        return buf;
      } catch (e) {
        last = e;
        if (limited(e)) {
          if (gate) {
            gate.strikes = Math.min(6, (gate.strikes || 0) + 1);
            const wait = Math.max((e.retryAfter || 0) * 1000, 1000 * Math.pow(2, gate.strikes - 1)) + Math.random() * 500;
            gate.until = Math.max(gate.until || 0, Date.now() + Math.min(wait, 60000));
            gate.slow = true;
          }
          if (attempt === maxTries) throw e;
          continue;
        }
        const retriable = e.code === 'NETWORK' || (e.code === 'HTTP');
        if (!retriable || attempt >= retries) throw e;
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    throw last;
  }

  // Download one track: optional init, then segments in order. Returns {blob, kind, bytes}.
  async function downloadTrack({ fetchFn, init, segments, name, signal, onProgress, concurrency = 3, retries = 2, BlobCtor = Blob }) {
    const parts = new Array(segments.length);
    let done = 0, bytes = 0, next = 0, failure = null, sniffed = '';
    let initBuf = null;
    const gate = { until: 0, strikes: 0, slow: false };
    if (init) {
      initBuf = await fetchSegment(fetchFn, init.url ? init : { url: init }, `${name} init segment`, signal, retries, gate);
      bytes += initBuf.length;
    }
    async function worker() {
      while (!failure) {
        const i = next++;
        if (i >= segments.length) return;
        if (gate.slow) await new Promise((r) => setTimeout(r, 250 + Math.random() * 250));
        try {
          let buf = await fetchSegment(fetchFn, segments[i], `${name} segment ${i + 1} of ${segments.length}`, signal, retries, gate);
          if (buf[0] === 0x3c || (buf[0] === 0x23 && buf[1] === 0x45)) throw new StreamError('BAD_SEGMENT', `${name} segment ${i + 1} is an HTML/text page, not media (expired link or blocked request).`);
          buf = unwrap(buf);
          if (i === 0 || !sniffed) {
            const kind = sniff(buf);
            if (i === 0) {
              if (!kind) throw new StreamError('BAD_SEGMENT', `${name} segment 1 is not media data (it looks like an error page, encrypted data or an unsupported container).`);
              sniffed = kind;
            }
          }
          parts[i] = buf; bytes += buf.length; done++;
          if (onProgress) onProgress({ track: name, done, total: segments.length, bytes });
        } catch (e) { failure = failure || e; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, segments.length) }, worker));
    if (failure) throw failure;
    const kind = sniffed === 'ts' && !initBuf ? 'ts' : initBuf || sniffed === 'mp4' ? 'mp4' : sniffed;
    return { blob: new BlobCtor(initBuf ? [initBuf, ...parts] : parts), kind, bytes };
  }

  const EXT = { ts: 'ts', mp4: 'mp4', aac: 'aac', webm: 'webm' };

  // Main entry. opts: {url, quality, fetchFn, signal, onProgress, onInfo, BlobCtor}
  // Resolves {files:[{suffix, ext, blob, bytes, role}], info}. Rejects with StreamError.
  async function downloadStream(opts) {
    const { url, quality, signal, onProgress, onInfo } = opts;
    const fetchFn = opts.fetchFn || ((...a) => fetch(...a));
    const text = await fetchManifest(fetchFn, url, signal);
    const d = describe(text, url);
    const tracks = [];   // {role, init, segments}
    let chosen;
    if (d.kind === 'hls') {
      let media = d.parsed, audioTrack = null;
      chosen = choose(d.qualities, quality);
      if (d.parsed.type === 'master') {
        const mediaUrl = chosen.url;
        const mt = await fetchManifest(fetchFn, mediaUrl, signal);
        media = parseHls(mt, mediaUrl);
        if (media.type !== 'media') throw new StreamError('BAD_MANIFEST', 'The selected variant is not a media playlist.');
        const aud = chosen.audioGroup && d.parsed.audio.filter((a) => a.group === chosen.audioGroup);
        if (aud && aud.length) {
          const a = aud.find((x) => x.def) || aud[0];
          const at = parseHls(await fetchManifest(fetchFn, a.url, signal), a.url);
          if (at.type !== 'media') throw new StreamError('BAD_MANIFEST', 'The audio playlist is not a media playlist.');
          audioTrack = at;
        }
      }
      for (const m of [media, audioTrack].filter(Boolean)) {
        if (m.encrypted) throw new StreamError('ENCRYPTED', `This HLS stream is encrypted (${m.encrypted}). Encrypted streams are not downloaded by this extension.`);
        if (!m.endList) throw new StreamError('LIVE', 'This HLS playlist has no #EXT-X-ENDLIST, so it is a live or incomplete stream. Only finished streams can be downloaded.');
        if (!m.segments.length) throw new StreamError('BAD_MANIFEST', 'The playlist lists no segments.');
      }
      tracks.push({ role: audioTrack ? 'video' : 'media', init: media.map && { url: media.map.url, range: media.map.range }, segments: media.segments });
      if (audioTrack) tracks.push({ role: 'audio', init: audioTrack.map && { url: audioTrack.map.url, range: audioTrack.map.range }, segments: audioTrack.segments });
    } else {
      const v = d.video.length ? choose(d.video, quality) : null;
      const a = d.audio[0] || null;
      chosen = v || a;
      if (v) tracks.push({ role: a ? 'video' : 'media', init: v.init && { url: v.init }, segments: v.segments.map((u) => ({ url: u })) });
      if (a) tracks.push({ role: v ? 'audio' : 'media', init: a.init && { url: a.init }, segments: a.segments.map((u) => ({ url: u })) });
    }
    const info = {
      kind: d.kind, quality: chosen.label, separate: tracks.length > 1,
      segments: tracks.reduce((n, t) => n + t.segments.length, 0),
    };
    if (onInfo) onInfo(info);

    const files = [];
    for (const t of tracks) {
      const r = await downloadTrack({ fetchFn, init: t.init, segments: t.segments, name: t.role === 'media' ? 'Media' : t.role[0].toUpperCase() + t.role.slice(1), signal, onProgress, BlobCtor: opts.BlobCtor });
      files.push({ role: t.role, suffix: t.role === 'audio' ? '.audio' : '', ext: t.role === 'audio' && r.kind === 'mp4' ? 'm4a' : EXT[r.kind] || 'bin', blob: r.blob, bytes: r.bytes });
    }
    return { files, info };
  }

  // Download one complete file (not segments) with byte progress. Returns {blob, kind, bytes}.
  // YouTube-style address (clen = full size): the server only gives a piece per request when no range is
  // asked for, so the file is fetched in range=a-b pieces and checked against clen, never saved short.
  async function downloadRanged({ fetchFn, url, clen, name, signal, onProgress, BlobCtor }) {
    const PIECE = 9 * 1024 * 1024;
    const chunks = [];
    let pos = 0;
    while (pos < clen) {
      const u = new URL(url);
      u.searchParams.set('range', `${pos}-${Math.min(pos + PIECE, clen) - 1}`);
      let buf;
      for (let attempt = 0; ; attempt++) {
        try { buf = new Uint8Array(await (await get(fetchFn, u.href, name, signal)).arrayBuffer()); if (!buf.length) throw new StreamError('NETWORK', 'empty'); break; }
        catch (e) { if (e.code === 'ABORTED' || attempt >= 2) throw e; await new Promise((r) => setTimeout(r, 300 * (attempt + 1))); }
      }
      chunks.push(buf); pos += buf.length;
      if (onProgress) onProgress({ track: name, done: pos, total: clen, bytes: pos, bytesMode: true });
    }
    const kind = sniff(chunks[0].length >= 12 ? chunks[0] : new Uint8Array(12));
    if (!kind) throw new StreamError('BAD_SEGMENT', `${name} is not media data (expired link or blocked request).`);
    return { blob: new BlobCtor(chunks), kind, bytes: pos };
  }

  async function downloadFile({ fetchFn, url, name, signal, onProgress, BlobCtor = Blob }) {
    try {
      const clen = parseInt(new URL(url).searchParams.get('clen'), 10);
      if (clen > 0 && new URL(url).searchParams.get('mime')) return await downloadRanged({ fetchFn, url, clen, name, signal, onProgress, BlobCtor });
    } catch (e) { if (e && (e.code === 'ABORTED' || e.name === 'StreamError')) throw e; }
    const res = await get(fetchFn, url, name, signal);
    const total = parseInt(res.headers && res.headers.get && res.headers.get('content-length'), 10) || 0;
    const chunks = [];
    let bytes = 0;
    try {
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value); bytes += value.length;
          if (onProgress) onProgress({ track: name, done: bytes, total, bytes, bytesMode: true });
        }
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        chunks.push(buf); bytes = buf.length;
        if (onProgress) onProgress({ track: name, done: bytes, total: bytes, bytes, bytesMode: true });
      }
    } catch (e) {
      if (signal && signal.aborted) throw new StreamError('ABORTED', 'Download canceled.');
      throw new StreamError('NETWORK', `${name} was interrupted (network error).`);
    }
    if (!bytes) throw new StreamError('BAD_SEGMENT', `${name} is empty.`);
    if (total && bytes < total) throw new StreamError('NETWORK', `${name} was cut short (${bytes} of ${total} bytes).`);
    const head = chunks[0];
    if (head[0] === 0x3c || (head[0] === 0x7b && /^\{\s*"/.test(String.fromCharCode(...head.slice(0, 8))))) {
      throw new StreamError('BAD_SEGMENT', `${name} is an HTML/JSON page, not media (expired link or blocked request).`);
    }
    const kind = sniff(head.length >= 12 ? head : new Uint8Array(12));
    if (!kind) throw new StreamError('BAD_SEGMENT', `${name} is not media data (it looks like an error page or an unsupported container).`);
    return { blob: new BlobCtor(chunks), kind, bytes };
  }

  // A video-only file and an audio-only file, each downloaded completely.
  // Resolves {files:[{role,suffix,ext,blob,bytes}], info}; the caller merges or saves them.
  async function downloadPair(opts) {
    const { url, audioUrl, signal, onProgress, onInfo } = opts;
    const fetchFn = opts.fetchFn || ((...a) => fetch(...a));
    if (onInfo) onInfo({ kind: 'file', quality: 'video + audio', separate: true, segments: 2 });
    const v = await downloadFile({ fetchFn, url, name: 'Video', signal, onProgress, BlobCtor: opts.BlobCtor });
    const a = await downloadFile({ fetchFn, url: audioUrl, name: 'Audio', signal, onProgress, BlobCtor: opts.BlobCtor });
    const ext = (r, audio) => (r.kind === 'mp4' ? (audio ? 'm4a' : 'mp4') : r.kind === 'aac' ? 'aac' : EXT[r.kind] || 'bin');
    return { files: [
      { role: 'video', suffix: '', ext: ext(v, false), blob: v.blob, bytes: v.bytes },
      { role: 'audio', suffix: '.audio', ext: ext(a, true), blob: a.blob, bytes: a.bytes },
    ], info: { kind: 'file', quality: 'video + audio', separate: true, segments: 2 } };
  }

  const api = { StreamError, FATAL, parseHls, parseXml, parseDash, describe, downloadStream, downloadFile, downloadPair, fetchManifest, unsupportedCodecs, sniff, fillTemplate, isoDuration };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SVDStream = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
