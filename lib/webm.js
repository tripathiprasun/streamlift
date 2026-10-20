// Merges a video-only WebM and an audio-only WebM into ONE WebM file without re-encoding
// (the compressed frames are copied as they are). YouTube serves VP9/AV1 video and Opus audio
// as separate WebM files, which is why a plain download used to give two files.
//
// Each side can be given as SEVERAL parts (a player that switches quality mid-video appends a
// new initialisation segment for every quality, and the extension records one part per quality).
// The clusters of all parts are put on one timeline; where a later part covers the same time as an
// earlier one, the later one wins (that is what the player's own buffer does).
//
// Works on Blobs: only headers and the small per-frame header are read; frame data is referenced
// with Blob.slice, so large files are not copied into memory.
// Never decrypts anything: tracks with content encryption are refused.
(function (root) {
  'use strict';

  class WebmError extends Error {
    constructor(code, message) { super(message); this.name = 'WebmError'; this.code = code; }
  }

  const ID = {
    EBML: 0x1a45dfa3, SEGMENT: 0x18538067, SEEKHEAD: 0x114d9b74, INFO: 0x1549a966, TRACKS: 0x1654ae6b,
    CUES: 0x1c53bb6b, CLUSTER: 0x1f43b675, TAGS: 0x1254c367, CHAPTERS: 0x1043a770, ATTACHMENTS: 0x1941a469,
    TIMECODE: 0xe7, SIMPLEBLOCK: 0xa3, BLOCKGROUP: 0xa0, BLOCK: 0xa1,
    TRACKENTRY: 0xae, TRACKNUMBER: 0xd7, TRACKUID: 0x73c5, TRACKTYPE: 0x83, CODECID: 0x86,
    CONTENTENCODINGS: 0x6d80, TIMECODESCALE: 0x2ad7b1, DURATION: 0x4489, MUXINGAPP: 0x4d80, WRITINGAPP: 0x5741,
    CUEPOINT: 0xbb, CUETIME: 0xb3, CUETRACKPOS: 0xb7, CUETRACK: 0xf7, CUECLUSTERPOS: 0xf1,
  };
  const SEGMENT_LEVEL = new Set([ID.CLUSTER, ID.CUES, ID.TAGS, ID.SEEKHEAD, ID.INFO, ID.TRACKS, ID.CHAPTERS, ID.ATTACHMENTS]);
  const MAX_HEADER_BOX = 4 * 1024 * 1024;     // Info / Tracks are tiny; refuse absurd sizes

  // ------------------------------------------------------------------ reading ----
  function readId(b, o) {
    if (o >= b.length) return null;
    const f = b[o];
    let len = 1, mask = 0x80;
    while (len <= 4 && !(f & mask)) { len++; mask >>= 1; }
    if (len > 4 || o + len > b.length) return null;
    let id = 0;
    for (let i = 0; i < len; i++) id = id * 256 + b[o + i];
    return { id, len };
  }
  // size -1 = "unknown size"
  function readVint(b, o) {
    if (o >= b.length) return null;
    const f = b[o];
    let len = 1, mask = 0x80;
    while (len <= 8 && !(f & mask)) { len++; mask >>= 1; }
    if (len > 8 || o + len > b.length) return null;
    let v = f & (mask - 1), ones = (f & (mask - 1)) === mask - 1;
    for (let i = 1; i < len; i++) { v = v * 256 + b[o + i]; if (b[o + i] !== 255) ones = false; }
    return { size: ones ? -1 : v, len };
  }
  function uint(b, o, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + b[o + i]; return v; }
  function float(b, o, n) {
    const dv = new DataView(b.buffer, b.byteOffset + o, n);
    return n === 4 ? dv.getFloat32(0) : n === 8 ? dv.getFloat64(0) : 0;
  }

  // Child elements of a buffer range: [{id, start, hdr, end}] (stops at the first unreadable/unknown one).
  function children(b, start, end) {
    const out = [];
    let p = start;
    while (p < end) {
      const id = readId(b, p);
      const sz = id && readVint(b, p + id.len);
      if (!id || !sz || sz.size < 0) break;
      const hdr = id.len + sz.len, e = p + hdr + sz.size;
      if (e > end) break;
      out.push({ id: id.id, start: p, hdr, end: e });
      p = e;
    }
    return out;
  }

  async function bytesAt(blob, start, end) { return new Uint8Array(await blob.slice(start, end).arrayBuffer()); }

  // One block (SimpleBlock payload or Block payload): where the frame data is and what its header said.
  function readBlock(cb, ps, pe, base) {
    const tn = readVint(cb, ps);
    if (!tn || tn.size < 0 || ps + tn.len + 3 > pe) return null;
    const rel = (cb[ps + tn.len] << 8 | cb[ps + tn.len + 1]) << 16 >> 16;       // signed 16 bit
    return { track: tn.size, rel, flags: cb[ps + tn.len + 2], ds: base + ps + tn.len + 3, de: base + pe, extras: null };
  }

  function parseCluster(cb, base) {
    let tc = 0;
    const blocks = [];
    for (const c of children(cb, 0, cb.length)) {
      if (c.id === ID.TIMECODE) tc = uint(cb, c.start + c.hdr, c.end - c.start - c.hdr);
      else if (c.id === ID.SIMPLEBLOCK) {
        const r = readBlock(cb, c.start + c.hdr, c.end, base);
        if (r) blocks.push(r);
      } else if (c.id === ID.BLOCKGROUP) {
        let r = null;
        const extras = [];
        for (const k of children(cb, c.start + c.hdr, c.end)) {
          if (k.id === ID.BLOCK) r = readBlock(cb, k.start + k.hdr, k.end, base);
          else extras.push(cb.slice(k.start, k.end));
        }
        if (r) { r.extras = extras; blocks.push(r); }
      }
    }
    for (const b of blocks) b.abs = tc + b.rel;
    if (!blocks.length) return null;
    let start = Infinity, end = -Infinity;
    for (const b of blocks) { if (b.abs < start) start = b.abs; if (b.abs > end) end = b.abs; }
    return { tc, blocks, start, end };
  }

  function parseTracks(tb) {
    const tracks = [];
    for (const te of children(tb, 0, tb.length).filter((c) => c.id === ID.TRACKENTRY)) {
      const t = { number: 0, uid: 0, type: 0, codec: '', kids: [] };
      for (const k of children(tb, te.start + te.hdr, te.end)) {
        const ps = k.start + k.hdr, n = k.end - ps;
        if (k.id === ID.TRACKNUMBER) t.number = uint(tb, ps, n);
        else if (k.id === ID.TRACKUID) t.uid = uint(tb, ps, n);
        else if (k.id === ID.CONTENTENCODINGS) throw new WebmError('ENCRYPTED', 'The file uses content encoding/encryption. Such media is not merged by this extension.');
        else {
          if (k.id === ID.TRACKTYPE) t.type = uint(tb, ps, n);
          else if (k.id === ID.CODECID) t.codec = String.fromCharCode(...tb.slice(ps, ps + n));
          t.kids.push(tb.slice(k.start, k.end));         // everything but number/uid is copied as it is
        }
      }
      tracks.push(t);
    }
    return tracks;
  }

  // Reads one WebM file (a Blob). Resolves {blob, ebmlEnd, scale, tracks, clusters}.
  async function parseWebm(blob, label) {
    const head = await bytesAt(blob, 0, 64);
    if (!(head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3)) {
      throw new WebmError('BAD_FILE', `The ${label} file is not a WebM file.`);
    }
    const eid = readId(head, 0), esz = readVint(head, eid.len);
    const ebmlEnd = eid.len + esz.len + esz.size;
    const sh = await bytesAt(blob, ebmlEnd, ebmlEnd + 16);
    const sid = readId(sh, 0), ssz = sid && readVint(sh, sid.len);
    if (!sid || sid.id !== ID.SEGMENT || !ssz) throw new WebmError('BAD_FILE', `The ${label} file has no Segment.`);
    let pos = ebmlEnd + sid.len + ssz.len;
    const out = { blob, ebmlEnd, scale: 1000000, tracks: null, clusters: [] };
    const size = blob.size;
    while (pos < size) {
      const h = await bytesAt(blob, pos, Math.min(pos + 16, size));
      const id = readId(h, 0), sz = id && readVint(h, id.len);
      if (!id || !sz) break;
      const hdr = id.len + sz.len, ps = pos + hdr;
      if (id.id === ID.CLUSTER) {
        let end;
        if (sz.size >= 0) end = Math.min(ps + sz.size, size);
        else {                                   // unknown size (live): runs until the next segment-level element
          end = ps;
          while (end < size) {
            const hh = await bytesAt(blob, end, Math.min(end + 16, size));
            const i2 = readId(hh, 0), s2 = i2 && readVint(hh, i2.len);
            if (!i2 || !s2 || s2.size < 0 || SEGMENT_LEVEL.has(i2.id)) break;
            end += i2.len + s2.len + s2.size;
          }
          end = Math.min(end, size);
        }
        const cl = parseCluster(await bytesAt(blob, ps, end), ps);
        if (cl) out.clusters.push(cl);
        pos = Math.max(end, ps);
      } else if (id.id === ID.INFO || id.id === ID.TRACKS) {
        if (sz.size < 0 || sz.size > MAX_HEADER_BOX || ps + sz.size > size) break;
        const b = await bytesAt(blob, ps, ps + sz.size);
        if (id.id === ID.TRACKS) out.tracks = parseTracks(b);
        else {
          for (const c of children(b, 0, b.length)) {
            if (c.id === ID.TIMECODESCALE) out.scale = uint(b, c.start + c.hdr, c.end - c.start - c.hdr) || 1000000;
          }
        }
        pos = ps + sz.size;
      } else {
        if (sz.size < 0) break;
        pos = ps + sz.size;
      }
    }
    if (!out.tracks || !out.tracks.length) throw new WebmError('BAD_FILE', `The ${label} file has no Tracks (the initialisation segment is missing).`);
    return out;
  }

  // ------------------------------------------------------------------ writing ----
  function concat(chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
  function encId(id) {
    const out = [];
    for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
    return Uint8Array.from(out);
  }
  function encVint(n, fixedLen) {
    let len = fixedLen || 1;
    while (!fixedLen && len < 8 && n > Math.pow(2, 7 * len) - 2) len++;
    const b = new Uint8Array(len);
    let v = n;
    for (let i = len - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
    b[0] |= 1 << (8 - len);
    return b;
  }
  function elem(id, payload) { return concat([encId(id), encVint(payload.length), payload]); }
  function encUint(n, fixedLen) {
    const out = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
    while (out.length < (fixedLen || 1)) out.unshift(0);
    return Uint8Array.from(out);
  }
  function encFloat64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; }
  const ascii = (s) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 127));

  // TrackEntry with a new number and uid; everything else is copied as it is.
  function buildTrackEntry(t, number) {
    return elem(ID.TRACKENTRY, concat([
      elem(ID.TRACKNUMBER, encUint(number)),
      elem(ID.TRACKUID, encUint(0x1000 + number, 2)),
      ...t.kids,
    ]));
  }

  // Cluster-level pieces for one block with its new track number and a timecode relative to the cluster.
  function blockPieces(b, blob, number, clusterTc) {
    const rel = b.abs - clusterTc;
    const h3 = Uint8Array.from([0x80 | number, (rel >> 8) & 255, rel & 255, b.flags]);
    const dataLen = b.de - b.ds;
    const data = blob.slice(b.ds, b.de);
    const blockPayloadLen = 4 + dataLen;
    if (!b.extras) {
      const head = concat([encId(ID.SIMPLEBLOCK), encVint(blockPayloadLen), h3]);
      return { pieces: [head, data], len: head.length + dataLen };
    }
    const blockHead = concat([encId(ID.BLOCK), encVint(blockPayloadLen), h3]);
    const inner = blockHead.length + dataLen + b.extras.reduce((n, e) => n + e.length, 0);
    const head = concat([encId(ID.BLOCKGROUP), encVint(inner), blockHead]);
    return { pieces: [head, data, ...b.extras], len: head.length + dataLen + b.extras.reduce((n, e) => n + e.length, 0) };
  }

  // ------------------------------------------------------------- timeline ----
  // Puts the clusters of several parts on one timeline. A later part replaces earlier clusters that
  // start inside the time it covers (the player's buffer works the same way).
  function keptClusters(parts, eps) {
    let kept = [];
    parts.forEach((p, pi) => {
      const cls = p.clusters.slice().sort((a, b) => a.start - b.start).map((cl) => ({ cl, part: p }));
      if (pi > 0) kept = kept.filter((k) => !cls.some((c) => k.cl.start >= c.cl.start - eps && k.cl.start <= c.cl.end));
      kept = kept.concat(cls);
    });
    return kept.sort((a, b) => a.cl.start - b.cl.start);
  }

  function pickTrack(part, type, label) {
    const t = part.tracks.find((x) => x.type === type);
    if (!t) throw new WebmError('BAD_FILE', `The ${label} file has no ${type === 1 ? 'video' : 'audio'} track.`);
    return t;
  }

  // Merge video parts and audio parts (arrays of Blobs, in the order the player appended them).
  // Either array may be empty (then the parts of the other kind are just joined into one file).
  // Resolves a Blob (video/webm). Rejects with WebmError.
  async function mergeWebm(videoBlobs, audioBlobs, BlobCtor) {
    const B = BlobCtor || Blob;
    const kinds = [];
    if (videoBlobs && videoBlobs.length) kinds.push({ type: 1, label: 'video', blobs: videoBlobs });
    if (audioBlobs && audioBlobs.length) kinds.push({ type: 2, label: 'audio', blobs: audioBlobs });
    if (!kinds.length) throw new WebmError('BAD_FILE', 'Nothing to merge.');

    for (const k of kinds) {
      k.parts = [];
      for (const b of k.blobs) k.parts.push(await parseWebm(b, k.label));
      k.track = pickTrack(k.parts[0], k.type, k.label);
      for (const p of k.parts) {
        const t = pickTrack(p, k.type, k.label);
        if (t.codec !== k.track.codec) throw new WebmError('UNSUPPORTED', `The ${k.label} changed codec while playing (${k.track.codec} / ${t.codec}), so it cannot be joined into one track.`);
        // only the blocks of the track we use
        p.use = t.number;
      }
    }
    const scale = kinds[0].parts[0].scale;
    for (const k of kinds) for (const p of k.parts) {
      if (p.scale !== scale) throw new WebmError('UNSUPPORTED', 'The audio and video files use different time scales.');
    }
    const eps = Math.max(1, Math.round(0.01 * 1e9 / scale));    // 10 ms

    // blocks of every kind, in time order, with the new track number
    const all = [];
    kinds.forEach((k, ki) => {
      k.number = kinds.length === 1 ? 1 : ki + 1;
      k.kept = keptClusters(k.parts, eps).map((x) => ({
        cl: x.cl, part: x.part,
        blocks: x.cl.blocks.filter((b) => b.track === x.part.use),
      })).filter((x) => x.blocks.length);
      if (!k.kept.length) throw new WebmError('BAD_FILE', `The ${k.label} file has no frames.`);
      for (const x of k.kept) for (const b of x.blocks) all.push({ b, blob: x.part.blob, number: k.number, ki });
    });
    all.sort((a, b) => (a.b.abs - b.b.abs) || (a.ki - b.ki));

    // cluster boundaries: the clusters of the first kind (video if there is one)
    const bounds = kinds[0].kept.map((x) => x.cl.start);
    const first = all[0].b.abs;
    if (!bounds.length || bounds[0] > first) bounds.unshift(first);
    else bounds[0] = Math.min(bounds[0], first);

    const clusters = [];       // {tc, pieces, len, videoStart}
    let cur = null, bi = 0;
    for (const x of all) {
      while (bi + 1 < bounds.length && bounds[bi + 1] <= x.b.abs) bi++;
      const wantTc = bounds[bi];
      if (!cur || cur.boundIndex !== bi || x.b.abs - cur.tc > 30000) {
        cur = { tc: cur && cur.boundIndex === bi ? x.b.abs : wantTc, boundIndex: bi, blocks: [], len: 0, pieces: [] };
        clusters.push(cur);
      }
      cur.blocks.push(x);
    }
    let maxAbs = 0;
    for (const c of clusters) {
      const tcEl = elem(ID.TIMECODE, encUint(c.tc));
      const pieces = [tcEl];
      let len = tcEl.length;
      for (const x of c.blocks) {
        if (x.b.abs > maxAbs) maxAbs = x.b.abs;
        const bp = blockPieces(x.b, x.blob, x.number, c.tc);
        pieces.push(...bp.pieces); len += bp.len;
      }
      const head = concat([encId(ID.CLUSTER), encVint(len)]);
      c.pieces = [head, ...pieces]; c.len = head.length + len;
    }

    // header parts
    const info = elem(ID.INFO, concat([
      elem(ID.TIMECODESCALE, encUint(scale)),
      elem(ID.DURATION, encFloat64(maxAbs)),
      elem(ID.MUXINGAPP, ascii('Streamlift')),
      elem(ID.WRITINGAPP, ascii('Streamlift')),
    ]));
    const tracks = elem(ID.TRACKS, concat(kinds.map((k) => buildTrackEntry(k.track, k.number))));
    const cueTrack = kinds[0].number;
    const cuesLen = (n) => { const p = 19 * n; return encId(ID.CUES).length + encVint(p).length + p; };
    const total = info.length + tracks.length + clusters.reduce((n, c) => n + c.len, 0);
    const withCues = total + cuesLen(clusters.length) < 0xffffffff && clusters.length > 0;
    let cues = new Uint8Array(0);
    if (withCues) {
      let pos = info.length + tracks.length + cuesLen(clusters.length);
      const pts = [];
      for (const c of clusters) {
        pts.push(elem(ID.CUEPOINT, concat([
          elem(ID.CUETIME, encUint(c.tc, 4)),
          elem(ID.CUETRACKPOS, concat([elem(ID.CUETRACK, encUint(cueTrack)), elem(ID.CUECLUSTERPOS, encUint(pos, 4))])),
        ])));
        pos += c.len;
      }
      cues = elem(ID.CUES, concat(pts));
    }
    const segLen = info.length + tracks.length + cues.length + clusters.reduce((n, c) => n + c.len, 0);
    const seg = concat([encId(ID.SEGMENT), encVint(segLen, 8)]);

    const ebml = kinds[0].parts[0].blob.slice(0, kinds[0].parts[0].ebmlEnd);
    const out = [ebml, seg, info, tracks, cues];
    for (const c of clusters) out.push(...c.pieces);
    return new B(out, { type: 'video/webm' });
  }

  const isWebm = (b) => !!b && b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;


  // ------------------------------------------------------ Opus WebM -> fragmented MP4 ----
  // YouTube's best audio is Opus in WebM, but its best video is often H.264 in MP4. MP4 can carry Opus, so the
  // Opus frames are copied (not re-encoded) into a fragmented MP4 audio file that SVDMux.mergeMp4 can join to the video.
  const u32b = (n) => Uint8Array.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
  const u16b = (n) => Uint8Array.from([(n >>> 8) & 255, n & 255]);
  const fcc = (s) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0)));
  const zeros = (n) => new Uint8Array(n);
  function box(type, ...payload) {
    const body = concat(payload);
    return concat([u32b(8 + body.length), fcc(type), body]);
  }
  const fullBox = (type, flags, ...payload) => box(type, u32b(flags), ...payload);   // version in the top byte of `flags`

  async function opusToMp4(blob) {
    const w = await parseWebm(blob, 'audio');
    const track = w.tracks.find((t) => t.type === 2);
    if (!track || track.codec !== 'A_OPUS') throw new WebmError('UNSUPPORTED', 'The audio is not Opus, so it cannot be put into an MP4.');
    // OpusHead (CodecPrivate 0x63a2) and channel count
    let head = null, channels = 2;
    for (const k of track.kids) {
      const id = readId(k, 0), sz = readVint(k, id.len), ps = id.len + sz.len;
      if (id.id === 0x63a2) head = k.slice(ps);
      else if (id.id === 0xe1) for (const c of children(k, ps, k.length)) if (c.id === 0x9f) channels = uint(k, c.start + c.hdr, c.end - c.start - c.hdr);
    }
    if (!head || head.length < 19 || String.fromCharCode(...head.slice(0, 8)) !== 'OpusHead') throw new WebmError('BAD_FILE', 'The Opus audio has no OpusHead header.');
    const dops = box('dOps', Uint8Array.from([0, head[9]]), head.slice(10, 12).reverse(), head.slice(12, 16).reverse(), head.slice(16, 18).reverse(), head.slice(18));
    const dopsFixed = dops;       // (little-endian fields of OpusHead are swapped to big-endian above)
    const entry = box('Opus', zeros(6), u16b(1), zeros(8), u16b(head[9] || channels), u16b(16), zeros(4), u32b(48000 * 65536), dopsFixed);
    const rate = 48000;
    const matrix = concat([u32b(0x10000), zeros(12), u32b(0x10000), zeros(12), u32b(0x40000000)]);
    const moov = box('moov',
      fullBox('mvhd', 0, zeros(8), u32b(1000), u32b(0), u32b(0x10000), u16b(0x100), zeros(10), matrix, zeros(24), u32b(2)),
      box('trak',
        fullBox('tkhd', 7, zeros(8), u32b(1), zeros(4), u32b(0), zeros(8), u16b(0), u16b(0), u16b(0x100), u16b(0), matrix, u32b(0), u32b(0)),
        box('mdia',
          fullBox('mdhd', 0, zeros(8), u32b(rate), u32b(0), u16b(0x55c4), u16b(0)),
          fullBox('hdlr', 0, zeros(4), fcc('soun'), zeros(12), fcc('SoundHandler'), zeros(1)),
          box('minf',
            fullBox('smhd', 0, zeros(4)),
            box('dinf', fullBox('dref', 0, u32b(1), fullBox('url ', 1))),
            box('stbl', fullBox('stsd', 0, u32b(1), entry), fullBox('stts', 0, u32b(0)), fullBox('stsc', 0, u32b(0)), fullBox('stsz', 0, u32b(0), u32b(0)), fullBox('stco', 0, u32b(0)))))),
      box('mvex', fullBox('trex', 0, u32b(1), u32b(1), u32b(0), u32b(0), u32b(0))));
    const ftyp = box('ftyp', fcc('iso5'), u32b(512), fcc('iso5'), fcc('iso6'), fcc('mp41'));

    const parts = [ftyp, moov];
    let seq = 1, prev = null;                      // prev: last block's end, to give the final frame a duration
    const toTicks = (abs) => Math.round(abs * w.scale / 1e9 * rate);
    // Frames in the order they were appended; a frame seen twice (the player re-loaded that part) keeps the last copy.
    const byTime = new Map();
    for (const cl of w.clusters) for (const b of cl.blocks) if (b.track === track.number) byTime.set(b.abs, b);
    const allBlocks = Array.from(byTime.values()).sort((a, b) => a.abs - b.abs);
    const groups = [];
    for (let i = 0; i < allBlocks.length; i += 250) groups.push(allBlocks.slice(i, i + 250));
    for (const blocks of groups) {
      if (!blocks.length) continue;
      const sizes = [], durs = [];
      for (let i = 0; i < blocks.length; i++) {
        if (blocks[i].flags & 0x06) throw new WebmError('UNSUPPORTED', 'The Opus audio uses lacing, which is not supported.');
        sizes.push(blocks[i].de - blocks[i].ds);
        const t0 = toTicks(blocks[i].abs);
        const t1 = i + 1 < blocks.length ? toTicks(blocks[i + 1].abs) : t0 + (durs.length ? durs[durs.length - 1] : 960);
        durs.push(Math.max(1, t1 - t0));
      }
      const base = toTicks(blocks[0].abs);
      const mfhd = fullBox('mfhd', 0, u32b(seq++));
      const tfhd = fullBox('tfhd', 0x020000, u32b(1));
      const tfdt = fullBox('tfdt', 0x01000000, u32b(Math.floor(base / 4294967296)), u32b(base >>> 0));
      const rows = [];
      for (let i = 0; i < blocks.length; i++) rows.push(u32b(durs[i]), u32b(sizes[i]));
      const mk = (off) => box('moof', mfhd, box('traf', tfhd, tfdt, fullBox('trun', 0x000301, u32b(blocks.length), u32b(off), ...rows)));
      const dataOff = mk(0).length + 8;
      parts.push(mk(dataOff));
      const total = sizes.reduce((a, b) => a + b, 0);
      parts.push(concat([u32b(8 + total), fcc('mdat')]));
      for (const b of blocks) parts.push(blob.slice(b.ds, b.de));
    }
    if (parts.length <= 2) throw new WebmError('BAD_FILE', 'The audio has no frames.');
    return new Blob(parts, { type: 'audio/mp4' });
  }

  const api = { WebmError, mergeWebm, isWebm, opusToMp4 };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SVDWebm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
