// Turns a video-only MP4 + an audio-only M4A (what Instagram serves) into ONE WebM file.
//
//   picture: VP9 or AV1 frames are COPIED (not re-encoded) from the MP4 into the WebM.
//            H.264/HEVC cannot be stored in WebM, so those are refused (the caller keeps the MP4 merge).
//   sound:   AAC cannot be stored in WebM either, so the audio is decoded by the browser and re-encoded to Opus
//            (WebCodecs AudioEncoder, 128 kbit/s). Audio is a small part of the file, so this is quick.
//
// Why: the merged fragmented MP4 can stutter in some players/browsers; a WebM with a proper index (Cues)
// seeks and plays smoothly. The caller falls back to the plain MP4 merge if anything here throws.
//
// Works on Blobs: only the sample tables are read; frame data is referenced with Blob.slice.
// Never touches encrypted media.
(function (root) {
  'use strict';

  class ToWebmError extends Error {
    constructor(code, message) { super(message); this.name = 'ToWebmError'; this.code = code; }
  }

  // ---------------------------------------------------------------- bytes ----
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const i32 = (b, o) => u32(b, o) | 0;
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const u16 = (b, o) => (b[o] << 8) | b[o + 1];
  const cc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function concat(chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
  function hasFourcc(b, name) {
    for (let i = 0; i + 3 < b.length; i++) if (b[i] === name.charCodeAt(0) && b[i + 1] === name.charCodeAt(1) && b[i + 2] === name.charCodeAt(2) && b[i + 3] === name.charCodeAt(3)) return true;
    return false;
  }

  // ---------------------------------------------------------- box parsing ----
  function kids(buf, start, end) {
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = u32(buf, p), hdr = 8;
      const type = cc(buf, p + 4);
      if (size === 1) { if (p + 16 > end) break; size = u64(buf, p + 8); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      out.push({ type, start: p, end: p + size, hdr });
      p += size;
    }
    return out;
  }
  const kidsOf = (buf, box) => kids(buf, box.start + box.hdr, box.end);
  const sub = (buf, box, type) => box && kidsOf(buf, box).find((k) => k.type === type);
  const subs = (buf, box, type) => (box ? kidsOf(buf, box).filter((k) => k.type === type) : []);

  async function topBoxes(blob) {
    const out = [];
    let pos = 0;
    const size = blob.size;
    while (pos + 8 <= size) {
      const h = new Uint8Array(await blob.slice(pos, Math.min(pos + 16, size)).arrayBuffer());
      let sz = u32(h, 0), hdr = 8;
      const type = cc(h, 4);
      if (sz === 1) { if (h.length < 16) break; sz = u64(h, 8); hdr = 16; }
      else if (sz === 0) sz = size - pos;
      if (sz < hdr) break;
      out.push({ type, start: pos, size: Math.min(sz, size - pos), hdr, truncated: pos + sz > size });
      pos += sz;
    }
    return out;
  }
  const bytesOf = async (blob, b) => new Uint8Array(await blob.slice(b.start, b.start + b.size).arrayBuffer());

  // ----------------------------------------------------- MP4 video samples ----
  // Resolves {fourcc, width, height, timescale, config, mediaTime, samples:[{off,size,dts,cts,key}]}
  async function readMp4Video(blob) {
    const boxes = await topBoxes(blob);
    const moovBox = boxes.find((b) => b.type === 'moov' && !b.truncated);
    if (!moovBox) throw new ToWebmError('BAD_FILE', 'The video file has no complete moov box.');
    const moov = await bytesOf(blob, moovBox);
    if (hasFourcc(moov, 'pssh') || hasFourcc(moov, 'encv') || hasFourcc(moov, 'sinf')) throw new ToWebmError('ENCRYPTED', 'The video is encrypted.');
    const moovB = { start: 0, end: moov.length, hdr: moovBox.hdr };
    const trak = subs(moov, moovB, 'trak').find((t) => {
      const h = sub(moov, sub(moov, t, 'mdia'), 'hdlr');
      return h && cc(moov, h.start + h.hdr + 8) === 'vide';
    });
    if (!trak) throw new ToWebmError('BAD_FILE', 'The video file has no video track.');
    const tkhd = sub(moov, trak, 'tkhd');
    const trackId = u32(moov, tkhd.start + tkhd.hdr + 4 + (moov[tkhd.start + tkhd.hdr] === 1 ? 16 : 8));
    const mdia = sub(moov, trak, 'mdia');
    const mdhd = sub(moov, mdia, 'mdhd');
    const timescale = u32(moov, mdhd.start + mdhd.hdr + 4 + (moov[mdhd.start + mdhd.hdr] === 1 ? 16 : 8)) || 1000;
    const stbl = sub(moov, sub(moov, mdia, 'minf'), 'stbl');
    if (!stbl) throw new ToWebmError('BAD_FILE', 'The video track has no sample table.');
    const stsd = sub(moov, stbl, 'stsd');
    const entry = stsd && kids(moov, stsd.start + stsd.hdr + 8, stsd.end)[0];
    if (!entry) throw new ToWebmError('BAD_FILE', 'The video track has no sample description.');
    const ep = entry.start + entry.hdr;
    const fourcc = entry.type;
    const width = u16(moov, ep + 24), height = u16(moov, ep + 26);
    let config = null;
    for (const k of kids(moov, ep + 78, entry.end)) {
      if (k.type === 'av1C' || k.type === 'vpcC') config = { type: k.type, bytes: moov.slice(k.start + k.hdr, k.end) };
    }
    if (fourcc !== 'vp09' && fourcc !== 'av01') {
      throw new ToWebmError('UNSUPPORTED', `The video is ${fourcc === 'avc1' || fourcc === 'avc3' ? 'H.264' : fourcc === 'hvc1' || fourcc === 'hev1' ? 'HEVC' : fourcc}, which WebM cannot hold.`);
    }
    // edit list: the media time where the presentation starts (compensates picture reordering delay)
    let mediaTime = 0;
    const elst = sub(moov, sub(moov, trak, 'edts'), 'elst');
    if (elst) {
      const v = moov[elst.start + elst.hdr];
      if (u32(moov, elst.start + elst.hdr + 4) > 0) {
        const o = elst.start + elst.hdr + 8;
        const mt = v === 1 ? u64(moov, o + 8) : i32(moov, o + 4);
        if (mt > 0) mediaTime = mt;
      }
    }

    const samples = [];
    const stsz = sub(moov, stbl, 'stsz'), stco = sub(moov, stbl, 'stco') || sub(moov, stbl, 'co64');
    const nProg = stsz ? u32(moov, stsz.start + stsz.hdr + 8) : 0;
    if (nProg > 0 && stco) {
      // ---- progressive: tables in moov
      const fixed = u32(moov, stsz.start + stsz.hdr + 4);
      const size = (i) => (fixed ? fixed : u32(moov, stsz.start + stsz.hdr + 12 + 4 * i));
      const stsc = sub(moov, stbl, 'stsc');
      const nsc = u32(moov, stsc.start + stsc.hdr + 4);
      const sc = [];
      for (let i = 0; i < nsc; i++) { const o = stsc.start + stsc.hdr + 8 + 12 * i; sc.push({ first: u32(moov, o), per: u32(moov, o + 4) }); }
      const nco = u32(moov, stco.start + stco.hdr + 4), is64 = stco.type === 'co64';
      let s = 0, ci = 0;
      for (; ci < nco && s < nProg; ci++) {
        let per = sc[0].per;
        for (const e of sc) if (e.first <= ci + 1) per = e.per;
        let off = is64 ? u64(moov, stco.start + stco.hdr + 8 + 8 * ci) : u32(moov, stco.start + stco.hdr + 8 + 4 * ci);
        for (let j = 0; j < per && s < nProg; j++, s++) { const sz = size(s); samples.push({ off, size: sz, dts: 0, cts: 0, key: true }); off += sz; }
      }
      const stts = sub(moov, stbl, 'stts');
      let t = 0, si = 0;
      const nst = stts ? u32(moov, stts.start + stts.hdr + 4) : 0;
      for (let i = 0; i < nst; i++) {
        const cnt = u32(moov, stts.start + stts.hdr + 8 + 8 * i), d = u32(moov, stts.start + stts.hdr + 12 + 8 * i);
        for (let j = 0; j < cnt && si < samples.length; j++, si++) { samples[si].dts = t; t += d; }
      }
      const ctts = sub(moov, stbl, 'ctts');
      if (ctts) {
        const n = u32(moov, ctts.start + ctts.hdr + 4);
        si = 0;
        for (let i = 0; i < n; i++) {
          const cnt = u32(moov, ctts.start + ctts.hdr + 8 + 8 * i), d = i32(moov, ctts.start + ctts.hdr + 12 + 8 * i);
          for (let j = 0; j < cnt && si < samples.length; j++, si++) samples[si].cts = d;
        }
      }
      const stss = sub(moov, stbl, 'stss');
      if (stss) {
        for (const x of samples) x.key = false;
        const n = u32(moov, stss.start + stss.hdr + 4);
        for (let i = 0; i < n; i++) { const k = u32(moov, stss.start + stss.hdr + 8 + 4 * i) - 1; if (samples[k]) samples[k].key = true; }
      }
    } else {
      // ---- fragmented: moof+mdat pairs
      const trex = {};
      for (const t of subs(moov, sub(moov, moovB, 'mvex'), 'trex')) {
        const o = t.start + t.hdr + 4;
        trex[u32(moov, o)] = { dur: u32(moov, o + 8), size: u32(moov, o + 12), flags: u32(moov, o + 16) };
      }
      let running = 0;
      for (let i = 0; i < boxes.length; i++) {
        const mb = boxes[i];
        if (mb.type !== 'moof' || mb.truncated) continue;
        const next = boxes[i + 1];
        if (!next || next.type !== 'mdat' || next.truncated) continue;           // unfinished fragment: dropped
        const moof = await bytesOf(blob, mb);
        const moofB = { start: 0, end: moof.length, hdr: mb.hdr };
        for (const traf of subs(moof, moofB, 'traf')) {
          const tfhd = sub(moof, traf, 'tfhd');
          const fl = u32(moof, tfhd.start + tfhd.hdr) & 0xffffff;
          if (u32(moof, tfhd.start + tfhd.hdr + 4) !== trackId) continue;
          let o = tfhd.start + tfhd.hdr + 8, baseOff = mb.start;
          if (fl & 1) { baseOff = u64(moof, o); o += 8; }
          if (fl & 2) o += 4;
          const def = Object.assign({ dur: 0, size: 0, flags: 0 }, trex[trackId]);
          if (fl & 8) { def.dur = u32(moof, o); o += 4; }
          if (fl & 0x10) { def.size = u32(moof, o); o += 4; }
          if (fl & 0x20) { def.flags = u32(moof, o); o += 4; }
          const tfdt = sub(moof, traf, 'tfdt');
          if (tfdt) running = moof[tfdt.start + tfdt.hdr] === 1 ? u64(moof, tfdt.start + tfdt.hdr + 4) : u32(moof, tfdt.start + tfdt.hdr + 4);
          let dataPos = null;
          for (const trun of subs(moof, traf, 'trun')) {
            const ver = moof[trun.start + trun.hdr];
            const f = u32(moof, trun.start + trun.hdr) & 0xffffff, n = u32(moof, trun.start + trun.hdr + 4);
            let p = trun.start + trun.hdr + 8;
            if (f & 1) { dataPos = baseOff + i32(moof, p); p += 4; } else if (dataPos === null) dataPos = baseOff;
            let first = null;
            if (f & 4) { first = u32(moof, p); p += 4; }
            for (let j = 0; j < n; j++) {
              const dur = f & 0x100 ? u32(moof, p) : def.dur; if (f & 0x100) p += 4;
              const size = f & 0x200 ? u32(moof, p) : def.size; if (f & 0x200) p += 4;
              let flags = def.flags;
              if (f & 0x400) { flags = u32(moof, p); p += 4; } else if (j === 0 && first !== null) flags = first;
              let cto = 0;
              if (f & 0x800) { cto = ver === 1 ? i32(moof, p) : u32(moof, p); p += 4; }
              samples.push({ off: dataPos, size, dts: running, cts: cto, key: !(flags & 0x10000) });
              dataPos += size; running += dur;
            }
          }
        }
      }
    }
    if (!samples.length) throw new ToWebmError('BAD_FILE', 'The video has no frames.');
    for (const s of samples) if (s.off + s.size > blob.size) throw new ToWebmError('BAD_FILE', 'The video file is incomplete (its media data is cut off).');
    if (!samples.some((s) => s.key)) samples[0].key = true;
    return { fourcc, width, height, timescale, config, mediaTime, samples };
  }

  // ------------------------------------------------------- AAC -> Opus ----
  // The browser decodes the M4A (and resamples it to 48 kHz); WebCodecs encodes Opus.
  // deps (for tests): { OfflineAudioContext, AudioEncoder, AudioData }
  async function audioToOpus(blob, deps, onProgress) {
    const D = deps || root;
    if (!D.OfflineAudioContext || !D.AudioEncoder || !D.AudioData) throw new ToWebmError('UNSUPPORTED', 'This browser cannot encode Opus audio (WebCodecs is missing).');
    const RATE = 48000;
    const raw = await blob.arrayBuffer();
    let decoded;
    try {
      decoded = await new D.OfflineAudioContext(2, RATE, RATE).decodeAudioData(raw);   // result is resampled to the context rate
    } catch (e) { throw new ToWebmError('DECODE', 'The browser could not decode the audio (' + (e && e.message ? e.message : e) + ').'); }
    const ch = Math.min(decoded.numberOfChannels, 2);
    const total = decoded.length;
    if (!total) throw new ToWebmError('BAD_FILE', 'The audio has no samples.');

    const frames = [];
    let description = null, failure = null;
    const enc = new D.AudioEncoder({
      output: (chunk, meta) => {
        const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d);
        frames.push({ t: chunk.timestamp / 1000, dur: (chunk.duration || 20000) / 1000, data: d });
        const dc = meta && meta.decoderConfig;
        if (dc && dc.description && !description) description = new Uint8Array(dc.description.buffer ? dc.description.buffer.slice(dc.description.byteOffset, dc.description.byteOffset + dc.description.byteLength) : dc.description);
      },
      error: (e) => { failure = e; },
    });
    try { enc.configure({ codec: 'opus', sampleRate: RATE, numberOfChannels: ch, bitrate: 128000 }); }
    catch (e) { throw new ToWebmError('UNSUPPORTED', 'This browser cannot encode Opus audio (' + (e && e.message ? e.message : e) + ').'); }
    const planes = [];
    for (let c = 0; c < ch; c++) planes.push(decoded.getChannelData(c));
    const STEP = 48000;          // one second per call
    for (let pos = 0; pos < total; pos += STEP) {
      if (failure) break;
      const n = Math.min(STEP, total - pos);
      const data = new Float32Array(n * ch);
      for (let c = 0; c < ch; c++) data.set(planes[c].subarray(pos, pos + n), c * n);
      const ad = new D.AudioData({ format: 'f32-planar', sampleRate: RATE, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(pos / RATE * 1e6), data });
      enc.encode(ad); ad.close();
      if (onProgress) onProgress(pos / total);
      if (enc.encodeQueueSize > 50) await new Promise((r) => setTimeout(r, 0));
    }
    await enc.flush();
    try { enc.close(); } catch (e) { /* already closed */ }
    if (failure) throw new ToWebmError('ENCODE', 'Opus encoding failed (' + (failure.message || failure) + ').');
    if (!frames.length) throw new ToWebmError('ENCODE', 'Opus encoding produced no audio.');
    if (!description || description.length < 19) {          // OpusHead: standard 48 kHz header with the usual encoder delay
      const h = new Uint8Array(19);
      h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, ch, 312 & 255, 312 >> 8, RATE & 255, (RATE >> 8) & 255, (RATE >> 16) & 255, 0, 0, 0, 0]);
      description = h;
    }
    return { channels: ch, rate: RATE, head: description, frames };
  }

  // ---------------------------------------------------------------- WebM writer ----
  function encId(id) { const out = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256); return Uint8Array.from(out); }
  function encVint(n, fixedLen) {
    let len = fixedLen || 1;
    while (!fixedLen && len < 8 && n > Math.pow(2, 7 * len) - 2) len++;
    const b = new Uint8Array(len);
    let v = n;
    for (let i = len - 1; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
    b[0] |= 1 << (8 - len);
    return b;
  }
  const elem = (id, payload) => concat([encId(id), encVint(payload.length), payload]);
  function encUint(n, fixedLen) {
    const out = [];
    for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256);
    while (out.length < (fixedLen || 1)) out.unshift(0);
    return Uint8Array.from(out);
  }
  const encF64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; };
  const ascii = (s) => Uint8Array.from(Array.from(s, (c) => c.charCodeAt(0) & 127));
  const I = {
    EBML: 0x1a45dfa3, VER: 0x4286, READVER: 0x42f7, MAXID: 0x42f2, MAXSIZE: 0x42f3, DOCTYPE: 0x4282, DOCVER: 0x4287, DOCREAD: 0x4285,
    SEGMENT: 0x18538067, INFO: 0x1549a966, SCALE: 0x2ad7b1, DURATION: 0x4489, MUXAPP: 0x4d80, WRITEAPP: 0x5741,
    TRACKS: 0x1654ae6b, ENTRY: 0xae, NUMBER: 0xd7, UID: 0x73c5, TYPE: 0x83, LACING: 0x9c, CODEC: 0x86, PRIVATE: 0x63a2,
    DELAY: 0x56aa, PREROLL: 0x56bb, VIDEO: 0xe0, PW: 0xb0, PH: 0xba, AUDIO: 0xe1, FREQ: 0xb5, CHANNELS: 0x9f,
    CLUSTER: 0x1f43b675, TC: 0xe7, BLOCK: 0xa3, CUES: 0x1c53bb6b, CUEPOINT: 0xbb, CUETIME: 0xb3, CUEPOS: 0xb7, CUETRACK: 0xf7, CUECLUS: 0xf1,
  };

  // video: {codecId, config, width, height, frames:[{ms (display time), order (decode time), key, blob}]}
  // audio: {channels, rate, head, frames:[{t, data}]}
  function writeWebm(video, audio, BlobCtor) {
    const B = BlobCtor || Blob;
    const tracks = [];
    tracks.push(elem(I.ENTRY, concat([
      elem(I.NUMBER, encUint(1)), elem(I.UID, encUint(0x1001, 2)), elem(I.TYPE, encUint(1)), elem(I.LACING, encUint(0)), elem(I.CODEC, ascii(video.codecId)),
      ...(video.config ? [elem(I.PRIVATE, video.config)] : []),
      elem(I.VIDEO, concat([elem(I.PW, encUint(video.width)), elem(I.PH, encUint(video.height))])),
    ])));
    if (audio) {
      const preSkip = audio.head[10] | (audio.head[11] << 8);
      tracks.push(elem(I.ENTRY, concat([
        elem(I.NUMBER, encUint(2)), elem(I.UID, encUint(0x1002, 2)), elem(I.TYPE, encUint(2)), elem(I.LACING, encUint(0)), elem(I.CODEC, ascii('A_OPUS')),
        elem(I.PRIVATE, audio.head),
        elem(I.DELAY, encUint(Math.round(preSkip * 1e9 / 48000))), elem(I.PREROLL, encUint(80000000)),
        elem(I.AUDIO, concat([elem(I.FREQ, encF64(audio.rate)), elem(I.CHANNELS, encUint(audio.channels))])),
      ])));
    }
    // blocks in decode order; audio is placed by time
    const items = video.frames.map((f) => ({ track: 1, ms: Math.round(f.ms), key: f.key, order: f.order, blob: f.blob, size: f.blob.size }));
    if (audio) for (const f of audio.frames) items.push({ track: 2, ms: Math.round(f.t), key: true, order: f.t, data: f.data, size: f.data.length });
    items.sort((a, b) => (a.order - b.order) || (a.track - b.track));

    const clusters = [];
    let cur = null, last = 0;
    for (const x of items) {
      const newCluster = !cur || (x.track === 1 && x.key && cur.blocks > 0 && x.ms - cur.tc >= 1000) || x.ms - cur.tc > 30000 || x.ms - cur.tc < -30000;
      if (newCluster) { cur = { tc: Math.max(0, x.ms), parts: [], len: 0, blocks: 0, hasKey: false }; clusters.push(cur); }
      const rel = x.ms - cur.tc;
      const head = concat([encId(I.BLOCK), encVint(4 + x.size), Uint8Array.from([0x80 | x.track, (rel >> 8) & 255, rel & 255, x.key ? 0x80 : 0])]);
      cur.parts.push(head, x.blob || x.data); cur.len += head.length + x.size; cur.blocks++;
      if (x.track === 1 && x.key && cur.keyMs === undefined) { cur.keyMs = x.ms; cur.hasKey = true; }
      if (x.ms > last) last = x.ms;
    }
    for (const c of clusters) {
      const tc = elem(I.TC, encUint(c.tc));
      const head = concat([encId(I.CLUSTER), encVint(tc.length + c.len), tc]);
      c.out = [head, ...c.parts]; c.total = head.length + c.len;
    }
    const info = elem(I.INFO, concat([elem(I.SCALE, encUint(1000000)), elem(I.DURATION, encF64(last)), elem(I.MUXAPP, ascii('Streamlift')), elem(I.WRITEAPP, ascii('Streamlift'))]));
    const trk = elem(I.TRACKS, concat(tracks));
    const cueClusters = clusters.filter((c) => c.hasKey);
    const cuesLen = (n) => { const p = 19 * n; return encId(I.CUES).length + encVint(p).length + p; };
    const clustersLen = clusters.reduce((n, c) => n + c.total, 0);
    let cues = new Uint8Array(0);
    if (cueClusters.length && info.length + trk.length + cuesLen(cueClusters.length) + clustersLen < 0xffffffff) {
      let pos = info.length + trk.length + cuesLen(cueClusters.length);
      const pts = [];
      for (const c of clusters) {
        if (c.hasKey) pts.push(elem(I.CUEPOINT, concat([elem(I.CUETIME, encUint(c.keyMs, 4)), elem(I.CUEPOS, concat([elem(I.CUETRACK, encUint(1)), elem(I.CUECLUS, encUint(pos, 4))]))])));
        pos += c.total;
      }
      cues = elem(I.CUES, concat(pts));
    }
    const ebml = elem(I.EBML, concat([
      elem(I.VER, encUint(1)), elem(I.READVER, encUint(1)), elem(I.MAXID, encUint(4)), elem(I.MAXSIZE, encUint(8)),
      elem(I.DOCTYPE, ascii('webm')), elem(I.DOCVER, encUint(4)), elem(I.DOCREAD, encUint(2)),
    ]));
    const seg = concat([encId(I.SEGMENT), encVint(info.length + trk.length + cues.length + clustersLen, 8)]);
    const out = [ebml, seg, info, trk, cues];
    for (const c of clusters) out.push(...c.out);
    return new B(out, { type: 'video/webm' });
  }

  // ------------------------------------------------------------------ entry ----
  // videoBlob: MP4 with VP9/AV1 picture. audioBlob: M4A (AAC). Resolves a WebM Blob.
  // Rejects with ToWebmError (UNSUPPORTED = not VP9/AV1, ...); the caller then keeps the MP4 merge.
  async function mp4PairToWebm(videoBlob, audioBlob, opts) {
    const o = opts || {};
    const v = await readMp4Video(videoBlob);
    const a = audioBlob ? await audioToOpus(audioBlob, o.deps, o.onProgress) : null;
    const shift = Math.max(0, v.mediaTime);
    const frames = v.samples.map((s) => ({
      ms: (s.dts + s.cts - shift) * 1000 / v.timescale,
      order: (s.dts - shift) * 1000 / v.timescale,
      key: s.key, blob: videoBlob.slice(s.off, s.off + s.size),
    }));
    const minMs = Math.min(...frames.map((f) => f.ms));
    if (minMs < 0) for (const f of frames) { f.ms -= minMs; f.order -= minMs; }
    const config = v.config && v.config.type === 'av1C' ? v.config.bytes : null;
    return writeWebm({ codecId: v.fourcc === 'vp09' ? 'V_VP9' : 'V_AV1', config, width: v.width, height: v.height, frames }, a, o.BlobCtor);
  }

  const api = { ToWebmError, mp4PairToWebm, readMp4Video, audioToOpus, writeWebm };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SVDToWebm = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
