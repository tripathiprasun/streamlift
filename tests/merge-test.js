// Optional developer check (needs Node 18+, ffmpeg + ffprobe; no npm packages).
// Covers Part 6 merging: lib/webm.js (video-only WebM + audio-only WebM -> ONE WebM, also when the
// player switched quality) and the per-quality-part MP4 merge of lib/mux.js. Every result is DECODED by ffmpeg, not just parsed by our own code.
// Run from the project root:  node tests/merge-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
const W = require('../lib/webm.js');
const M = require('../lib/mux.js');

if (spawnSync('ffprobe', ['-version']).status !== 0 || spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('skipped: ffmpeg/ffprobe not installed'); process.exit(0); }

let passed = 0;
const ok = (cond, msg) => { if (!cond) { console.log('  FAIL -', msg); process.exitCode = 1; throw new Error('FAILED: ' + msg); } passed++; console.log('  ok -', msg); };
const fx = (f) => path.join(__dirname, 'fixtures', f);
const blobOf = (f) => new Blob([fs.readFileSync(fx(f))]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-merge-'));
async function save(blob, name) { const p = path.join(tmp, name); fs.writeFileSync(p, Buffer.from(await blob.arrayBuffer())); return p; }
const probe = (file, args) => spawnSync('ffprobe', ['-v', 'error', ...args, file], { encoding: 'utf8' }).stdout.trim();
const streams = (file) => probe(file, ['-show_entries', 'stream=codec_name', '-of', 'csv=p=0']).split(/\s+/).sort().join(',');
// ffmpeg decodes every frame of every stream; any message at all (-v error) is a problem
function decodes(file) { const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }); return r.status === 0 && r.stderr.trim() === '' ? '' : r.stderr.trim() || 'exit ' + r.status; }
const frames = (file) => probe(file, ['-select_streams', 'v', '-show_entries', 'frame=pts_time,width', '-of', 'csv=p=0']).split('\n').map((l) => l.split(',')).map(([t, w]) => ({ t: parseFloat(t), w: +w }));
const duration = (file) => parseFloat(probe(file, ['-show_entries', 'format=duration', '-of', 'csv=p=0']));
const rejects = async (p) => { try { await p; return null; } catch (e) { return e; } };

// ---- fragmented MP4 helper: drop the first n moof+mdat pairs (simulates a part that starts later) ----
function dropFragments(buf, n) {
  const out = []; let p = 0, seen = 0, skipping = false;
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'moof') { seen++; skipping = seen <= n; }
    if (!(skipping && (type === 'moof' || type === 'mdat'))) out.push(buf.subarray(p, p + size));
    p += size;
  }
  return Buffer.concat(out);
}

function dropLast(buf, keepN) {      // keep only the first keepN moof+mdat pairs
  const out = []; let p = 0, seen = 0;
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8);
    if (type === 'moof') seen++;
    if (!((type === 'moof' || type === 'mdat') && seen > keepN)) out.push(buf.subarray(p, p + size));
    p += size;
  }
  return Buffer.concat(out);
}

