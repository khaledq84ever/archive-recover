# Archive Recover

Web UI to recover deleted YouTube videos from the **Internet Archive (Wayback Machine)** via `yt-dlp`.

Enter a channel, `@handle`, username, video URL, or 11-char video ID — it discovers archived
uploads from the Wayback CDX index and downloads the best-quality stream the archive holds,
with live progress and one-click downloads.

## Run
```bash
npm install
PORT=3000 node server.js
# open http://localhost:3000
```

## Stack
- Node.js + Express, Server-Sent Events for live job progress
- `yt-dlp` for recovery (multi-URL fallback, best quality)
- Engine ported from the original `auto_recover.sh` / `retry_alt.sh`

## Requirements
`yt-dlp` and `ffmpeg` must be installed on the host.
