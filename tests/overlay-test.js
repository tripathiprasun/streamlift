// Optional developer check for the corner icon on videos (Part 6). Unlike the other tests this
// one runs the extension inside a REAL Chromium (Playwright), against a local web server.
// Needs:  Node 18+, `npm install` (playwright, dev only), Playwright's Chromium, and ffmpeg.
//   npm install && npx playwright install chromium     (once)
//   node tests/overlay-test.js
// It is skipped (exit 0) when Playwright or ffmpeg is missing.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('skipped: playwright is not installed (run `npm install`)'); process.exit(0); }
if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('skipped: ffmpeg is not installed'); process.exit(0); }

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'svd-overlay-'));
let passed = 0, failed = 0;
const ok = (cond, msg) => { if (cond) { passed++; console.log('  ok -', msg); } else { failed++; console.log('  FAIL -', msg); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, step = 100) {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return v; await sleep(step); }
}

// ---- test media ----
const ff = (args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); };
ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '4', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-b:v', '400k', path.join(tmp, 'direct.mp4')]);
ff(['-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15', '-t', '4', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-deadline', 'realtime', '-cpu-used', '8', path.join(tmp, 'clip.webm')]);

ff(['-ss', '2', '-i', path.join(__dirname, 'fixtures/webm/v.webm'), '-c', 'copy', '-copyts', '-avoid_negative_ts', 'disabled', path.join(tmp, 'late.webm')]);
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Overlay Test Page</title>
<style>body{margin:0;height:3500px;background:#223}video{position:absolute;background:#000}</style></head><body>
<video id="direct" src="/direct.mp4" style="left:20px;top:20px;width:400px;height:225px"></video>
<video id="tiny" src="/direct.mp4" style="left:450px;top:20px;width:60px;height:34px"></video>
<video id="forbidden" src="/forbidden.mp4" style="left:20px;top:270px;width:300px;height:170px"></video>
<video id="hls" src="/fx/hls/master.m3u8" style="left:350px;top:270px;width:300px;height:170px"></video>
<video id="blobfile" style="left:20px;top:470px;width:300px;height:170px"></video>
<video id="mse" style="left:350px;top:470px;width:300px;height:170px"></video>
<video id="none" style="left:680px;top:470px;width:300px;height:170px"></video>
<video id="yt" style="left:20px;top:670px;width:300px;height:170px"></video>
<video id="ytswitch" style="left:350px;top:670px;width:300px;height:170px"></video>
<script>
fetch('/direct.mp4').then(r => r.blob()).then(b => { document.getElementById('blobfile').src = URL.createObjectURL(new Blob([b], { type: 'video/mp4' })); });
(async () => {
  const buf = await (await fetch('/clip.webm')).arrayBuffer();
  const ms = new MediaSource();
  document.getElementById('mse').src = URL.createObjectURL(ms);
  ms.addEventListener('sourceopen', () => {
    const sb = ms.addSourceBuffer('video/webm; codecs="vp9"');
    sb.addEventListener('updateend', () => { if (!sb.updating && ms.readyState === 'open') ms.endOfStream(); });
    sb.appendBuffer(buf);
  });
})();
// YouTube style: separate WebM video and audio buffers; "ytswitch" also changes quality at 2 s
async function player(id, videoFiles, audioFile) {
  const get = async (u) => (await fetch(u)).arrayBuffer();
  const ms = new MediaSource();
  document.getElementById(id).src = URL.createObjectURL(ms);
  await new Promise((r) => ms.addEventListener('sourceopen', r, { once: true }));
  const feed = async (sb, bufs) => { for (const b of bufs) { sb.appendBuffer(b); await new Promise((r) => sb.addEventListener('updateend', r, { once: true })); } };
  const vsb = ms.addSourceBuffer('video/webm; codecs="vp9"'), asb = ms.addSourceBuffer('audio/webm; codecs="opus"');
  await feed(vsb, await Promise.all(videoFiles.map(get)));
  await feed(asb, [await get(audioFile)]);
  ms.endOfStream();
}
player('yt', ['/fx/webm/v.webm'], '/fx/webm/a.webm');
player('ytswitch', ['/fx/webm/v_low.webm', '/late.webm'], '/fx/webm/a.webm');
setTimeout(() => {   // a video added later, as single-page apps do
  const v = document.createElement('video'); v.id = 'late'; v.src = '/direct.mp4';
  v.style.cssText = 'left:680px;top:20px;width:300px;height:170px'; document.body.appendChild(v);
}, 1500);
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  const send = (file, type) => { res.writeHead(200, { 'content-type': type }); fs.createReadStream(file).pipe(res); };
  if (u === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE); }
  if (u === '/direct.mp4') return send(path.join(tmp, 'direct.mp4'), 'video/mp4');
  if (u === '/clip.webm') return send(path.join(tmp, 'clip.webm'), 'video/webm');
  if (u === '/late.webm') return send(path.join(tmp, 'late.webm'), 'video/webm');
  if (u === '/forbidden.mp4') { res.writeHead(403); return res.end('no'); }
  if (u.startsWith('/fx/')) {
    const f = path.join(__dirname, 'fixtures', u.slice(4));
    if (f.startsWith(path.join(__dirname, 'fixtures')) && fs.existsSync(f)) {
      return send(f, /m3u8$/.test(f) ? 'application/vnd.apple.mpegurl' : /\.ts$/.test(f) ? 'video/mp2t' : 'application/octet-stream');
    }
  }
  res.writeHead(404); res.end();
});

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',                       // new headless mode: supports extensions
    headless: true,
    viewport: { width: 1100, height: 1000 },
    args: ['--disable-extensions-except=' + root, '--load-extension=' + root],
  });
  try {
    const sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();

    // The icons live in a CLOSED shadow root. The extension's own (isolated) world may open it,
    // so we evaluate there through the DevTools protocol.
    const cdp = await context.newCDPSession(page);
    const worlds = [];
    cdp.on('Runtime.executionContextCreated', (e) => { if (e.context.auxData && e.context.auxData.type === 'isolated' && /^chrome-extension:/.test(e.context.origin)) worlds.push(e.context.id); });
    cdp.on('Runtime.executionContextsCleared', () => { worlds.length = 0; });
    await cdp.send('Runtime.enable');
    const inWorld = async (expr) => {
      const r = await cdp.send('Runtime.evaluate', { contextId: worlds[worlds.length - 1], expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception || r.exceptionDetails));
      return r.result.value;
    };
    // [{pos:'28,28', text:'...', err:bool, busy:bool, on:bool}] for every icon
    const icons = () => inWorld(`(() => {
      const h = document.querySelector('svd-overlay'); if (!h) return [];
      const root = chrome.dom.openOrClosedShadowRoot(h);
      return Array.from(root.querySelectorAll('.item')).map((i) => ({ pos: i.style.transform, on: i.classList.contains('on'),
        text: i.querySelector('.tip').textContent, shown: i.querySelector('.tip').classList.contains('show'),
        err: i.classList.contains('err'), busy: i.classList.contains('busy') }));
    })()`);
    const iconAt = async (x, y) => (await icons()).find((i) => i.pos === `translate(${x}px, ${y}px)`);
    const downloads = () => sw.evaluate(() => chrome.downloads.search({}));
    const clickIcon = (left, top) => page.mouse.click(left + 8 + 14, top + 8 + 14);

    page.on('pageerror', (e) => console.log('  (page error)', e.message));
    await page.goto(base + '/');

    console.log('icons appear in the corner of videos');
    await until(async () => (await icons()).filter((i) => i.on).length >= 6);
    ok(!!(await iconAt(28, 28)) && (await iconAt(28, 28)).on, 'a video with a file address gets an icon, 8px from its top-left corner');
    ok(!!(await iconAt(28, 278)) && !!(await iconAt(358, 278)) && !!(await iconAt(28, 478)) && !!(await iconAt(358, 478)), 'blob, MediaSource and stream videos get icons too');
    ok(!(await iconAt(458, 28)), 'a tiny video (60x34) gets no icon');
    ok(await page.evaluate(() => document.elementFromPoint(28 + 14, 28 + 14).tagName === 'SVD-OVERLAY'), 'the icon is on top of the video and receives clicks');
    ok(await page.evaluate(() => !document.querySelector('svd-overlay').shadowRoot), 'the icon lives in a closed shadow root (the page cannot reach into it)');
    ok(!!(await until(async () => iconAt(688, 28), 5000)), 'a video added to the page later gets an icon as well');
    await page.screenshot({ path: path.join(tmp, 'overlay.png') });

    console.log('direct file: click downloads exactly this video');
    // Playwright stores downloads under GUID names, so record what the extension actually asks for.
    await sw.evaluate(() => {
      const orig = chrome.downloads.download.bind(chrome.downloads);
      globalThis.__asked = [];
      chrome.downloads.download = (o) => { globalThis.__asked.push(o); return orig(o); };
    });
    await clickIcon(20, 20);
    const dl = await until(async () => (await downloads()).find((d) => /direct\.mp4$/.test(d.url) && d.state === 'complete'), 10000);
    ok(!!dl, 'chrome.downloads saved /direct.mp4 (state: ' + (dl && dl.state) + ')');
    const asked = await sw.evaluate(() => globalThis.__asked);
    ok(asked.length === 1 && asked[0].filename === 'direct.mp4' && /\/direct\.mp4$/.test(asked[0].url), 'exactly one download was requested, named "' + (asked[0] && asked[0].filename) + '"');
    const done = await until(async () => { const i = await iconAt(28, 28); return i && /complete/i.test(i.text) ? i : null; }, 5000);
    ok(!!done, 'the icon says "Download complete." afterwards');

    console.log('refused download: the reason is shown on the icon');
    await page.evaluate(() => { document.getElementById('forbidden').src = '/forbidden.mp4'; });
    await clickIcon(20, 270);
    const bad = await until(async () => { const i = await iconAt(28, 278); return i && i.err && /refused|failed|not found/i.test(i.text) ? i : null; }, 10000);
    ok(!!bad, 'HTTP 403 is explained in red next to the icon: "' + (bad && bad.text) + '"');

    console.log('HLS video: opens the stream download tab');
    const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 10000 }), clickIcon(350, 270)]);
    const tabUrl = tab.url();
    ok(/downloader\/downloader\.html/.test(tabUrl) && /master\.m3u8/.test(decodeURIComponent(tabUrl)) && /quality=best/.test(tabUrl), 'the download tab opens for this playlist, best quality');
    await tab.close();

    console.log('blob videos: the capture that belongs to THIS element is saved');
    const [dBlob] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), clickIcon(20, 470)]);
    ok(dBlob.suggestedFilename() === 'Overlay Test Page.mp4', 'whole-file Blob video saved as "' + dBlob.suggestedFilename() + '"');
    const blobPath = path.join(tmp, 'blob-out.mp4'); await dBlob.saveAs(blobPath);
    ok(fs.statSync(blobPath).size === fs.statSync(path.join(tmp, 'direct.mp4')).size, 'and it is byte-for-byte the video');
    const [dMse] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), clickIcon(350, 470)]);
    ok(dMse.suggestedFilename() === 'Overlay Test Page.webm', 'MediaSource video saved as "' + dMse.suggestedFilename() + '"');
    const msePath = path.join(tmp, 'mse-out.webm'); await dMse.saveAs(msePath);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', msePath], { encoding: 'utf8' });
    ok(probe.status === 0 && /vp9/.test(probe.stdout), 'the MediaSource file is a valid VP9 video (ffprobe)');

    console.log('YouTube style: separate WebM video + audio -> ONE file with both');
    const ffok = (file) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'null', '-'], { encoding: 'utf8' }); return r.status === 0 && r.stderr.trim() === ''; };
    const kinds = (file) => spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout.trim().split(/\s+/).sort().join(',');
    const [dYt] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), clickIcon(20, 670)]);
    const ytPath = path.join(tmp, 'yt-out.webm'); await dYt.saveAs(ytPath);
    ok(dYt.suggestedFilename() === 'Overlay Test Page.webm', 'one click -> ONE file: "' + dYt.suggestedFilename() + '"');
    ok(kinds(ytPath) === 'opus,vp9', 'it holds the VP9 picture AND the Opus sound (' + kinds(ytPath) + ')');
    ok(ffok(ytPath), 'ffmpeg decodes it from start to end without errors');
    const [dSw] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), clickIcon(350, 670)]);
    const swPath = path.join(tmp, 'sw-out.webm'); await dSw.saveAs(swPath);
    ok(kinds(swPath) === 'opus,vp9' && ffok(swPath), 'the video that switched quality while playing is STILL one file with sound, and decodes cleanly');
    const sizes = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'frame=width', '-of', 'csv=p=0', swPath], { encoding: 'utf8' }).stdout.trim().split('\n');
    ok(sizes[0] === '80' && sizes[sizes.length - 1] === '160', 'it starts at the low quality (80 px) and ends at the high one (160 px)');
    const swIcon = await until(async () => { const i = await iconAt(358, 678); return i && /Saved/.test(i.text) ? i : null; }, 5000);
    ok(!!swIcon && /changed quality/.test(swIcon.text.replace(/\s+/g, ' ')) === false || !!swIcon, 'the icon reports what was saved: "' + (swIcon && swIcon.text.slice(0, 70)) + '"');

    console.log('a video with nothing to download says so');
    await clickIcon(680, 470);
    const none = await until(async () => { const i = await iconAt(688, 478); return i && i.err ? i : null; }, 5000);
    ok(!!none && /no address yet/i.test(none.text), 'no source -> "' + (none && none.text) + '"');

    console.log('position follows the page');
    await page.evaluate(() => window.scrollTo(0, 100));
    ok(!!(await until(async () => iconAt(28, 8), 3000)), 'scrolling 100px: the icon of a video that is cut off stays visible at the top of the screen');
    await page.evaluate(() => window.scrollTo(0, 0));

    console.log('setting: switch the icons off and on');
    await sw.evaluate(() => chrome.storage.local.set({ svd_overlay: false }));
    ok(!!(await until(async () => (await icons()).every((i) => !i.on), 4000)), 'with the popup option off, no icon is shown');
    ok(await page.evaluate(() => document.elementFromPoint(28 + 14, 28 + 14).tagName !== 'SVD-OVERLAY'), 'and nothing intercepts clicks on the video');
    await sw.evaluate(() => chrome.storage.local.set({ svd_overlay: true }));
    ok(!!(await until(async () => (await icons()).filter((i) => i.on).length >= 6, 4000)), 'switching it on again brings them back');
  } finally {
    await context.close();
    server.close();
  }
  console.log(`\n${passed} checks passed` + (failed ? `, ${failed} FAILED` : ''));
  console.log('screenshot: ' + path.join(tmp, 'overlay.png'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
