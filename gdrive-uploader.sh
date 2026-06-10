#!/usr/bin/env bash
# Continuously mirror every grabbed video to Google Drive.
# Watches the recovery output dir and uploads any new finished video
# (.mp4 / .webm) to a dedicated Drive folder. rclone copy is idempotent,
# so already-uploaded files are skipped; only newly grabbed videos go up.
# Incomplete downloads (*.part) are ignored until they finish.

set -u

SRC="${DATA_ROOT:-/home/khaled/recovered_videos}"
DEST="gdrive:Recovered Videos"
INTERVAL="${UPLOAD_INTERVAL:-30}"   # seconds between scans

echo "[gdrive-uploader] watching $SRC -> $DEST (every ${INTERVAL}s)"

while true; do
  rclone copy "$SRC" "$DEST" \
    --include "*.mp4" \
    --include "*.webm" \
    --transfers 4 \
    --drive-chunk-size 64M \
    --no-traverse \
    --log-level INFO \
    2>&1 | grep -iE "copied|uploaded|error" || true
  sleep "$INTERVAL"
done
