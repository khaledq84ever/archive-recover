// Recovery engine: discovers archived YouTube video IDs from the Internet
// Archive (Wayback CDX) and pulls the best-quality stream the archive holds
// via yt-dlp. Ported from the proven auto_recover.sh / retry_alt.sh logic.
import { spawn } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  readFileSync,
} from "node:fs";
import path from "node:path";
import https from "node:https";

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

// Collect the set of video IDs already present in a folder (from the [id] tag).
function idsOnDisk(dir) {
  const set = new Set();
  if (!existsSync(dir)) return set;
  for (const f of readdirSync(dir)) {
    const m = f.match(/\[([A-Za-z0-9_-]{11})\]/);
    if (m) set.add(m[1]);
  }
  return set;
}

// Seed candidate IDs from a previous run's candidates.txt, if present, so a
// channel job instantly knows the full known set instead of re-scraping.
function seedCandidates(dir) {
  const out = [];
  const f = path.join(dir, "candidates.txt");
  if (existsSync(f)) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const id = line.trim();
      if (ID_RE.test(id)) out.push(id);
    }
  }
  return out;
}

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

// ---- Instant availability check (Wayback "available" API) ----------------
// Given a single video URL/ID, ask the Internet Archive whether a snapshot
// exists and return everything we can surface: the archived page link, the
// snapshot timestamp, a thumbnail, whether we already hold the file, and
// fallback recovery routes if nothing is archived. Fast, read-only, no yt-dlp.
function fmtStamp(ts) {
  // 20211016171502 -> 2021-10-16 17:15:02 UTC
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts || "");
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC` : ts || null;
}

export async function checkAvailability(input, dataDir) {
  const target = parseTarget(input);
  if (!target)
    return {
      ok: false,
      error: "Enter a valid YouTube video URL or 11-character video ID.",
    };
  if (target.kind !== "video")
    return {
      ok: false,
      kind: target.kind,
      error:
        "Availability check works on one video. For a whole channel/user, use Recover.",
    };

  const id = target.id;
  const watchUrl = `https://www.youtube.com/watch?v=${id}`;

  // 1) Official Wayback availability API (fast, but it matches YouTube watch
  //    URLs too strictly and usually returns nothing).
  const apiUrl = `https://archive.org/wayback/available?url=${encodeURIComponent(
    "youtube.com/watch?v=" + id,
  )}`;
  let closest = null;
  try {
    const j = JSON.parse(
      await fetchText(apiUrl, { timeout: 30000, retries: 4 }),
    );
    const c = j?.archived_snapshots?.closest;
    if (c && c.available)
      closest = { url: c.url, timestamp: c.timestamp, status: c.status };
  } catch {}

  // 2) CDX prefix search — the reliable route for YouTube. Watch pages were
  //    archived under variants like watch%3Fv%3D<id> / extra params, which the
  //    availability API misses but a prefix match catches. Prefer a 200, newest.
  if (!closest) {
    const cdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(
      "youtube.com/watch?v=" + id,
    )}&matchType=prefix&collapse=digest&output=json&limit=200&fl=timestamp,original,statuscode`;
    try {
      const rows = JSON.parse(
        await fetchText(cdx, { timeout: 45000, retries: 3 }),
      );
      const data = Array.isArray(rows) ? rows.slice(1) : []; // drop header
      const ok200 = data.filter((r) => r[2] === "200");
      const pick = (ok200.length ? ok200 : data).sort((a, b) =>
        b[0].localeCompare(a[0]),
      )[0]; // newest timestamp first
      if (pick)
        closest = {
          url: `https://web.archive.org/web/${pick[0]}/${pick[1]}`,
          timestamp: pick[0],
          status: pick[2],
        };
    } catch {}
  }

  // 3) Best-effort cached metadata via YouTube oEmbed (title/author if it
  //    still resolves; deleted videos 404 here, which is fine).
  let meta = null;
  try {
    const o = JSON.parse(
      await fetchText(
        `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(watchUrl)}`,
        { timeout: 12000, retries: 1 },
      ),
    );
    if (o && o.title) meta = { title: o.title, author: o.author_name || null };
  } catch {}

  // 4) Do we already hold the actual file?
  const have = dataDir ? fileForId(dataDir, id) : null;

  // 5) Decisive recoverability check: is the VIDEO MEDIA actually in the Wayback
  //    YouTube store? yt-dlp pulls bytes from wayback-fakeurl/yt/<id>; a
  //    watch-page snapshot does NOT imply the media was archived — it 404s for
  //    most ids even when the page exists. This, not the page snapshot, is what
  //    determines whether we can actually download the video.
  let mediaArchived = false;
  try {
    const mcdx = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(
      "wayback-fakeurl.archive.org/yt/" + id,
    )}&output=json&limit=2`;
    const rows = JSON.parse(
      await fetchText(mcdx, { timeout: 30000, retries: 3 }),
    );
    mediaArchived = Array.isArray(rows) && rows.length > 1; // header + >=1 capture
  } catch {}

  const pageArchived = !!closest;
  const downloadable = mediaArchived;
  return {
    ok: true,
    id,
    watchUrl,
    // `archived` now means "actually downloadable from the Archive" so callers
    // gating recovery on it aren't misled by page-only snapshots.
    archived: downloadable,
    downloadable,
    pageArchived,
    alreadyRecovered: !!have,
    file: have || null,
    // thumbnails: the UI falls back maxres -> hq -> mq on <img> error.
    thumbnails: [
      `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    ],
    metadata: meta,
    snapshot: pageArchived
      ? {
          url: closest.url,
          timestamp: closest.timestamp,
          when: fmtStamp(closest.timestamp),
          status: closest.status,
          // direct link to view the archived page
          viewUrl: `https://web.archive.org/web/${closest.timestamp}/${watchUrl}`,
          // media route yt-dlp pulls bytes from — only present when archived
          mediaUrl: downloadable
            ? `https://web.archive.org/web/2oe_/http://wayback-fakeurl.archive.org/yt/${id}`
            : null,
        }
      : null,
    // Recovery from the Archive only works when the MEDIA is archived; offer
    // fallback routes whenever it isn't — even if the page snapshot exists.
    fallbacks: downloadable
      ? []
      : [
          {
            label: "Search reuploads on YouTube",
            url: `https://www.youtube.com/results?search_query=${id}`,
          },
          {
            label: "Find mirrors via Google",
            url: `https://www.google.com/search?q=%22${id}%22+youtube`,
          },
          {
            label: "Cached metadata (filmot)",
            url: `https://filmot.com/video/${id}`,
          },
        ],
    message: downloadable
      ? "Video media is archived — recoverable from the Internet Archive."
      : pageArchived
        ? "Only the watch page is archived (no video media), so it can't be downloaded from the Archive. Try the fallback routes below."
        : "No archived snapshot found. Try the fallback routes below.",
  };
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
    // Discover from the archive, then merge with any previously-known IDs so
    // we always work from the full known set for this channel.
    const discovered = await discover(job.target, job);
    const seeded = seedCandidates(job.outDir);
    ids = [...new Set([...discovered, ...seeded])];
    job.log(
      `${discovered.length} found via archive + ${seeded.length} from prior list → ${ids.length} known`,
    );
  }

  // Only fetch what's NOT already in the library. Anything already on disk is
  // counted as "already have" and skipped — so adding the channel just grabs
  // the missing videos.
  const have = idsOnDisk(job.outDir);
  job.alreadyHave = ids.filter((id) => have.has(id)).length;
  job.recovered = new Set([...have].filter((id) => ids.includes(id)));
  const missing = ids.filter((id) => !have.has(id));

  job.candidates = ids;
  job.total = ids.length;
  job.status = "recovering";
  job.log(
    `${job.alreadyHave} already in library · fetching ${missing.length} missing video(s) at best quality`,
  );
  job.emit();

  const CONC = 3;
  let idx = 0;
  async function worker() {
    while (idx < missing.length && !job.cancelled) {
      const id = missing[idx++];
      job.attempted++;
      const r = await attempt(id, job.outDir);
      if (r.ok) {
        job.recovered.add(id);
        job.newCount = (job.newCount || 0) + 1;
        job.log(`recovered ✅ ${id} (new)`);
      } else {
        job.failed.add(id);
      }
      job.emit();
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  job.status = job.cancelled ? "cancelled" : "done";
  job.log(
    `finished: ${job.newCount || 0} new recovered · ${job.alreadyHave} already had · ${job.failed.size} unrecoverable`,
  );
  job.emit();
}
