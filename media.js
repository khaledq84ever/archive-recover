// Media helpers: thumbnail generation + duration probing, with a small
// on-disk cache so the gallery loads fast and we don't re-probe 100+ files
// on every request.
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const THUMB_DIRNAME = ".thumbs";
const META_FILE = ".meta.json";

function key(file) {
  return crypto.createHash("sha1").update(file).digest("hex").slice(0, 16);
}

function loadMeta(root) {
  const p = path.join(root, META_FILE);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}
function saveMeta(root, meta) {
  try {
    writeFileSync(path.join(root, META_FILE), JSON.stringify(meta));
  } catch {}
}

// Probe a video's duration (seconds), cached by file+size+mtime.
export function getDuration(root, file) {
  return new Promise((resolve) => {
    const full = path.join(root, file);
    if (!existsSync(full)) return resolve(null);
    const st = statSync(full);
    const meta = loadMeta(root);
    const k = key(file);
    const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (meta[k] && meta[k].stamp === stamp && meta[k].dur != null) {
      return resolve(meta[k].dur);
    }
    const p = spawn("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      full,
    ]);
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("error", () => resolve(null));
    p.on("close", () => {
      const dur = parseFloat(out.trim());
      const v = Number.isFinite(dur) ? Math.round(dur) : null;
      meta[k] = { stamp, dur: v };
      saveMeta(root, meta);
      resolve(v);
    });
  });
}

// Return the path to a cached thumbnail JPEG, generating it if missing.
// Captures a frame ~12% into the video (avoids black intros).
export function getThumb(root, file) {
  return new Promise((resolve) => {
    const full = path.join(root, file);
    if (!existsSync(full)) return resolve(null);
    const dir = path.join(root, THUMB_DIRNAME);
    mkdirSync(dir, { recursive: true });
    const thumb = path.join(dir, key(file) + ".jpg");
    if (existsSync(thumb) && statSync(thumb).size > 0) return resolve(thumb);

    const gen = (seekSec) => {
      const p = spawn("ffmpeg", [
        "-ss",
        String(seekSec),
        "-i",
        full,
        "-frames:v",
        "1",
        "-vf",
        "scale=480:-2",
        "-q:v",
        "4",
        "-y",
        thumb,
      ]);
      p.on("error", () => resolve(null));
      p.on("close", () => {
        if (existsSync(thumb) && statSync(thumb).size > 0) resolve(thumb);
        else if (seekSec > 0)
          gen(0); // very short clip: retry at the first frame
        else resolve(null);
      });
    };
    // seek to a small offset; fall back to 0 for tiny clips
    gen(5);
  });
}
