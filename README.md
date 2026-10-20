<div align="center">

<img src="docs/icon.png" width="112" alt="Streamlift logo">

# Streamlift

**Find any video on a page and lift it off in one click.**

A free, open-source Chrome and Edge extension that detects video and audio, including HLS/DASH streams and hidden `blob:` players, and saves picture and sound together as a single file.

![Manifest V3](https://img.shields.io/badge/Manifest-V3-4f5bff) ![Chrome](https://img.shields.io/badge/Chrome-111%2B-brightgreen) ![Edge](https://img.shields.io/badge/Edge-supported-0078d4) ![License](https://img.shields.io/badge/license-MIT-blue) ![No build step](https://img.shields.io/badge/build-none-lightgrey)

Built by **[Prasun Tripathi](https://github.com/tripathiprasun)**

</div>

---

## Features

- **One-click download button on the video.** A small icon appears in the corner of every video; click it to save that video. A toolbar popup lists everything found on the page.
- **Finds media that other tools miss.** Direct files, HLS (`.m3u8`) and MPEG-DASH (`.mpd`) streams, API responses, `og:video` and JSON-LD data, and `blob:` videos played through MediaSource.
- **Picture and sound in one file.** Sites send video and audio separately. Streamlift merges them itself, with no re-encoding and no FFmpeg. Output is `.mp4`, or `.webm` where that plays more smoothly (YouTube-style VP9/Opus, Instagram/Facebook).
- **Quality picker** for streams, with segment progress and cancel.
- **Fast and light.** Plain JavaScript, no build step, no external services. Nothing leaves your browser except requests to the video's own server.
- **Honest errors.** Expired links, login-only media and encrypted streams get a clear message instead of a broken file.
- **Dark and light popup** that follows your system theme.

## Install

Streamlift is not on the Chrome Web Store, so load it as an unpacked extension:

1. Download this repository (**Code, Download ZIP**) or run `git clone https://github.com/tripathiprasun/streamlift.git`, and unzip it.
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and choose the folder that contains `manifest.json`.
5. Pin Streamlift to the toolbar, open a page with a video, and click the icon.

Requires Chrome or Edge **111** or newer. Pages that were already open need a reload once.

## How to use

| You want to... | Do this |
|---|---|
| Save the video you are watching | Hover the video and click the round download icon in its top-left corner |
| Choose a quality or see everything on the page | Click the Streamlift toolbar icon, pick an entry, press **Download** |
| Save only what the player has already loaded | Use **Save as is** on a captured entry |
| Hide the on-video icon | Turn off **Show a download icon on videos** in the popup |

## What it will not do

Streamlift does not bypass DRM, logins, paywalls or encryption. Encrypted HLS/DASH and DRM-protected players are refused with an explanation. Live streams are not supported. Please download only content you have the right to save, and respect the terms of the sites you use.

## Privacy

No analytics, no tracking, no accounts. The extension reads pages and network response headers only to find media, and fetches video only from the server that hosts it.

## Development

```bash
npm test              # Node 18+, no dependencies: parsers, muxers, downloader, capture logic
npm install           # only needed for the browser tests
npx playwright install chromium
npm run test:browser  # loads the extension in real Chromium
```

There is no build step: edit the files and press reload on `chrome://extensions`.

```
manifest.json     MV3 manifest
background.js     service worker: detection, naming, downloads
content.js        page scanner and the on-video icon
inject.js         page-world hooks: fetch/XHR, MediaSource capture
popup/            toolbar popup
downloader/       tab that runs stream downloads
lib/              HLS/DASH parsing, MP4 and WebM muxers, sniffers
tests/            Node and Playwright tests with small generated fixtures
docs/TECHNICAL.md full technical notes, supported formats, limitations
```

Detailed behaviour, refusal rules and known limitations are in [docs/TECHNICAL.md](docs/TECHNICAL.md). Some paths there were verified with Node tests and simulated players rather than on every real website, so results can vary by site.

## About the author

Streamlift was designed and built by **Prasun Tripathi** ([@tripathiprasun](https://github.com/tripathiprasun)). Issues and pull requests are welcome.

## License

[MIT](LICENSE) © 2026 Prasun Tripathi
