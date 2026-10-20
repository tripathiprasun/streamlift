// Runs one download in its own tab (so it keeps going after the popup closes):
//   - an HLS/DASH stream:        ?url=<manifest>&quality=<best|id>&name=<file name>
//   - a video file + audio file: ?url=<video>&audio=<audio>&name=<file name>
// When the result is a separate video and audio MP4 (or WebM), they are merged into ONE file.
'use strict';
(async () => {
  const root = globalThis;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const url = params.get('url') || '';
  const audioUrl = params.get('audio') || '';
  const baseName = (params.get('name') || 'video').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\.(m3u8|mpd)$/i, '').slice(0, 100) || 'video';
  const ctl = new AbortController();
  const fmtMB = (n) => (n / 1048576).toFixed(1) + ' MB';
  $('url').textContent = url;
  $('title').textContent = baseName;
  $('cancel').addEventListener('click', () => ctl.abort());

  const fail = (text) => {
    $('status').textContent = text; $('status').className = 'error';
    $('cancel').hidden = true; document.title = 'Failed – ' + baseName;
  };
  const isHttp = (u) => /^https?:/i.test(u);
  if (!isHttp(url) || (audioUrl && !isHttp(audioUrl))) return fail('Invalid URL.');

  // Saves a Blob through the browser's downloads and keeps its URL alive until it is written.
  async function saveBlob(blob, filename) {
    const objUrl = URL.createObjectURL(blob);
    const id = await chrome.downloads.download({ url: objUrl, filename, conflictAction: 'uniquify' });
    const onChanged = (d) => {
      if (d.id === id && d.state && d.state.current !== 'in_progress') {
        chrome.downloads.onChanged.removeListener(onChanged);
        URL.revokeObjectURL(objUrl);
        if (d.state.current === 'interrupted') fail('Saving ' + filename + ' failed.');
      }
    };
    chrome.downloads.onChanged.addListener(onChanged);
  }

  try {
    const ref = params.get('ref') || '';
    if (ref) { try { await chrome.runtime.sendMessage({ type: 'ref-rule', ref }); } catch (e) { /* fetch without it */ } }
    const progress = {};
    const onProgress = (p) => {
      progress[p.track] = p;
      const all = Object.values(progress);
      const done = all.reduce((n, x) => n + x.done, 0), total = all.reduce((n, x) => n + x.total, 0);
      const bytes = all.reduce((n, x) => n + x.bytes, 0);
      if (all.some((x) => x.bytesMode)) {
        $('bar').value = total ? Math.min(100, (done / total) * 100) : 0;
        $('status').textContent = `Downloading… ${fmtMB(bytes)}` + (total ? ` of ${fmtMB(total)}` : '');
      } else {
        $('bar').value = (done / Math.max(total, 1)) * 100;
        $('status').textContent = `Downloading… ${done}/${total} segments (${fmtMB(bytes)})`;
      }
    };
    const onInfo = (i) => {
      $('info').textContent = i.kind === 'file'
        ? 'Video file + audio file (will be merged into one file)'
        : `${i.kind === 'hls' ? 'HLS' : 'DASH'} · quality: ${i.quality} · ${i.segments} segments` + (i.separate ? ' · separate audio and video' : '');
    };
    const result = audioUrl
      ? await SVDStream.downloadPair({ url, audioUrl, signal: ctl.signal, onInfo, onProgress })
      : await SVDStream.downloadStream({ url, quality: params.get('quality') || 'best', signal: ctl.signal, onInfo, onProgress });
    $('cancel').hidden = true;
    $('bar').value = 100;

    let files = result.files.map((f) => ({ ...f, filename: `${baseName}${f.suffix}.${f.ext}` }));
    let mergeNote = '';
    let webmDone = false, webmNote = '';
    // Instagram and Facebook video comes from their CDN hosts (or the page it was found on).
    const wantsWebm = () => {
      if (!root.SVDToWebm) return false;
      const host = (u) => { try { return new URL(u).hostname; } catch (e) { return ''; } };
      return [url, params.get('ref') || ''].some((u) => /(^|\.)(instagram\.com|cdninstagram\.com|fbcdn\.net|facebook\.com)$/i.test(host(u)));
    };
    if (files.length === 2) {
      const v = files.find((f) => f.role === 'video'), a = files.find((f) => f.role === 'audio');
      $('status').textContent = 'Merging audio and video…'; $('status').className = '';
      try {
        if (v && a && v.ext === 'webm' && a.ext === 'webm') {
          const merged = await SVDWebm.mergeWebm([v.blob], [a.blob]);
          files = [{ role: 'media', ext: 'webm', blob: merged, bytes: merged.size, filename: `${baseName}.webm` }];
        } else if (v && a && v.ext === 'mp4' && a.ext === 'webm') {
          const merged = await SVDMux.mergeMp4(v.blob, await SVDWebm.opusToMp4(a.blob));
          files = [{ role: 'media', ext: 'mp4', blob: merged, bytes: merged.size, filename: `${baseName}.mp4` }];
        } else {
          if (v && a && v.ext === 'mp4' && a.ext === 'm4a' && wantsWebm()) {
            // Instagram/Facebook: the merged fragmented MP4 can stutter, so save a WebM instead (VP9/AV1 picture copied,
            // AAC sound re-encoded to Opus). Anything that goes wrong here keeps the MP4 merge below.
            try {
              $('status').textContent = 'Converting to WebM…';
              const merged = await SVDToWebm.mp4PairToWebm(v.blob, a.blob, { onProgress: (x) => { $('bar').value = Math.round(x * 100); } });
              files = [{ role: 'media', ext: 'webm', blob: merged, bytes: merged.size, filename: `${baseName}.webm` }];
              webmDone = true;
            } catch (e) {
              webmNote = 'Could not make a WebM (' + (e && e.message ? e.message : e) + '), so it was saved as an MP4 instead.';
              $('bar').value = 100;
            }
          }
          if (webmDone) { /* files already set */ } else {
          if (!v || !a || v.ext !== 'mp4' || a.ext !== 'm4a') throw new SVDMux.MuxError('UNSUPPORTED', `${v && v.ext === 'ts' ? 'MPEG-TS video' : 'This combination of formats (' + (v ? v.ext : '?') + ' + ' + (a ? a.ext : '?') + ')'} cannot be merged here.`);
          const merged = await SVDMux.mergeMp4(v.blob, a.blob);
          files = [{ role: 'media', ext: 'mp4', blob: merged, bytes: merged.size, filename: `${baseName}.mp4` }];
          }
        }
      } catch (e) {
        mergeNote = 'Could not merge audio and video (' + (e && e.message ? e.message : e) + ') so they were saved as two files.';
      }
    }

    const names = [];
    for (const f of files) {
      await saveBlob(f.blob, f.filename);
      names.push({ filename: f.filename, ext: f.ext, role: f.role });
    }
    $('status').textContent = 'Done. Saved: ' + names.map((n) => n.filename).join(', ');
    $('status').className = 'done';
    document.title = 'Done – ' + baseName;
    const note = (text, code) => {
      $('note').hidden = false;
      $('note').textContent = text;
      if (code) { $('note').append(' '); const c = document.createElement('code'); c.textContent = code; $('note').append(c); }
    };
    if (mergeNote && names.length > 1) {
      const v = names.find((n) => n.role === 'video'), a = names.find((n) => n.role === 'audio');
      note(mergeNote + (v && a && v.ext === 'mp4' ? ' To combine them with FFmpeg: ' : ''), v && a && v.ext === 'mp4' ? `ffmpeg -i "${v.filename}" -i "${a.filename}" -c copy "${baseName}_merged.mp4"` : '');
    } else if (names.length === 1 && names[0].ext === 'ts') {
      note('Saved as MPEG-TS (.ts), which VLC and most players open. To convert to MP4 (optional, needs FFmpeg): ', `ffmpeg -i "${names[0].filename}" -c copy "${baseName}.mp4"`);
    } else if (webmDone) {
      note('Audio and video were merged into one WebM file (VP9/AV1 picture copied as it is, sound converted from AAC to Opus). Plays in browsers, VLC and most players.');
    } else if (result.files.length === 2 && names.length === 1 && names[0].ext === 'webm') {
      note('Audio and video were merged into one WebM file (plays in browsers, VLC and most players).');
    } else if (result.files.length === 2 && names.length === 1) {
      note((webmNote ? webmNote + ' ' : '') + 'Audio and video were merged into one MP4 (fragmented MP4: plays in browsers, VLC and most players; for video editors convert it with: ', `ffmpeg -i "${names[0].filename}" -c copy "${baseName}_editor.mp4"`);
      $('note').append(')');
    }
  } catch (e) {
    const known = e && (e.name === 'StreamError' || e.name === 'MuxError');
    fail(known ? e.message : 'Unexpected error: ' + (e && e.message ? e.message : e));
    $('bar').value = 0;
  }
})();
