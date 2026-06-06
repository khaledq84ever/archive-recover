# 🎞️ Archive Recover

A self-hosted web app that **recovers deleted YouTube videos from the Internet Archive (Wayback Machine)** and turns them into a clean, modern, browsable video library — watch any recovered clip right in your browser or download the original file.

Built on top of the proven `yt-dlp` + Wayback CDX recovery pipeline.

---

## ✨ Features

- **Recover by anything** — paste a channel, `@handle`, legacy username, video URL, or 11‑char video ID. It discovers every archived upload it can find and pulls the **best‑quality** stream the archive holds.
- **Modern video gallery** — responsive thumbnail grid with auto‑generated posters, clean titles, durations, and file sizes.
- **Watch in‑browser** — built‑in player with HTTP range streaming (instant start + seek) and **auto play‑next** through the library.
- **Instant search** — filter the whole library by title as you type.
- **Live recovery** — start a job and watch real‑time progress (discovered / tried / recovered) over Server‑Sent Events.
- **One‑click download** of any original file.

## 🚀 Quick start

```bash
npm install
PORT=3000 node server.js
# open http://localhost:3000
```

Recovered videos are read from `DATA_ROOT` (defaults to `/home/khaled/recovered_videos`).
Override it:

```bash
DATA_ROOT=/path/to/videos PORT=3000 node server.js
```

### Run it for real (pm2 + public HTTPS)

```bash
pm2 start ecosystem.config.cjs   # web app + cloudflare tunnel
pm2 save
```

The included `ecosystem.config.cjs` runs the app **and** a Cloudflare quick tunnel
(`cloudflared`) so it gets a public `https://…trycloudflare.com` URL.

## 🧱 Stack

- **Node.js + Express** — API, range streaming, SSE live progress
- **yt-dlp** — recovery engine (multi‑URL fallback, best quality), ported from `auto_recover.sh` / `retry_alt.sh`
- **ffmpeg / ffprobe** — thumbnail generation + duration probing (cached on disk)
- **Vanilla JS frontend** — no build step, single `public/index.html`

## 📦 API

| Route | Purpose |
|-------|---------|
| `POST /api/recover` | Start a recovery job (`{ target, reuse }`) |
| `GET /api/files` | Library list (title, duration, size, ext) |
| `GET /api/stream` | SSE live job progress |
| `GET /thumb?file=` | Cached JPEG thumbnail |
| `GET /stream?file=` | Range‑enabled video stream (in‑browser playback) |
| `GET /download?file=` | Download original file |

## ⚙️ Requirements

`yt-dlp`, `ffmpeg`, and `ffprobe` must be installed on the host.

---

> Restored via the Wayback Machine. Quality is capped by whatever the archive captured —
> typically 720p/1080p where the original stream was archived.
