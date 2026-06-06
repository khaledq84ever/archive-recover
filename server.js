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

// Download a recovered file
app.get("/download", (req, res) => {
  const sub = req.query.dir ? path.basename(String(req.query.dir)) : "";
  const file = path.basename(String(req.query.file || ""));
  const full = path.join(sub ? path.join(DATA_ROOT, sub) : DATA_ROOT, file);
  if (!existsSync(full) || !statSync(full).isFile())
    return res.status(404).send("not found");
  res.download(full);
});

app.listen(PORT, () => {
  console.log(`archive-recover web UI on http://localhost:${PORT}`);
  console.log(`serving recovered files from: ${DATA_ROOT}`);
});
