# Streamlift: technical notes

Streamlift, built by Prasun Tripathi, is a small Manifest V3 extension for Chrome and Edge that detects media on a page and downloads
**direct files** with the browser's downloads API, downloads **unencrypted HLS (`.m3u8`) and MPEG-DASH (`.mpd`) streams** (Part 3), and (new in Part 4)
finds **hidden media**: videos that sites load from JavaScript/API calls, split audio/video tracks, and **`blob:` videos**
played through MediaSource (the way Instagram, Facebook, X and many others play video). **New in Part 7: picture and sound in ONE file** wherever that is technically possible (WebM as served by YouTube, quality switches, separately found tracks; details below). Part 6 added a small download icon in the corner of every video.
Plain JavaScript/HTML/CSS, no build step; npm is only used for the optional real-browser test. FFmpeg is optional.

## Install (Chrome or Edge)

1. unzip the release zip. (Updating from an earlier part: open `chrome://extensions`, remove or reload the old copy, then load this folder.)
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).

Requires Chrome/Edge **111** or newer (uses `chrome.storage.session` and page-world content scripts).

**Permissions:** Part 3 adds `host_permissions` for all http(s) sites. The extension must read manifests and fetch
segments from the CDN that hosts them, and normal page rules (CORS) would block that. Requests are only made when you
open the popup on a stream entry or press Download; nothing is sent anywhere except to the stream's own server.
Part 4 adds the `webRequest` permission, used **read-only** (response headers such as content-type and size; never blocking
or changing a request) to recognise media that has no telltale URL.

## Use

**The icon on the video (new in Part 6).** On any page, each visible video gets a small round blue button (play triangle with a
download arrow) in its **top-left corner**. It is dimmed until you move the mouse over the video. **Click it to download that video**;
a short message next to the icon says what happened (started, saved, refused by the server ...). What the click does depends on the video:

| The video is ... | Click on the icon ... |
|---|---|
| a plain file (`.mp4`, `.webm` ...) | saves that file with the browser's downloads (same as the popup's Download) |
| an HLS/DASH stream (`.m3u8`/`.mpd`) | opens the download tab for that stream, best quality |
| a `blob:` video (MediaSource: Instagram, X, most players) | saves what the player has loaded; if parts are missing it loads them itself (muted, fast, then restores your position) and saves one merged MP4. While that runs, **click the icon again to cancel** |
| DRM-protected, or not started yet | says why nothing was saved (e.g. "Press play for a moment, then click again") |

Videos smaller than about 120x68 pixels (ads, thumbnails) get no icon. The icon hides in full-screen mode. Turn it off any time with the
**Show a download icon on videos** checkbox at the top of the popup (the popup list keeps working either way). The icon sits in a closed
shadow root, so page styles cannot change it, and it reads nothing from the page; it needs no new permissions.

**One file with picture and sound (new in Part 7).** Sites send video and audio as two separate streams. The extension now puts them back together
without re-encoding, in these situations:

| What the page does | Result |
|---|---|
| MP4 video + MP4 audio (Instagram, Facebook, X ...), one quality | one `.mp4` |
| **Instagram / Facebook** video + audio in the download tab (VP9 or AV1 picture in MP4 + AAC audio) | one **`.webm`** (v0.7.1): the picture is copied, the sound is converted AAC -> Opus by the browser, and the file has a seek index, so it plays without the stutter of a fragmented MP4. If the picture is H.264, or the browser cannot decode/encode the sound, it falls back to the `.mp4` merge and says why |
| **WebM video (VP9/AV1) + WebM audio (Opus)**, which is what YouTube sends to Chrome | one `.webm`, with an index so you can seek |
| The player **switched quality** while loading, WebM | still one `.webm` (the picture changes size partway; the later quality replaces the overlap) |
| The player switched quality, MP4 | one `.partN.mp4` per quality, **each with its own slice of the sound** (MP4 cannot hold different picture sizes in one file that every player and browser reads correctly; this was tried and rejected, see below) |
| Video and audio found separately on the network (Instagram/Facebook range URLs, YouTube-style `videoplayback` URLs) | one popup entry **Video + audio (merged when downloaded)**: the biggest video and the audio are paired automatically |
| A video file + an audio file in the download tab, both WebM | one `.webm` |
| MP4 video + WebM audio (different containers) | two files, and the message says why (re-encoding would be needed) |

