// Web server for the Internet-Archive YouTube recovery bot.
// Exposes a small UI + API to start recovery jobs, watch live progress,
// and download recovered video files.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync, createReadStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { parseTarget, runJob, listRecovered } from "./recover.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
// Reuse the existing recovery folder so the 100+ already-recovered videos
// show up immediately; new jobs can target their own subfolders.
const DATA_ROOT = process.env.DATA_ROOT || "/home/khaled/recovered_videos";

const app = express();
app.use(express.json());
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

// List recovered files (optionally within a job's subfolder)
app.get("/api/files", (req, res) => {
  const sub = req.query.dir ? path.basename(String(req.query.dir)) : "";
  const dir = sub ? path.join(DATA_ROOT, sub) : DATA_ROOT;
  res.json(listRecovered(dir));
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