(async () => {
  console.log('WebM: video-only + audio-only -> one file');
  const merged = await W.mergeWebm([blobOf('webm/v.webm')], [blobOf('webm/a.webm')]);
  const mp = await save(merged, 'merged.webm');
  ok(merged.type === 'video/webm' && W.isWebm(new Uint8Array(await merged.slice(0, 8).arrayBuffer())), 'result is a WebM Blob');
  ok(streams(mp) === 'opus,vp9', 'ONE file holding both the VP9 video and the Opus audio (' + streams(mp) + ')');
  ok(decodes(mp) === '', 'ffmpeg decodes the whole merged file without a single error');
  ok(Math.abs(duration(mp) - 4) < 0.15, 'duration is about 4 s (' + duration(mp).toFixed(2) + ')');
  const origPk = probe(fx('webm/v.webm'), ['-select_streams', 'v', '-show_entries', 'packet=size,pts_time', '-of', 'csv=p=0']);
  const newPk = probe(mp, ['-select_streams', 'v', '-show_entries', 'packet=size,pts_time', '-of', 'csv=p=0']);
  ok(origPk === newPk, 'the video frames are copied byte for byte (same sizes and timestamps, no re-encoding)');
  const origA = probe(fx('webm/a.webm'), ['-select_streams', 'a', '-show_entries', 'packet=size,pts_time', '-of', 'csv=p=0']);
  const newA = probe(mp, ['-select_streams', 'a', '-show_entries', 'packet=size,pts_time', '-of', 'csv=p=0']);
  ok(origA === newA, 'and so are the audio frames');
  const seek = spawnSync('ffmpeg', ['-v', 'error', '-ss', '2.5', '-i', mp, '-t', '1', '-f', 'null', '-'], { encoding: 'utf8' });
  ok(seek.status === 0 && seek.stderr.trim() === '', 'seeking into the merged file works (it has an index)');
  const orderA = probe(mp, ['-show_entries', 'packet=stream_index,pts_time', '-of', 'csv=p=0']).split('\n');
  ok(orderA.slice(0, 40).some((l) => l.startsWith('1,')) && orderA.slice(0, 40).some((l) => l.startsWith('0,')), 'audio and video frames are interleaved');

  console.log('WebM: the player switched quality (several parts)');
  fs.writeFileSync(path.join(tmp, 'late.webm'), '');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '2', '-i', fx('webm/v.webm'), '-c', 'copy', '-copyts', '-avoid_negative_ts', 'disabled', path.join(tmp, 'late.webm')]);
  const lateFirst = parseFloat(probe(path.join(tmp, 'late.webm'), ['-select_streams', 'v', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', '-read_intervals', '%+#1']));
  ok(lateFirst >= 1.9, 'test part "late" really starts at 2 s (' + lateFirst + ')');
  const switched = await W.mergeWebm([blobOf('webm/v_low.webm'), new Blob([fs.readFileSync(path.join(tmp, 'late.webm'))])], [blobOf('webm/a.webm')]);
  const sp = await save(switched, 'switched.webm');
  ok(streams(sp) === 'opus,vp9' && decodes(sp) === '', 'two qualities + audio -> ONE file that decodes cleanly');
  const fr = frames(sp);
  const early = fr.filter((f) => f.t < 1.9), later = fr.filter((f) => f.t >= 2.0);
  ok(early.length >= 15 && early.every((f) => f.w === 80), 'the first part (80 px wide) plays until the later part takes over (' + early.length + ' frames)');
  ok(later.length >= 15 && later.every((f) => f.w === 160), 'from 2 s on, the later part (160 px wide) wins (' + later.length + ' frames)');
  ok(new Set(fr.map((f) => f.t)).size === fr.length, 'no moment of the video is present twice');
  const joined = await W.mergeWebm([blobOf('webm/v_low.webm'), blobOf('webm/v.webm')], []);
  const jp = await save(joined, 'joined.webm');
  ok(streams(jp) === 'vp9' && decodes(jp) === '' && frames(jp).length === 40 && frames(jp).every((f) => f.w === 160), 'several parts of ONE track (no audio) are joined into one file; the last part replaces the overlap');

  console.log('WebM: refusals');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-t', '1', '-c:v', 'libvpx', '-an', path.join(tmp, 'vp8.webm')]);
  let e = await rejects(W.mergeWebm([blobOf('webm/v.webm'), new Blob([fs.readFileSync(path.join(tmp, 'vp8.webm'))])], []));
  ok(e && e.code === 'UNSUPPORTED' && /changed codec/.test(e.message), 'parts with different codecs are refused with a clear message');
  e = await rejects(W.mergeWebm([blobOf('mux/v_prog.mp4')], [blobOf('webm/a.webm')]));
  ok(e && e.code === 'BAD_FILE' && /not a WebM/.test(e.message), 'an MP4 is refused as "not a WebM file"');
  e = await rejects(W.mergeWebm([blobOf('webm/a.webm')], [blobOf('webm/a.webm')]));
  ok(e && e.code === 'BAD_FILE' && /no video track/.test(e.message), 'two audio files cannot be merged as video + audio');
  e = await rejects(W.mergeWebm([new Blob([fs.readFileSync(fx('webm/v.webm')).subarray(0, 300)])], []));
  ok(e && e.code === 'BAD_FILE', 'a file cut off before its tracks is refused');

  console.log('WebM: a capture that stops in the middle of a cluster');
  const cut = fs.readFileSync(fx('webm/v.webm'));
  const trunc = await W.mergeWebm([new Blob([cut.subarray(0, Math.floor(cut.length * 0.7))])], [blobOf('webm/a.webm')]);
  const tp = await save(trunc, 'trunc.webm');
  ok(streams(tp) === 'opus,vp9' && frames(tp).length >= 20 && frames(tp).length < 40, 'only complete frames are kept (' + frames(tp).length + ' of 40) and the file still plays');

  console.log('MP4: the player switched quality -> each quality part is merged with ITS slice of the audio');
  const lo = fs.readFileSync(fx('mp4q/v_lo.mp4')), hi = fs.readFileSync(fx('mp4q/v_hi.mp4'));
  const part1 = new Blob([dropLast(lo, 2)]), part2 = new Blob([dropFragments(hi, 2)]);       // 80 px for 0-2 s, 160 px for 2-4 s
  const s1 = await M.fragmentSpan(part1), s2 = await M.fragmentSpan(part2);
  ok(Math.abs(s1.from) < 0.05 && Math.abs(s1.to - 2) < 0.15 && Math.abs(s2.from - 2) < 0.15 && Math.abs(s2.to - 4) < 0.15, 'the time covered by each part is found (' + s1.from.toFixed(1) + '-' + s1.to.toFixed(1) + ' s and ' + s2.from.toFixed(1) + '-' + s2.to.toFixed(1) + ' s)');
  const audio = blobOf('mp4q/a.m4a');
  const outs = [];
  for (const [n, part, span, width] of [[1, part1, s1, 80], [2, part2, s2, 160]]) {
    const slice = await M.sliceFragments(audio, span.from, span.to);
    const merged = await M.mergeMp4(part, slice);
    const f = await save(merged, 'q' + n + '.mp4');
    outs.push(f);
    ok(streams(f) === 'aac,vp9' && decodes(f) === '', 'part ' + n + ': ONE MP4 with picture and sound that ffmpeg decodes without errors');
    ok(frames(f).length === 20 && frames(f).every((x) => x.w === width), 'part ' + n + ' has its 20 frames, all ' + width + ' px wide');
    const [aStart, aEnd] = probe(f, ['-select_streams', 'a', '-show_entries', 'stream=duration,start_time', '-of', 'csv=p=0']).split(',').map(parseFloat);
    const ad = aEnd - aStart;                      // a later part starts at its own time on the timeline
    ok(ad > 1.0 && ad < 3.2, 'part ' + n + ' carries only about its own 2 s of audio (' + ad.toFixed(2) + ' s)');
  }
  e = await rejects(M.sliceFragments(audio, 10, 12));
  ok(e && e.code === 'BAD_FILE', 'asking for audio that does not exist is refused');

  console.log(`\n${passed} checks passed`);
})().catch((e) => { console.error(e); process.exit(1); });