The same applies to the corner icon, because it uses the same capture.

**The popup list** (unchanged, still the place for choosing a stream quality, *Save as is*, Copy URL ...):

1. Open a page with media. The toolbar badge shows how many items were found.
2. Click the icon. Direct files (MP4, WebM, M4V, OGV, MP3, M4A, AAC, OGG, WAV, FLAC...) are listed first with a
   **Download** button, exactly as before.
3. **Streams (HLS/DASH):** the popup reads the manifest and fills a drop-down with the detected qualities
   (e.g. `1080p · 5.0 Mbps`), default "Best available". Press **Download**: a new tab opens that shows the selected
   format, segment progress (`12/48 segments, 8.3 MB`) and a Cancel button, then saves the file(s) through the browser's
   downloads. If something is wrong (encrypted, expired link, missing segment...), the tab and/or popup says why.
   The popup can be closed while the tab downloads.
4. **Blob videos:** many sites play video through MediaSource, so the `<video>` points at `blob:...` and no file URL exists.
   The extension records what the player loads and lists it as **Blob video (captured from the player)** with its size and
   how much of the video it has (`captured 0:35 of 0:42 (83%)`). **You do not have to play it through (new in Part 5):** press
   **Download** and, if parts are missing, the extension makes the player load them itself: the video fast-forwards *muted* for a
   moment (seeking into the missing parts), is put back exactly where you were (position, volume, speed, loop), and the finished
   file is saved automatically. Progress shows in the popup (with **Cancel**); the popup may be closed. Keep the tab in front
   while it loads. **Save as is** saves only what is loaded so far (gaps possible).
   Saved by the page itself, so Chrome may ask to *allow multiple downloads* the first time.
5. **Video + audio entries (new in Part 5):** when a page's data contains a complete video file and a complete audio file
   (Instagram/Facebook style), one entry **Video + audio (merged when downloaded)** is listed (best quality). Download opens the
   download tab, which fetches both files in full, merges them and saves ONE `.mp4`. No playback involved at all.
6. **One file, with sound (new in Part 5):** whenever a download produces a separate video and audio MP4 (DASH, HLS with fMP4,
   video+audio entries, blob captures) they are **merged into one MP4 by the extension itself** (no FFmpeg needed). Nothing is
   re-encoded: the media bytes are copied. The result is a *fragmented* MP4 for streams/captures (plays in browsers, VLC and most
   players; video editors may want `ffmpeg -i in.mp4 -c copy out.mp4` first) and a normal MP4 for plain-file pairs.
7. **Refresh** re-scans the page (also re-adds items you removed). **Remove** deletes one entry, **Clear** empties the list.
8. After a direct download starts, the popup reports later failures (e.g. "server refused the request").

## Test it

- **Corner icon, in a real browser (new in Part 6, optional).** `npm install`, then `npx playwright install chromium` once, then
  `npm run test:browser` (= `node tests/overlay-test.js`, `26 checks passed`). It loads the extension into Chromium and serves a page
  with a direct file, a tiny video, a refused file, an HLS video, a whole-file Blob, a real MediaSource (VP9) video, a YouTube-style player with separate WebM video and audio buffers (also one that switches quality), a video with no source and a
  video added later; it clicks the icons and checks what was downloaded (files compared byte for byte, ffprobe on the MediaSource result),
  the on-icon messages, scrolling, and the on/off setting. Skipped automatically without Playwright or ffmpeg.
