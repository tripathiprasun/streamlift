'use strict';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const msgEl = document.getElementById('msg');
const countEl = document.getElementById('count');   // "3 items found" under the title (display only)
const statuses = new Map();   // url -> {text, error}, survives re-renders
const active = new Map();     // downloadId -> url, for failure reporting
const qualityCache = new Map(); // stream url -> Promise<{qualities}|{error, fatal}>
const chosenQuality = new Map(); // stream url -> selected quality id
let tabId = null;

function isHttp(value) {
  try {
    const p = new URL(value).protocol;
    return p === 'http:' || p === 'https:';
  } catch (e) {
    return false;
  }
}

function showMsg(text, error) {
  msgEl.hidden = !text;
  msgEl.textContent = text || '';
  msgEl.classList.toggle('error', !!error);
}

// Turns chrome.downloads error codes into something readable. We never try to get around
// logins or hotlink protection; we just say what happened.
function friendlyError(code) {
  if (/FORBIDDEN|UNAUTHORIZED/.test(code)) return 'The server refused the request (login or hotlink protection).';
  if (/BAD_CONTENT|FILE_NOT_FOUND/.test(code)) return 'The file was not found on the server.';
  if (/^NETWORK|SERVER_FAILED|TIMEOUT/.test(code)) return 'Network error. Check your connection and try again.';
  if (/FILE_/.test(code)) return 'Could not save the file to disk (' + code + ').';
  if (code === 'USER_CANCELED') return 'Download canceled.';
  return 'Download failed (' + code + ').';
}

async function startDownload(video) {
  if (!isHttp(video.url)) throw new Error('Invalid URL');
  try {
    return await chrome.downloads.download({
      url: video.url,
      filename: video.filename,
      conflictAction: 'uniquify',
    });
  } catch (e) {
    // If the browser rejects our filename, let it pick one from the URL instead.
    if (/filename/i.test(e.message)) return chrome.downloads.download({ url: video.url });
    throw e;
  }
}

