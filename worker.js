// Non-stop deep discovery + recovery daemon for the deleted channel.
// 1) Scrapes ALL archived channel/user/playlist snapshots (not just the
//    user page) to find as many of the original video IDs as possible.
// 2) Recovers every ID that's NOT already on disk, best quality, multi-URL.
// 3) Loops forever: re-discovers + retries the missing, with backoff.
// Designed to run under pm2 so it survives reboots and keeps going 24/7.
import { spawn } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import path from "node:path";
import https from "node:https";

const DIR = process.env.DATA_ROOT || "/home/khaled/recovered_videos";
const CH_USER = "KhaleDQ84EveR";
const CH_ID = "UCWwBnixYIgM0T9zjpLfh9Tw";
const UPLOADS = "UUWwBnixYIgM0T9zjpLfh9Tw";
const ID_RE = /[A-Za-z0-9_-]{11}/;

const CAND = path.join(DIR, "candidates.txt"); // shared with the web app
const CAND_FULL = path.join(DIR, "candidates_full.txt"); // everything we ever found
const TITLES = path.join(DIR, "titles.tsv"); // id <tab> title (best effort)
const LOG = path.join(DIR, "deep_recover.log");
const STATUS = path.join(DIR, "deep_status.json");

const log = (m) => {
  const line = `[${new Date().toISOString()}] ${m}\n`;
  process.stdout.write(line);
  try {
    appendFileSync(LOG, line);
  } catch {}
};

function readSet(file) {
  const s = new Set();
  if (existsSync(file))
    for (const l of readFileSync(file, "utf8").split("\n")) {
      const id = l.trim();
      if (id.length === 11) s.add(id);
    }
  return s;
}
function writeSet(file, set) {
  try {
    writeFileSync(file, [...set].sort().join("\n") + "\n");
  } catch {}
}

// IDs already recovered to disk (so we never download twice).
function idsOnDisk() {
  const s = new Set();
  for (const f of readdirSync(DIR)) {
    const m = f.match(/\[([A-Za-z0-9_-]{11})\]/);
    if (m) s.add(m[1]);
  }
  return s;
}