- Automated (optional, needs Node 18+; no npm packages): `node tests/smoke-test.js` (existing + popup/background logic, `115 checks passed`),
  `node tests/stream-test.js` (parsers, ordering, URL resolution, real downloads from a local server, errors; `56 checks passed`) and
  `node tests/capture-test.js` (JSON/manifest sniffing, page-world hooks, blob capture and auto-complete driven by real fMP4 fixtures, background sniffer, WebM capture, auto-pairing; `189 checks passed`), `node tests/mux-test.js` (the MP4 merger, checked with ffprobe/ffmpeg; `33 checks passed`) and `node tests/downloader-test.js` (the download tab against a local server; `17 checks passed`) and `node tests/merge-test.js` (Part 7: WebM merger and MP4 quality parts, every result decoded by ffmpeg; `27 checks passed`), and `node tests/towebm-test.js` (v0.7.1: MP4 -> WebM picture conversion, `20 checks passed`; `node tests/towebm-browser-test.js` checks the AAC -> Opus half in a real browser). The last four use ffprobe/ffmpeg for decoding checks when installed.
  Fixtures in `tests/fixtures/` are tiny generated clips (HLS TS, HLS fMP4, DASH video+audio). If `ffprobe`/`ffmpeg` are installed the tests also verify the output plays.
- Manual in the browser:
  1. Load the extension, open `https://www.w3schools.com/tags/tryit.asp?filename=tryhtml5_video`
     (the case that failed in Part 1: the video lives in an `about:blank` frame), reload the page, open the popup.
     You should see `movie.mp4` (and `movie.ogg`). Click **Download**.
  2. Open a page with an unencrypted HLS or DASH player: the stream appears with a quality list and Download button. (Not verified in a real browser by the author; see limitations.)
  3. On a single-page app, navigate within the site and press **Refresh**.
  4. Try **Clear**, **Remove**, **Refresh**, and **Copy URL**.

## What it detects

- `<video>`, `<audio>`, `<source>` (inside either), `<embed>`, `<object>`, `data-src` lazy-loading attributes
- `<a href>` links ending in a media or manifest extension (a `download="name"` attribute is used as the filename)
- HLS/DASH manifests that players fetch via XHR/fetch, found through the page's Resource Timing entries
- All of the above when added or changed later, in iframes and `about:blank` frames, plus a 3-second safety rescan
  for pages that rewrite their own document

**New in Part 4 (hidden media):**

- **API responses.** `fetch`/XHR responses are inspected (read-only, the page gets the untouched response). JSON is searched for
  video URLs: `video_versions` (Instagram), `playable_url` / `browser_native_*_url` (Facebook), `variants[]` (X), `playAddr`
  (TikTok), `fallback_url` / `hls_url` (Reddit), `contentUrl`, `sources[]`/`renditions[]` lists, and DASH XML embedded inside
  JSON (its `BaseURL`s are listed as *Video only* / *Audio only*). Facebook's `for (;;);` prefix and one-JSON-per-line replies are handled.
- **Manifests by content, not by name.** A response that starts with `#EXTM3U` or contains `<MPD` is an HLS/DASH stream even if the URL has no `.m3u8`/`.mpd`.
- **Response headers (webRequest).** Video/audio found by content-type and size even when the URL is opaque. Segment-like requests
  (`.ts`, `.m4s`, `video/mp2t`, small pieces, and bursts of numbered files) are filtered out. Byte-range URLs (`bytestart=`/`byteend=`/`range=`)
  are normalised to the whole track and flagged *one track of a split stream: may have no sound*.
- **Page data.** `og:video`, JSON-LD `contentUrl`, and `<script type="application/json">` state blobs.
- **Blob videos.** MediaSource/SourceBuffer appends are recorded (duplicates from seeking are dropped; a change of quality starts a
  new part, saved as `name.part1.mp4`, `name.part2.mp4`). Complete video `Blob`s are captured as they are.

