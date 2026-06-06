// Web server for the Internet-Archive YouTube recovery bot.
// Exposes a small UI + API to start recovery jobs, watch live progress,
// and download recovered video files.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  statSync,
  createReadStream,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { parseTarget, runJob, listRecovered } from "./recover.js";
import { getThumb, getDuration } from "./media.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// Reuse the existing recovery folder so the 100+ already-recovered videos
// show up immediately; new jobs can target their own subfolders.
const DATA_ROOT = process.env.DATA_ROOT || "/home/khaled/recovered_videos";

// Load a local .env (gitignored) so the password never lands in the repo.
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch {}

const app = express();
app.use(express.json({ limit: "8mb" }));

// Where the YouTube cookies file lives (used to beat the bot-wall on this IP).
const COOKIES_PATH = path.join(DATA_ROOT, "cookies.txt");

// ---- Optional password gate --------------------------------------------
// If ACCESS_PASSWORD is set the whole site requires login; otherwise it's
// open (backwards compatible). The cookie holds a salted hash, not the pw.
const PASSWORD = process.env.ACCESS_PASSWORD || "";
const AUTH_TOKEN = PASSWORD
  ? createHash("sha256")
      .update("archive-recover:" + PASSWORD)
      .digest("hex")
  : "";

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > -1)
      out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.post("/api/login", (req, res) => {
  if (!PASSWORD) return res.json({ ok: true });
  if (req.body?.password === PASSWORD) {
    res.setHeader(
      "Set-Cookie",
      `ar_auth=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`,
    );
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false, error: "Wrong password" });
});
app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "ar_auth=; HttpOnly; Path=/; Max-Age=0");
  res.redirect("/login");
});

// Gate everything else when a password is configured.
app.use((req, res, next) => {
  if (!PASSWORD) return next();
  if (req.path === "/login" || req.path === "/api/login") return next();
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.ar_auth === AUTH_TOKEN) return next();
  if (req.path.startsWith("/api/"))
    return res.status(401).json({ error: "auth required" });
  return res.redirect("/login");
});

app.use(express.static(path.join(__dirname, "public")));

/** @type {Map<string, any>} */
const jobs = new Map();
const sseClients = new Set();

function snapshot(job) {
  return {
    id: job.id,
    label: job.target.label,
    kind: job.target.kind,
    status: job.status,
    discovered: job.discovered,
    total: job.total,
    attempted: job.attempted,
    recovered: job.recovered.size,
    newCount: job.newCount || 0,
    alreadyHave: job.alreadyHave || 0,
    failed: job.failed.size,
    outDir: path.basename(job.outDir),
    logs: job.logs.slice(-40),
    startedAt: job.startedAt,
  };
}

