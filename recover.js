// Recovery engine: discovers archived YouTube video IDs from the Internet
// Archive (Wayback CDX) and pulls the best-quality stream the archive holds
// via yt-dlp. Ported from the proven auto_recover.sh / retry_alt.sh logic.
import { spawn } from "node:child_process";
import { mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import https from "node:https";

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// ---- small fetch helper that rides out the archive's 503/504 overloads ----
function fetchText(url, { timeout = 90000, retries = 6 } = {}) {
  return new Promise((resolve) => {
    let attempt = 0;
    const go = () => {
      attempt++;
      const req = https.get(
        url,
        { timeout, headers: { "User-Agent": "archive-recover/1.0" } },
        (res) => {
          // follow redirects
          if (
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            return resolve(
              fetchText(new URL(res.headers.location, url).href, {
                timeout,
                retries: retries - 1,
              }),
            );
          }
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (data += c));
          res.on("end", () => {
            if (
              /503 Service Unavailable|504 Gateway|No server is available/.test(
                data,
              ) &&
              attempt <= retries
            ) {
              return setTimeout(go, 8000 * attempt);
            }
            resolve(data);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () =>
        attempt <= retries ? setTimeout(go, 8000 * attempt) : resolve(""),
      );
    };
    go();
  });
}

// Parse a user input into a discovery plan: a channel, or a single video id.
export function parseTarget(raw) {
  const s = (raw || "").trim();
  if (!s) return null;

  // direct 11-char id
  if (ID_RE.test(s)) return { kind: "video", id: s, label: s };

  // watch / youtu.be url -> single video
  const vm =
    s.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (vm) return { kind: "video", id: vm[1], label: vm[1] };

  // channel by /channel/UC...
  const cm = s.match(/channel\/(UC[A-Za-z0-9_-]{20,})/);
  if (cm) return { kind: "channel", channelId: cm[1], label: cm[1] };

  // legacy /user/NAME or /@handle or bare username
  const um = s.match(/(?:\/user\/|\/@|^@)([A-Za-z0-9._-]+)/);
  if (um) return { kind: "user", user: um[1], label: um[1] };

  // bare word -> treat as legacy username
  if (/^[A-Za-z0-9._-]+$/.test(s)) return { kind: "user", user: s, label: s };

  return null;
}

// Build the CDX url-prefixes to enumerate archived snapshots for a target.
function cdxPrefixes(target) {
  if (target.kind === "user") {
    return [`youtube.com/user/${target.user}*`];
  }
  if (target.kind === "channel") {
    const uploads = "UU" + target.channelId.slice(2);
    return [
      `youtube.com/channel/${target.channelId}*`,
      `youtube.com/playlist?list=${uploads}*`,
    ];
  }
  return [];
}

// Discover candidate video ids for a channel/user from archived pages.
async function discover(target, job) {
  const snaps = new Set();
  for (const base of cdxPrefixes(target)) {
    job.log(`discovering snapshots: ${base}`);
    const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(base)}&output=text&fl=original,timestamp&collapse=digest&limit=4000`;
    const text = await fetchText(url);
    for (const line of text.split("\n")) {
      const [orig, ts] = line.split(/\s+/);
      if (orig && ts) snaps.add(`https://web.archive.org/web/${ts}id_/${orig}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  job.log(`scraping ${snaps.size} archived snapshots for video ids`);

  const freq = new Map(); // id -> count (frequency = priority signal)
  const list = [...snaps];
  const CONC = 5;
  let idx = 0;
  async function worker() {
    while (idx < list.length && !job.cancelled) {
      const snapUrl = list[idx++];
      const html = await fetchText(snapUrl, { timeout: 30000, retries: 1 });
      const matches = html.match(/watch\?v=[A-Za-z0-9_-]{11}/g) || [];
      for (const m of matches) {
        const id = m.slice(8);
        freq.set(id, (freq.get(id) || 0) + 1);
      }
      job.discovered = freq.size;
      job.emit();
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // most-frequent first: a creator's real uploads recur across many pages.
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

// Try to recover one id, trying several archive URL forms (best quality).
function attempt(id, outDir) {
  const urls = [
    `https://web.archive.org/web/2oe_/http://wayback-fakeurl.archive.org/yt/${id}`,
    `https://web.archive.org/web/2/https://www.youtube.com/watch?v=${id}`,
    `https://web.archive.org/web/2/https://youtu.be/${id}`,
    `https://www.youtube.com/watch?v=${id}`,
  ];
  return new Promise(async (resolve) => {
    // already on disk?
    if (fileForId(outDir, id)) return resolve({ ok: true, already: true });
    for (const u of urls) {
      const ok = await runYtDlp(u, outDir);
      if (ok && fileForId(outDir, id)) return resolve({ ok: true });
    }
    resolve({ ok: false });
  });
}

function runYtDlp(url, outDir) {
  return new Promise((resolve) => {
    const p = spawn(
      "yt-dlp",
      [
        "--ignore-config",
        "--no-warnings",
        "--no-progress",
        "--no-overwrites",
        "--retries",
        "5",
        "--fragment-retries",
        "5",
        "--socket-timeout",
        "30",
        "-f",
        "bestvideo+bestaudio/best",
        "-o",
        "%(title)s [%(id)s].%(ext)s",
        "--restrict-filenames",
        url,
      ],
      { cwd: outDir },
    );
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    p.on("error", () => finish(false));
    p.on("close", (code) => finish(code === 0));
  });
}

function fileForId(dir, id) {
  if (!existsSync(dir)) return null;
  const tag = `[${id}]`;
  return readdirSync(dir).find((f) => f.includes(tag)) || null;
}

export function listRecovered(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(mp4|webm|mkv|m4a|mp3)$/i.test(f))
    .map((f) => {
      const st = statSync(path.join(dir, f));
      const idm = f.match(/\[([A-Za-z0-9_-]{11})\]/);
      return {
        file: f,
        id: idm ? idm[1] : null,
        size: st.size,
        mtime: st.mtimeMs,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// Run a full job (discover if needed, then recover everything).
export async function runJob(job) {
  mkdirSync(job.outDir, { recursive: true });
  job.status = "discovering";
  job.emit();

  let ids;
  if (job.target.kind === "video") {
    ids = [job.target.id];
  } else {
    ids = await discover(job.target, job);
  }
  job.candidates = ids;
  job.total = ids.length;
  job.status = "recovering";
  job.log(`recovering ${ids.length} candidate video(s) at best quality`);
  job.emit();

  const CONC = 3;
  let idx = 0;
  async function worker() {
    while (idx < ids.length && !job.cancelled) {
      const id = ids[idx++];
      job.attempted++;
      const r = await attempt(id, job.outDir);
      if (r.ok) {
        job.recovered.add(id);
        job.log(`recovered ✅ ${id}${r.already ? " (already had)" : ""}`);
      } else {
        job.failed.add(id);
      }
      job.emit();
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  job.status = job.cancelled ? "cancelled" : "done";
  job.log(
    `finished: ${job.recovered.size} recovered, ${job.failed.size} unrecoverable`,
  );
  job.emit();
}