const fmtMB = (n) => (n / 1048576).toFixed(n >= 1e8 ? 0 : 1) + ' MB';
const fmtTime = (sec) => { const s = Math.round(sec); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

// One-line description of a blob capture, e.g. "12.4 MB · captured 0:35 of 0:42 (83%)".
function captureText(c) {
  const bits = [fmtMB(c.bytes)];
  if (c.duration > 0 && c.covered > 0) {
    const pct = Math.min(100, Math.round((c.covered / c.duration) * 100));
    bits.push(`captured ${fmtTime(c.covered)} of ${fmtTime(c.duration)} (${pct}%)`);
  }
  if (c.tracks.length > 1) bits.push('video + audio (merged into one file)');
  if (c.parts > 1) bits.push(`${c.parts} parts (the player changed quality; saved as separate parts)`);
  if (c.truncated) bits.push('size limit reached, the rest is not captured');
  return bits.join(' · ');
}

const captureComplete = (c) => c.whole || (c.duration > 0 && c.covered >= c.duration - 0.4);

function formatLabel(v) {
  if (v.kind === 'pair') return 'Video + audio (merged when downloaded)';
  if (v.kind === 'capture') return 'Blob video (captured from the player)';
  if (v.kind === 'hls') return 'HLS stream (.m3u8)';
  if (v.kind === 'dash') return 'DASH stream (.mpd)';
  const m = /\.([a-z0-9]+)$/i.exec(v.filename || '');
  return (m ? m[1].toUpperCase() : 'FILE') + ' file';
}

// Reads the manifest (needs host permission, which the manifest grants) and lists qualities.
function loadQualities(url) {
  if (!qualityCache.has(url)) {
    qualityCache.set(url, (async () => {
      try {
        const text = await SVDStream.fetchManifest((...a) => fetch(...a), url);
        return { qualities: SVDStream.describe(text, url).qualities };
      } catch (e) {
        const known = e && e.name === 'StreamError';
        return { error: known ? e.message : 'Could not read the manifest.', fatal: known && SVDStream.FATAL.has(e.code) };
      }
    })());
  }
  return qualityCache.get(url);
}

// popup.css draws the icons from these classes; the label text stays as the accessible name.
const BTN_ICONS = { 'Download': 'ic-download', 'Copy URL': 'ic-copy', 'Remove': 'ic-close', 'Save as is': 'ic-save', 'Cancel': 'ic-stop' };

function button(text, cls) {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = ['btn', cls, BTN_ICONS[text]].filter(Boolean).join(' ');
  return b;
}

// Colour/icon family of an entry (display only; popup.css maps it to a tile colour).
function mediaClass(v) {
  if (v.kind === 'capture') return 'k-capture';
  if (v.kind === 'pair') return 'k-pair';
  if (v.kind === 'hls' || v.kind === 'dash') return 'k-stream';
  return /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(v.filename || '') ? 'k-audio' : 'k-file';
}

function render(videos) {
  listEl.textContent = '';
  emptyEl.hidden = videos.length > 0;
  if (countEl) countEl.textContent = videos.length ? videos.length + (videos.length === 1 ? ' item' : ' items') + ' found' : 'Nothing found yet';
  // Network files first, then streams, then blob (playback) captures. Entries from Part 1 have no kind: treat as files.
  const rank = (v) => ({ file: 0, pair: 1, capture: 3 }[v.kind || 'file'] ?? 2);
  const isFile = (v) => (v.kind || 'file') === 'file';
  const sorted = [...videos].sort((a, b) => rank(a) - rank(b));

  for (const v of sorted) {
    const downloadable = isFile(v);
    const li = document.createElement('li');
    li.className = 'card ' + mediaClass(v);

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = formatLabel(v);

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = v.filename;
    name.title = v.filename || '';

    const url = document.createElement('div');
    url.className = v.kind === 'capture' ? 'url meta' : 'url';
    if (v.kind === 'capture') {
      url.style.whiteSpace = 'normal';
      url.textContent = v.capture.protected
        ? 'Encrypted playback (DRM): not captured.'
        : captureText(v.capture);
    } else {
      url.textContent = v.url;
      url.title = v.url;
    }
    const note = document.createElement('div');
    note.className = 'note';
    const job = v.kind === 'capture' && v.capture.job;
    const jobActive = !!job && job.phase === 'loading';
    if (jobActive) li.className += ' busy';
    note.textContent = v.note || (v.kind === 'capture' && !v.capture.protected && !job
      ? (captureComplete(v.capture)
        ? (v.capture.tracks.length > 1 ? 'Audio and video will be merged into one file.' : '')
        : 'Download loads the rest of the video by itself: it fast-forwards muted for a moment, then saves one merged file. Keep this tab in front.')
      : '');
    note.hidden = !note.textContent;

    const row = document.createElement('div');
    row.className = 'row';
    const status = document.createElement('span');
    status.className = 'status';
    const prev = statuses.get(v.url);
    if (v.kind === 'capture' && v.capture.job) {
      status.textContent = v.capture.job.message;
      status.classList.toggle('error', v.capture.job.phase === 'failed');
    } else if (prev) {
      status.textContent = prev.text;
      status.classList.toggle('error', prev.error);
    }
    const set = (text, error) => {
      statuses.set(v.url, { text, error });
      status.textContent = text;
      status.classList.toggle('error', error);
    };

    const dl = button('Download', 'primary');
    if (v.kind === 'capture') {
      const idle = !jobActive && !v.capture.protected;
      dl.disabled = !idle;
      const ask = async (mode, btn) => {
        btn.disabled = true;
        set(mode === 'asis' ? 'Saving…' : 'Starting…', false);
        try {
          const base = (v.filename || 'video').replace(/\.[^.]+$/, '');
          const r = await chrome.tabs.sendMessage(tabId, { type: 'capture-download', id: v.captureId, name: base, mode }, { frameId: v.frameId });
          if (!r) throw new Error('The page did not answer. Reload it and play the video again.');
          if (!r.ok) throw new Error(r.error);
          if (r.started) set('Loading the rest of the video… it is saved automatically when done.', false);
          else set('Saved: ' + r.files.map((f) => f.name).join(', ') + (r.merged ? ' (audio + video merged)' : '') + (r.partial ? ' (incomplete: parts of the video are missing)' : '') + (r.note ? ' ' + r.note : ''), false);
        } catch (e) {
          set('Failed: ' + (e && e.message ? e.message : e), true);
        } finally {
          btn.disabled = !idle;
        }
      };
      dl.addEventListener('click', () => ask('complete', dl));
      row.append(dl);
      if (jobActive) {
        const cancel = button('Cancel', 'secondary');
        cancel.addEventListener('click', () => chrome.tabs.sendMessage(tabId, { type: 'capture-cancel', id: v.captureId }, { frameId: v.frameId }).catch(() => {}));
        row.append(cancel);
      } else if (idle && !captureComplete(v.capture)) {
        const asis = button('Save as is', 'secondary');
        asis.title = 'Save only what the player has loaded so far (the video will have gaps)';
        asis.addEventListener('click', () => ask('asis', asis));
        row.append(asis);
      }
    } else if (v.kind === 'pair') {
      dl.addEventListener('click', async () => {
        if (!isHttp(v.url) || !isHttp(v.audioUrl)) return set('Failed: invalid URL.', true);
        const q = new URLSearchParams({ url: v.url, audio: v.audioUrl, name: v.filename, ref: v.ref || '' });
        try {
          await chrome.tabs.create({ url: chrome.runtime.getURL('downloader/downloader.html') + '?' + q });
          set('Download opened in a new tab', false);
        } catch (e) {
          set('Could not open the download tab: ' + e.message, true);
        }
      });
      row.append(dl);
    } else if (downloadable) {
      dl.addEventListener('click', async () => {
        dl.disabled = true;
        set('Starting…', false);
        try {
          const id = await startDownload(v);
          if (id !== undefined) active.set(id, v.url);
          set('Download started', false);
        } catch (e) {
          set('Failed: ' + (e.message === 'Invalid URL' ? 'invalid URL.' : e.message), true);
        } finally {
          dl.disabled = false;
        }
      });
      row.append(dl);
    } else {
      // HLS/DASH: choose a quality, then the download runs in its own tab (progress shown there).
      const sel = document.createElement('select');
      const best = document.createElement('option');
      best.value = 'best'; best.textContent = 'Best available';
      sel.append(best);
      sel.addEventListener('change', () => chosenQuality.set(v.url, sel.value));
      dl.disabled = true;
      loadQualities(v.url).then((r) => {
        if (r.error) {
          set(r.error, true);
          dl.disabled = !!r.fatal;
          return;
        }
        for (const q of r.qualities) {
          const o = document.createElement('option');
          o.value = q.id; o.textContent = q.label;
          sel.append(o);
        }
        if (chosenQuality.has(v.url)) sel.value = chosenQuality.get(v.url);
        dl.disabled = false;
      });
      dl.addEventListener('click', async () => {
        if (!isHttp(v.url)) return set('Failed: invalid URL.', true);
        const q = new URLSearchParams({ url: v.url, quality: sel.value, name: v.filename, ref: v.ref || '' });
        try {
          await chrome.tabs.create({ url: chrome.runtime.getURL('downloader/downloader.html') + '?' + q });
          set('Download opened in a new tab', false);
        } catch (e) {
          set('Could not open the download tab: ' + e.message, true);
        }
      });
      row.append(sel, dl);
    }

    const copy = button('Copy URL', 'tool');
    copy.title = 'Copy URL';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(v.url); set('URL copied', false); }
      catch (e) { set('Could not copy the URL', true); }
    });
    const remove = button('Remove', 'tool');
    remove.title = 'Remove from this list';
    remove.addEventListener('click', () => {
      statuses.delete(v.url);
      chrome.runtime.sendMessage({ type: 'remove', tabId, url: v.url }).catch(() => {});
    });
    row.append(status);

    // Layout only: [tile | name, badge, url | copy, remove], then the note, then the action row.
    const tools = document.createElement('div');
    tools.className = 'tools';
    if (v.kind === 'capture') tools.append(remove);
    else tools.append(copy, remove);
    const main = document.createElement('div');
    main.className = 'main';
    main.append(name, badge, url);
    const tile = document.createElement('div');
    tile.className = 'tile';
    const top = document.createElement('div');
    top.className = 'top';
    top.append(tile, main, tools);
    li.append(top, note, row);
    listEl.append(li);
  }
}