Ignored: `data:`/`javascript:` URLs, invalid URLs, and image URLs. A `blob:` URL is never fetched itself; blob videos are captured from the player instead. Duplicates (same URL ignoring `#fragment`) appear once per tab,
up to 200 per tab. Filenames: `download=` hint, then the URL name, then the page title when the URL name is generic
(`index`, `master`, numbers...), then the hostname.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | MV3 manifest (permissions: `downloads`, `storage`, `webRequest`) |
| `content.js` | Finds media URLs and reports them to the background worker; draws the corner icon on videos (Part 6) and handles its clicks |
| `background.js` | Validates, classifies (file / HLS / DASH), dedupes, names files, stores per-tab list, badge; performs the corner icon's downloads and reports failures back to it |
| `popup/` | Popup UI: list, quality picker, Download, Copy URL, Remove, Refresh, Clear |
| `lib/sniff.js` | Pure detection helpers: manifest/mime sniffing, JSON video finder, response judging, byte/range helpers (shared by every part) |
| `lib/mux.js` | Pure-JS MP4 merger: video-only + audio-only MP4 -> one MP4 (fragmented or plain), fragment re-ordering, slicing by time. No re-encoding |
| `lib/webm.js` | Pure-JS WebM merger (Part 7): video-only + audio-only WebM -> one WebM, also when the video was recorded in several qualities. No re-encoding |
| `lib/towebm.js` | Instagram/Facebook (v0.7.1): MP4 (VP9/AV1, progressive or fragmented) + AAC M4A -> one WebM. Picture frames are copied; sound is decoded with `decodeAudioData` and encoded to Opus with WebCodecs `AudioEncoder`. Refuses H.264/HEVC |
| `inject.js` | Runs in the page itself (`world: MAIN`): fetch/XHR hooks, MediaSource capture, loading the missing parts, merge + in-page save |
| `lib/stream.js` | HLS/DASH parsers, quality selection, segment downloader, error classes (also used by tests) |
| `downloader/` | Tab page that runs one stream download, shows progress, saves the result |
| `tests/` | `smoke-test.js` (mocked browser APIs), `stream-test.js` (local HTTP server), `capture-test.js` (Part 4+), `mux-test.js`, `downloader-test.js`, `merge-test.js` (Part 7), `overlay-test.js` (real Chromium), `fixtures/` |
| `package.json` | Only for the optional browser test (`playwright`, dev dependency) and `npm test` |


## How stream downloads work

- **HLS:** master playlist, then the chosen variant, then segments fetched (4 in parallel, 2 retries on network/5xx errors)
  and written **in playlist order**. `EXT-X-MAP` init segments and `BYTERANGE` are supported. MPEG-TS streams are saved as
  `.ts` (plays in VLC and most players); fMP4 streams as `.mp4`. A separate audio rendition (`EXT-X-MEDIA ... URI`) is
  saved as a second file.
- **DASH:** static, single-period manifests with `SegmentTemplate` (number/time/timeline), `SegmentList`, or a single-file
  `BaseURL`. The chosen video quality and the best audio representation are **merged into one `name.mp4`**
  (if merging is impossible they are saved as `name.mp4` + `name.audio.m4a` and the tab explains why).
- **Nothing is transcoded.** Bytes are copied, so there is no quality loss and the extension has no FFmpeg dependency.

### Optional: FFmpeg (only to merge or convert)

FFmpeg is **not needed for merging any more** (see above). It is only used as a fallback when the extension cannot merge (e.g. HLS
with MPEG-TS video, or tracks of different containers) and for optional conversions. Install it yourself
(https://ffmpeg.org/download.html, or `winget install ffmpeg`, `brew install ffmpeg`, `apt install ffmpeg`). It is **not bundled**.
The download tab prints the exact command when it is useful:

    ffmpeg -i "name.mp4" -i "name.audio.m4a" -c copy "name_merged.mp4"     # merge video + audio
    ffmpeg -i "name.ts" -c copy "name.mp4"                                  # optional .ts -> .mp4

### What is refused (you get a message explaining why)

| Situation | Message gist |
|---|---|
| Encrypted HLS (`EXT-X-KEY` AES-128 / SAMPLE-AES), DASH `ContentProtection` / DRM | Encrypted/protected streams are not downloaded. Not bypassed. |
| Live streams (no `ENDLIST`, DASH `type="dynamic"`) | Only finished streams can be downloaded |
| Codecs outside H.264/H.265/VP8/VP9/AV1 video and AAC/Opus/AC-3/E-AC-3/FLAC/Vorbis/MP3 audio | Unsupported codec is named |
| HTTP 401 / 403 / 404 / 410 | Login required / refused or signed URL expired / segment N missing |
| Network failure, HTML page instead of manifest or segment, empty segment | Explained; nothing is saved as if it were video |
| Multi-period DASH, SegmentList byte ranges | Unsupported |
| Blob video that uses encrypted playback (EME/DRM: an `encrypted` event or MediaKeys attached) | Marked *Encrypted playback (DRM)*, Download disabled, nothing is captured |

## Known limitations

- **Corner icon:** it is drawn for `<video>` elements in the page or in iframes, not for videos inside shadow DOM, and not for `<audio>`.
  The icon picks the download from the video's own address: for a `blob:` video that is the capture of what the player loads (quality as the
  player chose it). If the popup also lists a *Stream* or *Video + audio* entry for the same video, that one can give better quality;
  the icon cannot tell which entry belongs to which video. Some players cover the video with their own layer; the icon is drawn above everything (highest z-index) but
  a few sites may still hide it behind full-screen player modes.

