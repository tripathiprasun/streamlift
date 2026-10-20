// Optional developer check (needs Node 18+). Tests lib/mux.js (merging video + audio MP4s
// into one file). If ffprobe/ffmpeg are installed, every merged file is also decoded
// completely and compared with its sources (stream layout, packet counts, start times).
// Run from the project root:  node tests/mux-test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');
const Mux = require('../lib/mux.js');

const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f));
const blobOf = (buf) => new Blob([buf]);
const toBuf = async (blob) => Buffer.from(await blob.arrayBuffer());
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-mux-'));
const hasFF = spawnSync('ffprobe', ['-version']).status === 0 && spawnSync('ffmpeg', ['-version']).status === 0;

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ok -', msg); };

function info(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_packets', '-show_entries', 'stream=codec_type,nb_read_packets,start_time,duration:format=duration', '-of', 'json', file], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, 'ffprobe failed: ' + r.stderr);
  const j = JSON.parse(r.stdout);
  const s = {};
  for (const x of j.streams) s[x.codec_type] = { packets: +x.nb_read_packets, start: +x.start_time, duration: +x.duration };
  return { s, duration: +j.format.duration, types: j.streams.map((x) => x.codec_type).sort().join(',') };
}
function decodesCleanly(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' });
  return r.status === 0 && r.stderr.trim() === '';
}
async function save(blob, name) { const f = path.join(tmp, name); fs.writeFileSync(f, await toBuf(blob)); return f; }
const fxPath = (f) => path.join(__dirname, 'fixtures', f);

// tiny top-level box lister for the tests
function boxes(buf) {
  const out = []; let p = 0;
  while (p + 8 <= buf.length) {
    let size = buf.readUInt32BE(p); const type = buf.toString('latin1', p + 4, p + 8);
    if (size === 1) size = Number(buf.readBigUInt64BE(p + 8)); else if (size === 0) size = buf.length - p;
    out.push({ type, start: p, size }); p += size;
  }
  return out;
}
const expectErr = async (fn, code) => { try { await fn(); } catch (e) { return e instanceof Mux.MuxError && e.code === code; } return false; };