async function refresh() {
  showMsg('Scanning the page…');
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'rescan' });
    showMsg('Scan finished.');
  } catch (e) {
    showMsg('Can’t scan this page. Reload it, or it may be a browser page where extensions can’t run.', true);
  }
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined) return render([]);
  tabId = tab.id;

  const key = `videos_${tabId}`;
  const stored = await chrome.storage.session.get(key);
  render(stored[key] || []);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes[key]) render(changes[key].newValue || []);
  });

  // "Show a download icon on videos": saved setting, read by content.js on every page.
  const overlayBox = document.getElementById('overlay');
  if (overlayBox) {
    chrome.storage.local.get({ svd_overlay: true }).then((s) => { overlayBox.checked = s.svd_overlay !== false; });
    overlayBox.addEventListener('change', () => chrome.storage.local.set({ svd_overlay: overlayBox.checked }));
  }

  document.getElementById('refresh').addEventListener('click', refresh);
  document.getElementById('clear').addEventListener('click', () => {
    statuses.clear();
    chrome.runtime.sendMessage({ type: 'clear', tabId }).catch(() => {});
    showMsg('List cleared. Press Refresh to detect media again.');
  });

  // Report failures that happen after the download has started (HTTP 403, network drop, ...).
  chrome.downloads.onChanged.addListener((delta) => {
    const url = active.get(delta.id);
    if (!url) return;
    if (delta.error) {
      statuses.set(url, { text: friendlyError(delta.error.current), error: true });
      active.delete(delta.id);
      chrome.storage.session.get(key).then((s) => render(s[key] || []));
    } else if (delta.state && delta.state.current === 'complete') {
      statuses.set(url, { text: 'Download complete', error: false });
      active.delete(delta.id);
      chrome.storage.session.get(key).then((s) => render(s[key] || []));
    }
  });
}

init();
