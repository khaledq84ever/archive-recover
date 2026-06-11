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

// In-memory meta cache per root. /api/files probes 100+ files concurrently;
// the old read-modify-write of .meta.json per call meant each writer clobbered
// the others (last write wins), so the cache barely persisted and every load
// re-probed everything. Sharing one object and debouncing the write fixes both.
const _meta = new Map(); // root -> { data, timer }

function metaFor(root) {
  let e = _meta.get(root);
  if (!e) {
    let data = {};
    try {
      data = JSON.parse(readFileSync(path.join(root, META_FILE), "utf8"));
    } catch {}
    e = { data, timer: null };
    _meta.set(root, e);
  }
  return e;
}

function persistMeta(root) {
  const e = _meta.get(root);
  if (!e || e.timer) return; // a write is already scheduled; it'll include us
  e.timer = setTimeout(() => {
    e.timer = null;
    try {
      writeFileSync(path.join(root, META_FILE), JSON.stringify(e.data));
    } catch {}
  }, 500);
}

// Probe a video's duration (seconds), cached by file+size+mtime.
export function getDuration(root, file) {
  return new Promise((resolve) => {
    const full = path.join(root, file);
    if (!existsSync(full)) return resolve(null);
    const st = statSync(full);
    const e = metaFor(root);
    const k = key(file);
    const stamp = `${st.size}:${Math.round(st.mtimeMs)}`;
    if (e.data[k] && e.data[k].stamp === stamp && e.data[k].dur != null) {
      return resolve(e.data[k].dur);
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
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    // ffprobe can hang on a truncated/partial file (e.g. a cancelled .part);
    // /api/files awaits this inside a bounded pool, so a hang would stall a
    // worker and eventually freeze the gallery load. Kill it and move on.
    const timer = setTimeout(() => {
      p.kill("SIGKILL");
      finish(null);
    }, 15000);
    p.stdout.on("data", (c) => (out += c));
    p.on("error", () => finish(null));
    p.on("close", () => {
      const dur = parseFloat(out.trim());
      const v = Number.isFinite(dur) ? Math.round(dur) : null;
      e.data[k] = { stamp, dur: v };
      persistMeta(root);
      finish(v);
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

    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
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
      // Bound it: a partial/corrupt file can make ffmpeg spin instead of exit.
      const timer = setTimeout(() => {
        p.kill("SIGKILL");
        done(null);
      }, 20000);
      p.on("error", () => {
        clearTimeout(timer);
        done(null);
      });
      p.on("close", () => {
        clearTimeout(timer);
        if (settled) return; // timed out and was killed
        if (existsSync(thumb) && statSync(thumb).size > 0) done(thumb);
        else if (seekSec > 0)
          gen(0); // very short clip: retry at the first frame
        else done(null);
      });
    };
    // seek to a small offset; fall back to 0 for tiny clips
    gen(5);
  });
}