- No YouTube extraction, no DRM/login bypass, no decryption (AES-128 included).
- Part 3 was verified with Node tests against a local server. It was **not** run inside a real Chrome/Edge session here:
  the popup, the downloader tab and `chrome.downloads` saving are covered only by mocks. Please try a real stream.
- Segments are held in memory (as Blobs) before saving, so multi-GB videos may fail on low-memory machines.
- If any segment fails (e.g. one expired segment), the whole download fails rather than saving a partial file.
- Only HTML/text error pages are detected as bad segments; other garbage served with HTTP 200 is not.
- DASH: only the highest-bitrate audio track is saved; subtitles are ignored.
- The downloads API/fetch send your cookies but no Referer; hotlink-protected CDNs may refuse. This is reported, not bypassed.
- **Blob capture records what the player loads, and the extension now makes it load everything.** Limits: it works by seeking and
  playing the page's own video, so it needs a normal player that obeys `currentTime`/`play()` and a tab that is not in the background
  (browsers throttle hidden tabs). Players that ignore seeking, ad-insertion that swaps the video, and live streams (unknown length)
  are saved as captured (*Save as is* behaviour) with an explanation. The quality is whatever the player chose (often lower while it
  loads quickly); a *Stream* or *Video + audio* entry for the same video gives the best quality when one is listed.
- **Merging** needs video and audio in the same container (both MP4 or both WebM), one track each, no encryption. Different containers
  (MP4 video + WebM/Opus audio, which some YouTube combinations produce) are saved as two files with the reason, because joining them
  would need re-encoding or a format converter. Merged MP4 streams/captures are fragmented MP4.
- **Quality switches in MP4:** a version that put both qualities into one MP4 (two sample entries) was built and tested, but Chromium
  and ffmpeg both read plain `.mp4` files with a demuxer that ignores the change, so the second quality did not play. It was removed;
  MP4 parts are saved separately, each merged with its own audio. WebM does not have this problem (the size change is inside the VP9
  stream) and is verified by decoding.
- **YouTube:** only what the page loads as plain media can be sniffed from the network, and YouTube's newer streaming mode does not
  send plain files. The video capture (corner icon / popup *Capture* entry) does not depend on how the data arrives and is the path to use there.
  Not verified on youtube.com itself (no internet in the author's environment): the WebM/Opus/VP9 handling is verified with real
  files in Chromium. Signed or throttled googlevideo URLs may also refuse a plain download.
- Capture memory: at most 6 captured videos per page, 2 GB each; older ones are dropped.
- Not seen: requests made inside Web Workers/Service Workers are only found by the header sniffer when Chrome ties them to the tab;
  MediaSource inside a worker is not hooked; sites that run their player in a cross-origin iframe are captured per frame (works) but
  only if the extension runs there (it does for http/https frames).
- Detection of JSON fields is key-name based (a growing list). A site that renames its fields may need `lib/sniff.js` updated (`URL_KEYS` / `LIST_KEYS`).
- Parts 4 and 5 were verified with Node tests (real fMP4 captured through a *simulated* player and merged files decoded with ffprobe/ffmpeg),
  **not** in a real Chrome/Edge session. Real players differ from the simulation; treat auto-complete in particular as needing a real-world check.
- Media inside shadow DOM is only found if it also shows up in network timings.
- Extensionless audio files without a MIME type are saved as `.mp3`, which may be wrong for some formats.
- Pages open before installing/reloading the extension need a reload first.
