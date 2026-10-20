// Merges a video-only MP4 and an audio-only MP4 into ONE MP4 file without re-encoding
// (bytes of the media are copied as they are). Works on Blobs, so large files are not
// copied into memory: only the small header boxes are read and rewritten.
//
//   fragmented MP4 (DASH, HLS-fMP4, MediaSource captures) -> fragmented MP4
//       one moov with both tracks; fragments from both files interleaved by time.
//   progressive MP4 (plain files with the index in moov)  -> progressive MP4
//       one moov with both tracks; chunk offsets are rewritten.
//
// Also: reorderFragments(blob) puts the fragments of one fragmented MP4 into time order
// (a player that is made to seek around appends segments out of order).
// Never decrypts anything: files with encryption boxes are refused.
(function (root) {
  'use strict';

  class MuxError extends Error {
    constructor(code, message) { super(message); this.name = 'MuxError'; this.code = code; }
  }

  // ---------------------------------------------------------------- bytes ----
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
  const i32 = (b, o) => u32(b, o) | 0;
  function w32(b, o, v) { b[o] = (v >>> 24) & 255; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; }
  function w64(b, o, v) { w32(b, o, Math.floor(v / 4294967296)); w32(b, o + 4, v % 4294967296); }
  const cc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  function header(type, size) {
    const h = new Uint8Array(8);
    w32(h, 0, size);
    for (let i = 0; i < 4; i++) h[4 + i] = type.charCodeAt(i);
    return h;
  }
  function concat(chunks) {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let p = 0;
    for (const c of chunks) { out.set(c, p); p += c.length; }
    return out;
  }
  function hasFourcc(b, name) {
    const a = name.charCodeAt(0), c = name.charCodeAt(1), d = name.charCodeAt(2), e = name.charCodeAt(3);
    for (let i = 0; i + 3 < b.length; i++) if (b[i] === a && b[i + 1] === c && b[i + 2] === d && b[i + 3] === e) return true;
    return false;
  }

  // ---------------------------------------------------------- box parsing ----
  // Boxes inside a buffer: [{type, start, end, hdr}]
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
  const childrenOf = (buf, box) => kids(buf, box.start + box.hdr, box.end);
  const child = (buf, box, type) => box && childrenOf(buf, box).find((k) => k.type === type);
  const childs = (buf, box, type) => childrenOf(buf, box).filter((k) => k.type === type);

  // Top-level boxes of a Blob (reads only the box headers).
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
      const truncated = pos + sz > size;
      out.push({ type, start: pos, size: truncated ? size - pos : sz, hdr, truncated });
      pos += sz;
    }
    return out;
  }
  async function bytesOf(blob, box) { return new Uint8Array(await blob.slice(box.start, box.start + box.size).arrayBuffer()); }

  // ------------------------------------------------------------ moov info ----
  const verOf = (b, box) => b[box.start + 8];

  function readMoov(buf) {
    const moov = kids(buf, 0, buf.length).find((k) => k.type === 'moov');
    if (!moov) throw new MuxError('BAD_FILE', 'The file has no moov box (it is not a complete MP4).');
    if (hasFourcc(buf, 'pssh') || hasFourcc(buf, 'encv') || hasFourcc(buf, 'enca') || hasFourcc(buf, 'sinf')) {
      throw new MuxError('ENCRYPTED', 'The file is encrypted. Encrypted media is not merged by this extension.');
    }
    const mvhd = child(buf, moov, 'mvhd');
    if (!mvhd) throw new MuxError('BAD_FILE', 'The file has no mvhd box.');
    const mv = verOf(buf, mvhd);
    const traks = childs(buf, moov, 'trak').map((trak) => {
      const tkhd = child(buf, trak, 'tkhd');
      const mdia = child(buf, trak, 'mdia');
      const mdhd = child(buf, mdia, 'mdhd');
      const hdlr = child(buf, mdia, 'hdlr');
      if (!tkhd || !mdhd || !hdlr) throw new MuxError('BAD_FILE', 'A track is missing its tkhd/mdhd/hdlr box.');
      const tv = verOf(buf, tkhd), dv = verOf(buf, mdhd);
      return {
        box: trak, tkhd, idOff: tkhd.start + (tv === 1 ? 28 : 20), id: u32(buf, tkhd.start + (tv === 1 ? 28 : 20)),
        timescale: u32(buf, mdhd.start + (dv === 1 ? 28 : 20)), handler: cc(buf, hdlr.start + 16),
      };
    });
    const mvex = child(buf, moov, 'mvex');
    const trex = mvex ? childs(buf, mvex, 'trex') : [];
    return { moov, mvhd, mvhdTS: u32(buf, mvhd.start + (mv === 1 ? 28 : 20)), mv, traks, mvex, trex };
  }

  // Edit-list durations are in the MOVIE timescale; when a track moves into another movie
  // with a different timescale they must be converted.
  function rescaleElst(buf, trak, fromTS, toTS) {
    if (!fromTS || fromTS === toTS) return;
    const edts = child(buf, trak, 'edts');
    const elst = edts && child(buf, edts, 'elst');
    if (!elst) return;
    const v = verOf(buf, elst), count = u32(buf, elst.start + 12);
    const step = v === 1 ? 20 : 12;
    for (let i = 0; i < count; i++) {
      const o = elst.start + 16 + i * step;
      if (o + step > elst.end) break;
      if (v === 1) w64(buf, o, Math.round(u64(buf, o) * toTS / fromTS));
      else w32(buf, o, Math.round(u32(buf, o) * toTS / fromTS));
    }
  }

  function checkTracks(info, label) {
    if (info.traks.length !== 1) throw new MuxError('UNSUPPORTED', `The ${label} file contains ${info.traks.length} tracks; only single-track files can be merged.`);
  }

  // Track id for the audio track so that both ids are unique.
  const freshId = (vId, aId) => (aId !== vId ? aId : vId + 1);

  // -------------------------------------------------------------- fragments ----
  function readFragment(buf, trexById, running) {
    const moof = kids(buf, 0, buf.length).find((k) => k.type === 'moof');
    if (!moof) throw new MuxError('BAD_FILE', 'A fragment has no moof box.');
    const mfhd = child(buf, moof, 'mfhd');
    const trafs = childs(buf, moof, 'traf').map((traf) => {
      const tfhd = child(buf, traf, 'tfhd');
      if (!tfhd) throw new MuxError('BAD_FILE', 'A fragment has no tfhd box.');
      const flags = u32(buf, tfhd.start + 8) & 0xffffff;
      if (flags & 1) throw new MuxError('UNSUPPORTED', 'This fragmented MP4 uses absolute data offsets, which cannot be merged.');
      const id = u32(buf, tfhd.start + 12);
      let o = tfhd.start + 16;
      if (flags & 2) o += 4;
      const defDur = flags & 8 ? u32(buf, o) : (trexById[id] && trexById[id].defDur) || 0;
      const tfdt = child(buf, traf, 'tfdt');
      let base = null;
      if (tfdt) base = verOf(buf, tfdt) === 1 ? u64(buf, tfdt.start + 12) : u32(buf, tfdt.start + 12);
      let ticks = 0;
      for (const trun of childs(buf, traf, 'trun')) {
        const f = u32(buf, trun.start + 8) & 0xffffff, n = u32(buf, trun.start + 12);
        if (f & 0x100) {
          let p = trun.start + 16 + (f & 1 ? 4 : 0) + (f & 4 ? 4 : 0);
          const per = 4 * ((f & 0x100 ? 1 : 0) + (f & 0x200 ? 1 : 0) + (f & 0x400 ? 1 : 0) + (f & 0x800 ? 1 : 0));
          for (let i = 0; i < n; i++, p += per) ticks += u32(buf, p);
        } else ticks += n * defDur;
      }
      return { id, idOff: tfhd.start + 12, base, ticks };
    });
    if (!trafs.length) throw new MuxError('BAD_FILE', 'A fragment has no track data.');
    // A fragment without tfdt continues where the previous one of that track ended.
    const t0 = trafs[0];
    if (t0.base === null) {
      if (running[t0.id] === undefined) throw new MuxError('UNSUPPORTED', 'A fragment has no timestamp (tfdt).');
      t0.base = running[t0.id];
    }
    for (const t of trafs) running[t.id] = (t.base === null ? running[t.id] || 0 : t.base) + t.ticks;
    return { seqOff: mfhd ? mfhd.start + 12 : -1, trafs };
  }

  // Reads every moof+mdat pair of a fragmented file: [{moof: bytes, mdat: Blob, time, trafs, seqOff}]
  async function readFragments(blob, boxes, info) {
    const trexById = {};
    for (const t of info.trexRaw || []) trexById[t.id] = t;
    const tsById = {};
    for (const t of info.traks) tsById[t.id] = t.timescale;
    const running = {};
    const out = [];
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      if (b.type !== 'moof' || b.truncated) continue;
      const mdat = boxes.slice(i + 1).find((x) => x.type === 'mdat' || x.type === 'moof');
      if (!mdat || mdat.type !== 'mdat' || mdat.truncated) continue;   // incomplete fragment: dropped
      const moof = await bytesOf(blob, b);
      const f = readFragment(moof, trexById, running);
      const ts = tsById[f.trafs[0].id] || 1;
      out.push({ moof, mdat: blob.slice(mdat.start, mdat.start + mdat.size), time: f.trafs[0].base / ts, dur: f.trafs[0].ticks / ts, trafs: f.trafs, seqOff: f.seqOff });
    }
    return dedupeFragments(out);
  }

  // A player that seeks, switches quality or is made to "load the rest" appends the same stretch of video more
  // than once. Played back as one file, repeated fragments make the picture freeze and the sound drop out, so
  // when two fragments cover the same time the one appended LAST wins (that is what the player's buffer does).
  function dedupeFragments(frags) {
    let kept = [];
    for (const f of frags) {
      kept = kept.filter((k) => {
        const overlap = Math.min(k.time + k.dur, f.time + f.dur) - Math.max(k.time, f.time);
        return !(Math.abs(k.time - f.time) < 0.02 || overlap > 0.5 * Math.min(k.dur, f.dur));
      });
      kept.push(f);
    }
    return kept;
  }

  function trexTable(buf, info) {
    return info.trex.map((t) => ({ id: u32(buf, t.start + 12), defDur: u32(buf, t.start + 20) }));
  }

  async function openFragmented(blob, label) {
    const boxes = await topBoxes(blob);
    const moovBox = boxes.find((b) => b.type === 'moov' && !b.truncated);
    if (!moovBox) throw new MuxError('BAD_FILE', `The ${label} file has no complete moov box.`);
    const ftyp = boxes.find((b) => b.type === 'ftyp');
    const moovBytes = await bytesOf(blob, moovBox);
    const info = readMoov(moovBytes);
    info.trexRaw = trexTable(moovBytes, info);
    return { blob, boxes, ftyp: ftyp ? await bytesOf(blob, ftyp) : null, moovBytes, info, fragmented: boxes.some((b) => b.type === 'moof') };
  }

  function sortStable(list) {
    return list.map((f, i) => [f, i]).sort((a, b) => (a[0].time - b[0].time) || (a[1] - b[1])).map((x) => x[0]);
  }

  function seqPatch(f, n) { if (f.seqOff >= 0) w32(f.moof, f.seqOff, n); }

  // ---------------------------------------------------------- merge: fragmented ----
  async function mergeFragmented(v, a, BlobCtor) {
    checkTracks(v.info, 'video'); checkTracks(a.info, 'audio');
    const vt = v.info.traks[0], at = a.info.traks[0];
    const aNewId = freshId(vt.id, at.id);

    // new moov: mvhd + both traks + mvex with both trex
    const mvhd = v.moovBytes.slice(v.info.mvhd.start, v.info.mvhd.end);
    const vTrak = v.moovBytes.slice(vt.box.start, vt.box.end);
    const aTrak = a.moovBytes.slice(at.box.start, at.box.end);
    const aTk = child(aTrak, kids(aTrak, 0, aTrak.length)[0], 'tkhd');
    w32(aTrak, aTk.start + (aTrak[aTk.start + 8] === 1 ? 28 : 20), aNewId);
    rescaleElst(aTrak, kids(aTrak, 0, aTrak.length)[0], a.info.mvhdTS, v.info.mvhdTS);
    const nextOff = mvhd.length - 4;
    w32(mvhd, nextOff, Math.max(vt.id, aNewId) + 1);

    const trexOf = (info, buf, id) => info.trex.find((t) => u32(buf, t.start + 12) === id);
    const vTrexBox = trexOf(v.info, v.moovBytes, vt.id), aTrexBox = trexOf(a.info, a.moovBytes, at.id);
    if (!vTrexBox || !aTrexBox) throw new MuxError('BAD_FILE', 'A fragmented file is missing its trex box.');
    const vTrex = v.moovBytes.slice(vTrexBox.start, vTrexBox.end), aTrex = a.moovBytes.slice(aTrexBox.start, aTrexBox.end);
    w32(aTrex, 12, aNewId);
    const mvex = concat([header('mvex', 8 + vTrex.length + aTrex.length), vTrex, aTrex]);
    const body = concat([mvhd, vTrak, aTrak, mvex]);
    const moov = concat([header('moov', 8 + body.length), body]);

    const vFr = sortStable(await readFragments(v.blob, v.boxes, v.info));
    const aFr = sortStable(await readFragments(a.blob, a.boxes, a.info));
    if (!vFr.length || !aFr.length) throw new MuxError('BAD_FILE', 'One of the files has no media fragments.');
    for (const f of aFr) for (const t of f.trafs) w32(f.moof, t.idOff, aNewId);

    const parts = [];
    if (v.ftyp) parts.push(v.ftyp);
    parts.push(moov);
    let i = 0, j = 0, seq = 1;
    while (i < vFr.length || j < aFr.length) {
      const f = j >= aFr.length || (i < vFr.length && vFr[i].time <= aFr[j].time) ? vFr[i++] : aFr[j++];
      seqPatch(f, seq++);
      parts.push(f.moof, f.mdat);
    }
    return new BlobCtor(parts, { type: 'video/mp4' });
  }

  // ---------------------------------------------------------- merge: progressive ----
  function stcoOf(buf, trak) {
    const mdia = child(buf, trak, 'mdia');
    const minf = child(buf, mdia, 'minf');
    const stbl = child(buf, minf, 'stbl');
    const co = stbl && (child(buf, stbl, 'stco') || child(buf, stbl, 'co64'));
    if (!co) throw new MuxError('BAD_FILE', 'A track has no chunk offset table (stco/co64).');
    return co;
  }

  async function openProgressive(blob, label) {
    const boxes = await topBoxes(blob);
    const moovBox = boxes.find((b) => b.type === 'moov' && !b.truncated);
    if (!moovBox) throw new MuxError('BAD_FILE', `The ${label} file has no complete moov box.`);
    const mdats = boxes.filter((b) => b.type === 'mdat');
    if (!mdats.length || mdats.some((m) => m.truncated)) throw new MuxError('BAD_FILE', `The ${label} file is incomplete (its media data is cut off).`);
    const ftyp = boxes.find((b) => b.type === 'ftyp');
    const moovBytes = await bytesOf(blob, moovBox);
    return { blob, ftyp: ftyp ? await bytesOf(blob, ftyp) : null, moovBytes, info: readMoov(moovBytes), mdats };
  }

  async function mergeProgressive(v, a, BlobCtor) {
    checkTracks(v.info, 'video'); checkTracks(a.info, 'audio');
    const vt = v.info.traks[0], at = a.info.traks[0];
    const aNewId = freshId(vt.id, at.id);
    const mvhd = v.moovBytes.slice(v.info.mvhd.start, v.info.mvhd.end);
    const vTrak = v.moovBytes.slice(vt.box.start, vt.box.end);
    const aTrak = a.moovBytes.slice(at.box.start, at.box.end);
    const vTop = kids(vTrak, 0, vTrak.length)[0], aTop = kids(aTrak, 0, aTrak.length)[0];
    const aTk = child(aTrak, aTop, 'tkhd');
    w32(aTrak, aTk.start + (aTrak[aTk.start + 8] === 1 ? 28 : 20), aNewId);
    rescaleElst(aTrak, aTop, a.info.mvhdTS, v.info.mvhdTS);
    w32(mvhd, mvhd.length - 4, Math.max(vt.id, aNewId) + 1);
    // movie duration = the longer of the two (in the video's movie timescale)
    const mv = mvhd[8];
    const durOff = mv === 1 ? 32 : 24;
    const aMvDur = a.moovBytes[a.info.mvhd.start + 8] === 1 ? u64(a.moovBytes, a.info.mvhd.start + 32) : u32(a.moovBytes, a.info.mvhd.start + 24);
    const aDurInV = Math.round(aMvDur * v.info.mvhdTS / (a.info.mvhdTS || 1));
    if (mv === 1) { if (aDurInV > u64(mvhd, durOff)) w64(mvhd, durOff, aDurInV); }
    else if (aDurInV > u32(mvhd, durOff)) w32(mvhd, durOff, Math.min(aDurInV, 0xffffffff));

    const ftyp = v.ftyp || concat([header('ftyp', 24), new Uint8Array([105, 115, 111, 109, 0, 0, 2, 0, 105, 115, 111, 109, 105, 115, 111, 50])]);
    const body = concat([mvhd, vTrak, aTrak]);
    const moovLen = 8 + body.length;
    const sum = (m) => m.reduce((n, x) => n + (x.size - x.hdr), 0);
    const payload = sum(v.mdats) + sum(a.mdats);
    const big = payload + 8 > 0xffffffff;
    const mdatHdr = big ? concat([header('mdat', 1), new Uint8Array(8)]) : header('mdat', payload + 8);
    if (big) w64(mdatHdr, 8, payload + 16);
    const base = ftyp.length + moovLen + mdatHdr.length;

    function patchOffsets(trakBuf, top, mdats, startAt) {
      const co = stcoOf(trakBuf, top);
      const is64 = co.type === 'co64', step = is64 ? 8 : 4;
      const n = u32(trakBuf, co.start + 12);
      const ranges = [];
      let cum = 0;
      for (const m of mdats) { ranges.push({ s: m.start + m.hdr, e: m.start + m.size, d: startAt + cum - (m.start + m.hdr) }); cum += m.size - m.hdr; }
      for (let i = 0; i < n; i++) {
        const o = co.start + 16 + i * step;
        const off = is64 ? u64(trakBuf, o) : u32(trakBuf, o);
        const r = ranges.find((x) => off >= x.s && off < x.e);
        if (!r) throw new MuxError('BAD_FILE', 'A chunk offset points outside the media data (the file refers to external data).');
        const nv = off + r.d;
        if (is64) w64(trakBuf, o, nv);
        else { if (nv > 0xffffffff) throw new MuxError('UNSUPPORTED', 'The merged file is too large for 32-bit chunk offsets.'); w32(trakBuf, o, nv); }
      }
    }
    const vPayload = sum(v.mdats);
    patchOffsets(vTrak, vTop, v.mdats, base);
    patchOffsets(aTrak, aTop, a.mdats, base + vPayload);

    const moov = concat([header('moov', moovLen), mvhd, vTrak, aTrak]);
    const parts = [ftyp, moov, mdatHdr];
    for (const m of v.mdats) parts.push(v.blob.slice(m.start + m.hdr, m.start + m.size));
    for (const m of a.mdats) parts.push(a.blob.slice(m.start + m.hdr, m.start + m.size));
    return new BlobCtor(parts, { type: 'video/mp4' });
  }

  // ------------------------------------------------------------------- API ----
  // Merge one video-only and one audio-only MP4 into a single MP4 Blob. Rejects with MuxError.
  async function mergeMp4(videoBlob, audioBlob, BlobCtor) {
    const B = BlobCtor || Blob;
    const vb = await topBoxes(videoBlob), ab = await topBoxes(audioBlob);
    const isFrag = (b) => b.some((x) => x.type === 'moof');
    const hasMoov = (b) => b.some((x) => x.type === 'moov');
    if (!hasMoov(vb) || !hasMoov(ab)) throw new MuxError('BAD_FILE', 'Both files must be MP4 files (no moov box found). MPEG-TS streams cannot be merged this way.');
    if (isFrag(vb) !== isFrag(ab)) throw new MuxError('UNSUPPORTED', 'One file is fragmented and the other is not; they cannot be merged.');
    if (isFrag(vb)) {
      return mergeFragmented(await openFragmented(videoBlob, 'video'), await openFragmented(audioBlob, 'audio'), B);
    }
    return mergeProgressive(await openProgressive(videoBlob, 'video'), await openProgressive(audioBlob, 'audio'), B);
  }

  // Put the fragments of one fragmented MP4 in time order (and drop sidx/styp). Returns the
  // same blob when it is not fragmented or already in order.
  async function reorderFragments(blob, BlobCtor) {
    const B = BlobCtor || Blob;
    const boxes = await topBoxes(blob);
    if (!boxes.some((b) => b.type === 'moof') || !boxes.some((b) => b.type === 'moov')) return blob;
    const f = await openFragmented(blob, 'video');
    const frags = await readFragments(blob, f.boxes, f.info);
    const inOrder = frags.every((x, i) => i === 0 || frags[i - 1].time <= x.time);
    const clean = !boxes.some((b) => b.type === 'sidx' || b.type === 'styp');
    const noDupes = frags.length === boxes.filter((b) => b.type === 'moof' && !b.truncated).length;
    if (inOrder && clean && noDupes) return blob;
    const sorted = sortStable(frags);
    const parts = [];
    if (f.ftyp) parts.push(f.ftyp);
    parts.push(f.moovBytes.slice(f.info.moov.start, f.info.moov.end));
    sorted.forEach((x, i) => { seqPatch(x, i + 1); parts.push(x.moof, x.mdat); });
    return new B(parts, { type: 'video/mp4' });
  }

  // ------------------------------------------- slicing by time (quality parts) ----
  // A player that switched quality leaves one part per quality. Parts with different picture sizes
  // cannot share one MP4 that every player handles (browsers read such files with a demuxer that
  // ignores the change), so each video part is merged with ITS slice of the audio instead.
  // fragmentSpan: the time range [from, to) the fragments of a fragmented MP4 cover (seconds).
  async function fragmentSpan(blob) {
    const f = await openFragmented(blob, 'media');
    const frags = await readFragments(blob, f.boxes, f.info);
    if (!frags.length) throw new MuxError('BAD_FILE', 'The file has no media fragments.');
    return { from: Math.min(...frags.map((x) => x.time)), to: Math.max(...frags.map((x) => x.time + x.dur)) };
  }

  // sliceFragments: the same file with only the fragments that overlap [from, to).
  async function sliceFragments(blob, from, to, BlobCtor) {
    const B = BlobCtor || Blob;
    const f = await openFragmented(blob, 'media');
    const keep = sortStable(await readFragments(blob, f.boxes, f.info)).filter((x) => x.time + x.dur > from + 0.02 && x.time < to - 0.02);
    if (!keep.length) throw new MuxError('BAD_FILE', 'The audio does not cover that part of the video.');
    const parts = [];
    if (f.ftyp) parts.push(f.ftyp);
    parts.push(f.moovBytes.slice(f.info.moov.start, f.info.moov.end));
    keep.forEach((x, i) => { seqPatch(x, i + 1); parts.push(x.moof, x.mdat); });
    return new B(parts, { type: 'video/mp4' });
  }

  const api = { MuxError, mergeMp4, reorderFragments, fragmentSpan, sliceFragments };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SVDMux = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