// --- HTTP with retry through the archive's 503/504 overloads ---------------
function fetchText(url, { timeout = 45000, retries = 4 } = {}) {
  return new Promise((resolve) => {
    let attempt = 0;
    const go = () => {
      attempt++;
      const req = https.get(
        url,
        { timeout, headers: { "User-Agent": "archive-recover-worker/1.0" } },
        (res) => {
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
          let d = "";
          res.setEncoding("utf8");
          res.on("data", (c) => (d += c));
          res.on("end", () => {
            if (
              /503 Service|504 Gateway|No server is available/.test(d) &&
              attempt <= retries
            )
              return setTimeout(go, 5000 * attempt);
            resolve(d);
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", () =>
        attempt <= retries ? setTimeout(go, 5000 * attempt) : resolve(""),
      );
    };
    go();
  });
}

async function cdxSnapshots(pattern, limit = 20000) {
  const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(pattern)}&output=text&fl=original,timestamp&collapse=digest&limit=${limit}`;
  const text = await fetchText(url, { timeout: 90000 });
  const snaps = [];
  for (const line of text.split("\n")) {
    const [orig, ts] = line.split(/\s+/);
    if (orig && ts) snaps.push(`https://web.archive.org/web/${ts}id_/${orig}`);
  }
  return snaps;
}

// Pull video IDs (and any titles we can see) out of an archived page.
function extractFrom(html, freq, titleMap) {
  const watch = html.match(/watch\?v=[A-Za-z0-9_-]{11}/g) || [];
  for (const w of watch) {
    const id = w.slice(8);
    freq.set(id, (freq.get(id) || 0) + 1);
  }
  // best-effort title pairing from ytInitialData JSON
  const re =
    /"videoId":"([A-Za-z0-9_-]{11})"[\s\S]{0,400}?"title":\{(?:"runs":\[\{"text":"|"simpleText":")([^"]{1,200})"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!titleMap.has(m[1])) titleMap.set(m[1], m[2]);
  }
}

let lastStatus = {};
function writeStatus(s) {
  lastStatus = { ...lastStatus, ...s, ts: Date.now() };
  try {
    writeFileSync(STATUS, JSON.stringify(lastStatus, null, 2));
  } catch {}
}

// --- Deep discovery across all snapshot sources ----------------------------
async function discover() {
  log("DISCOVER: enumerating archived snapshots (channel + user + playlist)");
  const patterns = [
    `youtube.com/channel/${CH_ID}*`,
    `youtube.com/user/${CH_USER}*`,
    `youtube.com/playlist?list=${UPLOADS}*`,
    `youtube.com/@${CH_USER}*`,
  ];
  let snaps = [];
  for (const p of patterns) {
    const s = await cdxSnapshots(p);
    log(`  ${p} -> ${s.length} snapshots`);
    snaps = snaps.concat(s);
  }
  snaps = [...new Set(snaps)];
  log(`DISCOVER: scraping ${snaps.length} unique snapshots (parallel)`);

  const freq = new Map();
  const titleMap = new Map();
  // preload everything already known (full set + the web app's list + IDs
  // already recovered to disk) so the candidate list only ever GROWS.
  for (const id of readSet(CAND_FULL)) freq.set(id, (freq.get(id) || 0) + 1);
  for (const id of readSet(CAND)) freq.set(id, (freq.get(id) || 0) + 1);
  for (const id of idsOnDisk()) freq.set(id, (freq.get(id) || 0) + 1);

  let i = 0,
    done = 0;
  const CONC = 8;
  async function worker() {
    while (i < snaps.length) {
      const url = snaps[i++];
      const html = await fetchText(url, { timeout: 25000, retries: 1 });
      if (html) extractFrom(html, freq, titleMap);
      done++;
      if (done % 200 === 0) {
        writeSet(CAND_FULL, new Set(freq.keys()));
        writeStatus({
          phase: "discovering",
          snapshots: snaps.length,
          scraped: done,
          knownIds: freq.size,
        });
        log(
          `  scraped ${done}/${snaps.length} · known IDs so far: ${freq.size}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  // persist results
  const allIds = new Set(freq.keys());
  writeSet(CAND_FULL, allIds);
  // candidates.txt = priority-ordered (most frequent first) for the web app
  const ordered = [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
  try {
    writeFileSync(CAND, ordered.join("\n") + "\n");
  } catch {}
  // merge titles
  const existingTitles = new Map();
  if (existsSync(TITLES))
    for (const l of readFileSync(TITLES, "utf8").split("\n")) {
      const [id, ...t] = l.split("\t");
      if (id) existingTitles.set(id, t.join("\t"));
    }
  for (const [id, t] of titleMap) existingTitles.set(id, t);
  try {
    writeFileSync(
      TITLES,
      [...existingTitles].map(([id, t]) => `${id}\t${t}`).join("\n") + "\n",
    );
  } catch {}

  log(
    `DISCOVER complete: ${allIds.size} unique video IDs, ${existingTitles.size} titles known`,
  );
  writeStatus({
    phase: "discovered",
    knownIds: allIds.size,
    titles: existingTitles.size,
  });
  return ordered;
}

// --- Recovery (missing only, multi-URL, best quality) ----------------------
function ytdlp(url) {
  return new Promise((resolve) => {
    const p = spawn(
      "yt-dlp",
      [
        "--ignore-config",
        "--no-warnings",
        "--no-progress",
        "--no-overwrites",
        "--retries",
        "3",
        "--fragment-retries",
        "8",
        "--socket-timeout",
        "45",
        "-f",
        "bestvideo+bestaudio/best",
        "-o",
        "%(title)s [%(id)s].%(ext)s",
        "--restrict-filenames",
        url,
      ],
      { cwd: DIR },
    );
    p.on("error", () => resolve(false));
    p.on("close", (code) => resolve(code === 0));
  });
}
function hasFile(id) {
  return readdirSync(DIR).some((f) => f.includes(`[${id}]`));
}
async function recoverOne(id) {
  if (hasFile(id)) return "have";
  const urls = [
    `https://web.archive.org/web/2oe_/http://wayback-fakeurl.archive.org/yt/${id}`,
    `https://web.archive.org/web/2/https://www.youtube.com/watch?v=${id}`,
    `https://web.archive.org/web/2/https://youtu.be/${id}`,
    `https://www.youtube.com/watch?v=${id}`,
  ];
  for (const u of urls) {
    await ytdlp(u);
    if (hasFile(id)) return "new";
  }
  return "miss";
}

async function recoverMissing(ids) {
  const have = idsOnDisk();
  const missing = ids.filter((id) => !have.has(id));
  log(
    `RECOVER: ${have.size} already on disk, ${missing.length} missing to try`,
  );
  let i = 0,
    fresh = 0,
    miss = 0;
  const CONC = 6;
  async function worker() {
    while (i < missing.length) {
      const id = missing[i++];
      const r = await recoverOne(id);
      if (r === "new") {
        fresh++;
        log(`  recovered NEW ✅ ${id} (${fresh})`);
      } else if (r === "miss") miss++;
      if (i % 10 === 0)
        writeStatus({
          phase: "recovering",
          missing: missing.length,
          tried: i,
          newRecovered: fresh,
          onDisk: idsOnDisk().size,
        });
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  log(`RECOVER pass done: ${fresh} new recovered, ${miss} not in archive`);
  writeStatus({ phase: "idle", newRecovered: fresh, onDisk: idsOnDisk().size });
  return fresh;
}

// --- Main loop: forever -----------------------------------------------------
async function main() {
  log("######### DEEP RECOVER WORKER START (non-stop) #########");
  let pass = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    pass++;
    log(`===== PASS ${pass} =====`);
    try {
      // Discovery is near-exhausted (~622 IDs). Re-scraping 11k snapshots every
      // pass wastes archive bandwidth that's better spent patiently RETRYING the
      // missing IDs (some only succeed when archive.org isn't throttling). So
      // only re-discover on the first pass and every 6th pass (~once/2h); other
      // passes load the cached candidate set and go straight to recovery.
      let ids;
      if (pass === 1 || pass % 6 === 0) {
        ids = await discover();
      } else {
        ids = [...readSet(CAND_FULL)];
        log(
          `RECOVER-only pass: ${ids.length} cached candidate IDs (no re-scrape)`,
        );
      }
      await recoverMissing(ids);
    } catch (e) {
      log("pass error: " + (e?.message || e));
    }
    // gentle wait before re-checking the archive for new captures / retrying
    const waitMin = 15;
    log(`PASS ${pass} complete. Sleeping ${waitMin}m before next sweep.`);
    writeStatus({ phase: "sleeping", nextPassInMin: waitMin, lastPass: pass });
    await new Promise((r) => setTimeout(r, waitMin * 60 * 1000));
  }
}
main();