function broadcast(job) {
  const payload = `data: ${JSON.stringify(snapshot(job))}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ---- API ----------------------------------------------------------------
app.post("/api/recover", (req, res) => {
  const target = parseTarget(req.body?.target);
  if (!target)
    return res.status(400).json({
      error:
        "Enter a YouTube channel, username, video URL, or 11-char video ID.",
    });

  const id = randomUUID().slice(0, 8);
  const outDir = req.body?.reuse
    ? DATA_ROOT
    : path.join(
        DATA_ROOT,
        `${target.label}-${id}`.replace(/[^A-Za-z0-9._-]/g, "_"),
      );

  const job = {
    id,
    target,
    outDir,
    status: "queued",
    discovered: 0,
    total: 0,
    attempted: 0,
    newCount: 0,
    alreadyHave: 0,
    candidates: [],
    recovered: new Set(),
    failed: new Set(),
    logs: [],
    cancelled: false,
    startedAt: Date.now(),
    log(m) {
      this.logs.push(`[${new Date().toLocaleTimeString()}] ${m}`);
      broadcast(this);
    },
    emit() {
      broadcast(this);
    },
  };
  jobs.set(id, job);
  runJob(job).catch((e) => {
    job.status = "error";
    job.log("error: " + e.message);
  });
  res.json(snapshot(job));
});

// ---- Live-channel grab (needs YouTube cookies) --------------------------
// The current channel's new uploads aren't on the Wayback Machine and this
// VPS IP is bot-walled by YouTube, so downloading them needs a cookies file.
// These endpoints let the user paste/upload cookies from the browser and
// kick off the grab — no terminal/scp needed.

app.get("/api/cookies/status", (_req, res) => {
  try {
    const txt = readFileSync(COOKIES_PATH, "utf8");
    const lines = txt
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#")).length;
    res.json({
      present: txt.trim().length > 0,
      lines,
      youtube: /youtube\.com/i.test(txt),
      mtime: statSync(COOKIES_PATH).mtimeMs,
    });
  } catch {
    res.json({ present: false, lines: 0, youtube: false, mtime: null });
  }
});

app.post("/api/cookies", (req, res) => {
  const txt = String(req.body?.cookies || "");
  // Netscape cookies.txt is tab-separated and must contain youtube.com rows.
  if (!/youtube\.com/i.test(txt) || !/\t/.test(txt)) {
    return res.status(400).json({
      error:
        "That doesn't look like a YouTube cookies.txt. Export it with the 'Get cookies.txt LOCALLY' extension while on youtube.com (Netscape format).",
    });
  }
  try {
    writeFileSync(COOKIES_PATH, txt.endsWith("\n") ? txt : txt + "\n", {
      mode: 0o600,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  res.json({ ok: true, bytes: txt.length });
});

let grabJob = null;
app.post("/api/grab-live", (req, res) => {
  if (grabJob && grabJob.status === "running")
    return res
      .status(409)
      .json({ error: "A grab is already running.", id: grabJob.id });
  if (!existsSync(COOKIES_PATH) || !statSync(COOKIES_PATH).size)
    return res
      .status(400)
      .json({ error: "Upload your YouTube cookies first (button above)." });

  const which =
    req.body?.what === "reuploads" ? "grab_reuploads.sh" : "grab_live.sh";
  const script = path.join(DATA_ROOT, which);
  if (!existsSync(script))
    return res.status(404).json({ error: `${which} not found on server.` });

  const id = randomUUID().slice(0, 8);
  const job = {
    id,
    target: { label: which.replace(".sh", ""), kind: "grab" },
    outDir: DATA_ROOT,
    status: "running",
    discovered: 0,
    total: 0,
    attempted: 0,
    newCount: 0,
    alreadyHave: 0,
    recovered: new Set(),
    failed: new Set(),
    logs: [],
    cancelled: false,
    startedAt: Date.now(),
    log(m) {
      this.logs.push(`[${new Date().toLocaleTimeString()}] ${m}`);
      broadcast(this);
    },
  };
  jobs.set(id, job);
  grabJob = job;
  job.log(`starting ${which} — downloading new videos at original quality…`);

  const child = spawn("bash", [script], { cwd: DATA_ROOT });
  const onData = (buf) =>
    String(buf)
      .split("\n")
      .forEach((l) => {
        const t = l.trim();
        if (!t) return;
        job.log(t);
        if (/\[download\] Destination|Merging formats/.test(t)) {
          job.attempted++;
          job.newCount++;
        }
        if (/has already been recorded in the archive/.test(t))
          job.alreadyHave++;
      });
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => {
    job.status = code === 0 ? "done" : "error";
    job.log(
      `grab finished (exit ${code}). new videos this run: ${job.newCount}`,
    );
    broadcast(job);
  });
  res.json(snapshot(job));
});

app.get("/api/jobs", (_req, res) => {
  res.json([...jobs.values()].map(snapshot));
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  res.json(snapshot(job));
});

app.post("/api/jobs/:id/cancel", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: "not found" });
  job.cancelled = true;
  job.log("cancel requested");
  res.json(snapshot(job));
});

// Live progress stream
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.flushHeaders();
  res.write(": connected\n\n");
  sseClients.add(res);
  for (const job of jobs.values())
    res.write(`data: ${JSON.stringify(snapshot(job))}\n\n`);
  req.on("close", () => sseClients.delete(res));
});

// Turn an ugly recovery filename into a clean display title.
function prettyTitle(file) {
  return (
    file
      .replace(/\.[^.]+$/, "") // drop extension
      .replace(/\s*\[[A-Za-z0-9_-]{11}\]\s*$/, "") // drop trailing [id]
      .replace(/^web\.archive-youtube_video_[A-Za-z0-9_-]+$/, "Untitled video")
      .replace(/^web\.archive-youtube_video_/, "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim() || "Untitled video"
  );
}

// List recovered files (optionally within a job's subfolder), enriched with
// a clean title and (cached) duration.
app.get("/api/files", async (req, res) => {
  const sub = req.query.dir ? path.basename(String(req.query.dir)) : "";
  const dir = sub ? path.join(DATA_ROOT, sub) : DATA_ROOT;
  const files = listRecovered(dir);
  const out = await Promise.all(
    files.map(async (f) => ({
      ...f,
      title: prettyTitle(f.file),
      ext: (f.file.split(".").pop() || "").toLowerCase(),
      duration: await getDuration(dir, f.file),
    })),
  );
  res.json(out);
});

// Thumbnail JPEG for a video (generated + cached on first request)
app.get("/thumb", async (req, res) => {
  const sub = req.query.dir ? path.basename(String(req.query.dir)) : "";
  const dir = sub ? path.join(DATA_ROOT, sub) : DATA_ROOT;
  const file = path.basename(String(req.query.file || ""));
  const thumb = await getThumb(dir, file);
  if (!thumb) return res.status(404).send("no thumb");
  res.set("Cache-Control", "public, max-age=86400");
  res.sendFile(thumb);
});

// Resolve a request's file param to a real, existing path inside DATA_ROOT.
function resolveFile(req) {
  const sub = req.query.dir ? path.basename(String(req.query.dir)) : "";
  const file = path.basename(String(req.query.file || ""));
  const full = path.join(sub ? path.join(DATA_ROOT, sub) : DATA_ROOT, file);
  if (!existsSync(full) || !statSync(full).isFile()) return null;
  return full;
}

const MIME = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
};

// Download a recovered file (forces save dialog)
app.get("/download", (req, res) => {
  const full = resolveFile(req);
  if (!full) return res.status(404).send("not found");
  res.download(full);
});

// Stream a recovered file for in-browser playback, with HTTP Range support
// so the <video> player can seek and start instantly.
app.get("/stream", (req, res) => {
  const full = resolveFile(req);
  if (!full) return res.status(404).send("not found");
  const size = statSync(full).size;
  const type =
    MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? parseInt(m[1], 10) : 0;
    const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
    if (start >= size || end >= size) {
      res.status(416).set("Content-Range", `bytes */${size}`).end();
      return;
    }
    res.status(206).set({
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": type,
    });
    createReadStream(full, { start, end }).pipe(res);
  } else {
    res.set({
      "Content-Length": size,
      "Content-Type": type,
      "Accept-Ranges": "bytes",
    });
    createReadStream(full).pipe(res);
  }
});

app.listen(PORT, () => {
  console.log(`archive-recover web UI on http://localhost:${PORT}`);
  console.log(`serving recovered files from: ${DATA_ROOT}`);
});