(async () => {
  try {
    console.log('merge: fragmented MP4 (48 kHz audio + B-frame video)');
    const vF = fx('mux/v_frag.mp4'), aF = fx('mux/a_frag.m4a');
    const mf = await Mux.mergeMp4(blobOf(vF), blobOf(aF));
    const mfBuf = await toBuf(mf);
    ok(mf.type === 'video/mp4' && boxes(mfBuf)[0].type === 'ftyp' && boxes(mfBuf)[1].type === 'moov', 'result is an MP4 with ftyp then moov');
    const fr = boxes(mfBuf).filter((b) => b.type === 'moof');
    ok(fr.length > 2 && boxes(mfBuf).filter((b) => b.type === 'mdat').length === fr.length, 'fragments of both files are present (moof/mdat pairs)');
    ok(!boxes(mfBuf).some((b) => b.type === 'sidx'), 'stale sidx index boxes are not carried over');
    const mdatBytes = (b) => b.filter((x) => x.type === 'mdat').reduce((n, x) => n + x.size, 0);
    ok(mdatBytes(boxes(mfBuf)) === mdatBytes(boxes(vF)) + mdatBytes(boxes(aF)), 'every media byte of both inputs is copied (no re-encoding, nothing lost)');
    if (hasFF) {
      const f = await save(mf, 'merged_frag.mp4');
      const m = info(f), v = info(fxPath('mux/v_frag.mp4')), a = info(fxPath('mux/a_frag.m4a'));
      ok(m.types === 'audio,video', 'ffprobe: one file with an audio and a video stream');
      ok(m.s.video.packets === v.s.video.packets && m.s.audio.packets === a.s.audio.packets, `ffprobe: packet counts equal the sources (video ${m.s.video.packets}, audio ${m.s.audio.packets})`);
      ok(Math.abs(m.s.video.start - v.s.video.start) < 0.01 && Math.abs(m.s.audio.start - a.s.audio.start) < 0.01, 'ffprobe: start times unchanged, so audio and video stay in sync');
      ok(Math.abs(m.duration - Math.max(v.duration, a.duration)) < 0.1, 'ffprobe: duration is that of the longer input');
      ok(decodesCleanly(f), 'ffmpeg decodes the whole merged file with zero errors');
    }

    console.log('merge: progressive MP4');
    const vP = fx('mux/v_prog.mp4'), aP = fx('mux/a_prog.m4a');
    const mp = await Mux.mergeMp4(blobOf(vP), blobOf(aP));
    const mpBuf = await toBuf(mp);
    const bx = boxes(mpBuf).map((b) => b.type);
    ok(bx[0] === 'ftyp' && bx.indexOf('moov') < bx.indexOf('mdat') && bx.filter((t) => t === 'mdat').length === 1, 'single moov placed before one mdat (fast-start)');
    if (hasFF) {
      const f = await save(mp, 'merged_prog.mp4');
      const m = info(f), v = info(fxPath('mux/v_prog.mp4')), a = info(fxPath('mux/a_prog.m4a'));
      ok(m.types === 'audio,video' && m.s.video.packets === v.s.video.packets && m.s.audio.packets === a.s.audio.packets, 'ffprobe: both streams with all packets (chunk offsets were rewritten correctly)');
      ok(Math.abs(m.s.video.start - v.s.video.start) < 0.01 && Math.abs(m.s.audio.start - a.s.audio.start) < 0.05, 'ffprobe: start times preserved (edit lists survived the movie-timescale change)');
      ok(decodesCleanly(f), 'ffmpeg decodes the merged progressive file with zero errors');
      // frames really are the source frames: compare decoded video of source and merged
      const hash = (file) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
      ok(hash(f) === hash(fxPath('mux/v_prog.mp4')), 'decoded video frames are bit-identical to the source video');
      const ahash = (file) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
      ok(ahash(f) === ahash(fxPath('mux/a_prog.m4a')), 'decoded audio samples are bit-identical to the source audio');
    }
    const mpOpposite = await Mux.mergeMp4(blobOf(vP), blobOf(aP), Blob);
    ok(mpOpposite.size > vP.length + aP.length - 2000 && mpOpposite.size < vP.length + aP.length + 4000, 'merged size is about the sum of both inputs');

    console.log('merge: same track id in both files');
    // both fixtures use track_ID 1; the merged file must give them different ids
    if (hasFF) {
      const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=index,id', '-of', 'csv=p=0', path.join(tmp, 'merged_prog.mp4')], { encoding: 'utf8' });
      const ids = r.stdout.trim().split(/\s+/).map((l) => l.split(',')[1]);
      ok(new Set(ids).size === 2, 'the two tracks have different track ids');
    }

    console.log('reorder: out-of-order fragments (what a seeking player produces)');
    const av = fx('mux/av_frag.mp4');
    const bb = boxes(av);
    const head = bb.filter((b) => b.type === 'ftyp' || b.type === 'moov').map((b) => av.subarray(b.start, b.start + b.size));
    const pairs = [];
    for (let i = 0; i < bb.length; i++) if (bb[i].type === 'moof') pairs.push(Buffer.concat([av.subarray(bb[i].start, bb[i].start + bb[i].size), av.subarray(bb[i + 1].start, bb[i + 1].start + bb[i + 1].size)]));
    ok(pairs.length >= 3, `fixture has ${pairs.length} fragments`);
    const shuffled = Buffer.concat([...head, ...pairs.slice().reverse()]);
    const fixed = await Mux.reorderFragments(blobOf(shuffled));
    if (hasFF) {
      const f1 = await save(blobOf(shuffled), 'shuffled.mp4'), f2 = await save(fixed, 'reordered.mp4');
      const orig = info(fxPath('mux/av_frag.mp4')), re = info(f2);
      ok(re.types === 'audio,video' && re.s.video.packets === orig.s.video.packets && re.s.audio.packets === orig.s.audio.packets, 'ffprobe: reordered file has all packets of both tracks');
      ok(decodesCleanly(f2), 'ffmpeg decodes the reordered file with zero errors');
      const vhash = (file) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:v:0', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
      const ahash = (file) => spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'md5', '-'], { encoding: 'utf8' }).stdout.trim();
      ok(vhash(f2) === vhash(fxPath('mux/av_frag.mp4')) && ahash(f2) === ahash(fxPath('mux/av_frag.mp4')), 'decoded video frames and audio samples equal the original, in the original order');
      ok(vhash(f1) !== vhash(fxPath('mux/av_frag.mp4')), 'sanity: the shuffled input really did decode differently (so the check above is meaningful)');
    }
    const ordered = blobOf(av);
    ok((await Mux.reorderFragments(ordered)) === ordered, 'an already-ordered file is returned untouched');
    const plain = blobOf(vP);
    ok((await Mux.reorderFragments(plain)) === plain, 'a non-fragmented file is returned untouched');

    console.log('merge: refusals (nothing wrong is ever produced)');
    ok(await expectErr(() => Mux.mergeMp4(blobOf(vF), blobOf(aP)), 'UNSUPPORTED'), 'fragmented + progressive mix is refused');
    ok(await expectErr(() => Mux.mergeMp4(blobOf(Buffer.from('<html>expired</html>')), blobOf(aF)), 'BAD_FILE'), 'an HTML error page instead of a video is refused');
    ok(await expectErr(() => Mux.mergeMp4(blobOf(fx('hls/hi_0.ts')), blobOf(aF)), 'BAD_FILE'), 'an MPEG-TS segment is refused (TS cannot be merged this way)');
    ok(await expectErr(() => Mux.mergeMp4(blobOf(vP.subarray(0, vP.length - 5000)), blobOf(aP)), 'BAD_FILE'), 'a truncated progressive file is refused');
    const enc = Buffer.from(vP); const idx = enc.indexOf('moov'); enc.write('pssh', idx + 8 + 4, 'latin1');
    ok(await expectErr(() => Mux.mergeMp4(blobOf(enc), blobOf(aP)), 'ENCRYPTED'), 'a file with encryption boxes is refused');
    const abs = Buffer.from(vF); let t = -1, patched = 0;
    while ((t = abs.indexOf('tfhd', t + 1)) >= 0) { abs[t + 7] |= 1; patched++; }
    ok(patched > 0 && await expectErr(() => Mux.mergeMp4(blobOf(abs), blobOf(aF)), 'UNSUPPORTED'), 'absolute base-data-offset fragments are refused');
    ok(await expectErr(() => Mux.mergeMp4(blobOf(av), blobOf(aF)), 'UNSUPPORTED'), 'a file that already holds video+audio is refused as the "video" input');

    console.log('merge: incomplete trailing fragment (capture stopped mid-segment)');
    const cut = vF.subarray(0, vF.length - 700);
    const mc = await Mux.mergeMp4(blobOf(cut), blobOf(aF));
    ok(mc.size < mf.size && mc.size > 0, 'a cut-off last fragment is dropped and the rest is merged');
    if (hasFF) ok(decodesCleanly(await save(mc, 'cut.mp4')), 'ffmpeg decodes the result of the cut-off merge cleanly');

    console.log(`\n${passed} checks passed`);
  } catch (e) {
    console.error('\nFAILED:', e && e.stack ? e.stack : e);
    process.exitCode = 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
