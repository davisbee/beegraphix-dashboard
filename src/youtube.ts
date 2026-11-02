// YouTube numbers for every Short the Content Factory posts. Runs once a day (the Worker's cron, index.ts) and when an
// admin presses Pull Now on the Connections page.
//
// 1. Find each Short's video id. HighLevel's published copy of a post carries it (its parentPostId is our ghl_post_id),
//    so that's asked first when the Worker has GHL_TOKEN and GHL_LOCATION_ID. Otherwise, or if HighLevel doesn't know,
//    the channel's uploads are matched on publish time and title.
// 2. Read it. Views, likes and comments come from the YouTube Data API, live, the same as Studio shows. Watch time,
//    average view duration, shares and subscribers gained come from YouTube Analytics, which runs 2 to 3 days behind.
// 3. Save a "latest" reading each day for 30 days after posting, and the 48h and 7d readings the Performance tab scores
//    (each taken once, on the first pull after the post is that old).

import { HttpError, json, now, type Env } from "./common";
import type { Caller } from "./auth";
import { accessToken, analyticsUrl, myChannel, youtubeUrl, type Connection } from "./connections";

const DAY = 86400_000;
const WINDOW_DAYS = 30;
// A Short goes out within seconds of its scheduled time; this much slack covers HighLevel running late.
const MATCH_SLACK_MS = 3 * 3600_000;
const ANALYTICS = ["views", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "shares", "subscribersGained"];

interface DueRow { campaign: string; item_key: string; job_id: string; brand: string; scheduled_at: string; ghl_post_id: string | null; platform_post_id: string | null; title: string | null; has48: number; has7: number }
interface Found { id: string; url: string; by: "highlevel" | "title_time" }
type Numbers = { views: number | null; likes: number | null; comments: number | null; watchSeconds: number | null; avgViewSeconds: number | null; shares: number | null; newFollowers: number | null };

const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const num = (v: unknown) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const shortUrl = (id: string) => `https://www.youtube.com/shorts/${id}`;

async function getJson(url: string, token: string) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const data = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new HttpError(502, `${new URL(url).hostname} said ${r.status}: ${data?.error?.message ?? data?.message ?? "error"}`);
  return data;
}

// ---------- 1. which video is it ----------

/** HighLevel's published posts on this channel, by the id of the post we scheduled. Empty without the HighLevel keys. */
async function fromHighLevel(env: Env, channelId: string, since: string): Promise<Map<string, Found>> {
  const found = new Map<string, Found>();
  if (!env.GHL_TOKEN || !env.GHL_LOCATION_ID) return found;
  const base = env.GHL_API_URL ?? "https://services.leadconnectorhq.com";
  const headers = { authorization: `Bearer ${env.GHL_TOKEN}`, version: "2021-07-28", accept: "application/json", "content-type": "application/json" };
  const loc = encodeURIComponent(env.GHL_LOCATION_ID);
  const a = await fetch(`${base}/social-media-posting/${loc}/accounts`, { headers });
  const accts = ((await a.json().catch(() => ({}))) as any)?.results?.accounts ?? [];
  // HighLevel's account id for a YouTube channel ends in _<channel id>_profile.
  const acct = accts.find((x: any) => x.platform === "youtube" && String(x.id ?? x._id).includes(`_${channelId}_`));
  if (!acct) return found;
  const r = await fetch(`${base}/social-media-posting/${loc}/posts/list`, {
    method: "POST", headers,
    body: JSON.stringify({ type: "published", accounts: String(acct.id ?? acct._id), skip: "0", limit: "100", fromDate: since, toDate: new Date(Date.now() + DAY).toISOString(), includeUsers: "false" }),
  });
  for (const p of ((await r.json().catch(() => ({}))) as any)?.results?.posts ?? []) {
    if (p.parentPostId && p.postId) found.set(String(p.parentPostId), { id: String(p.postId), url: p.previewLink || shortUrl(p.postId), by: "highlevel" });
  }
  return found;
}

interface Upload { id: string; title: string; publishedAt: number }

/** The channel's latest uploads (50 covers the 30 days this looks at many times over). */
async function uploads(env: Env, token: string, playlist: string): Promise<Upload[]> {
  const d = await getJson(`${youtubeUrl(env)}/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlist)}`, token);
  return (d.items ?? []).map((i: any) => ({ id: i.contentDetails?.videoId, title: i.snippet?.title ?? "", publishedAt: Date.parse(i.contentDetails?.videoPublishedAt ?? i.snippet?.publishedAt) }))
    .filter((u: Upload) => u.id && Number.isFinite(u.publishedAt));
}

/** Published close to when it was scheduled, with the title it was given. Alone in the window, a close time is enough. */
export function matchUpload(post: { scheduled_at: string; title: string | null }, list: Upload[], taken: Set<string>): Upload | null {
  const at = Date.parse(post.scheduled_at);
  const near = list.filter((u) => !taken.has(u.id) && Math.abs(u.publishedAt - at) <= MATCH_SLACK_MS).sort((a, b) => Math.abs(a.publishedAt - at) - Math.abs(b.publishedAt - at));
  const titled = post.title ? near.find((u) => norm(u.title) === norm(post.title)) : undefined;
  if (titled) return titled;
  return near.length === 1 && Math.abs(near[0].publishedAt - at) <= 20 * 60_000 ? near[0] : null;
}

// ---------- 2. read the numbers ----------

async function readNumbers(env: Env, token: string, ids: string[], since: string) {
  const out = new Map<string, Numbers>();
  const problems: string[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const d = await getJson(`${youtubeUrl(env)}/youtube/v3/videos?part=statistics&id=${ids.slice(i, i + 50).join(",")}`, token);
    for (const v of d.items ?? []) {
      const s = v.statistics ?? {};
      out.set(v.id, { views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount), watchSeconds: null, avgViewSeconds: null, shares: null, newFollowers: null });
    }
  }
  try {
    // Analytics days are Pacific time, so start a day early to be sure the first day is in.
    const start = new Date(Date.parse(since) - DAY).toISOString().slice(0, 10);
    const q = new URLSearchParams({ ids: "channel==MINE", startDate: start, endDate: new Date().toISOString().slice(0, 10), metrics: ANALYTICS.join(","), dimensions: "video", filters: `video==${ids.join(",")}`, sort: "-views", maxResults: "200" });
    const d = await getJson(`${analyticsUrl(env)}/v2/reports?${q}`, token);
    const col = (name: string) => (d.columnHeaders ?? []).findIndex((h: any) => h.name === name);
    for (const row of d.rows ?? []) {
      const n = out.get(row[col("video")]);
      if (!n) continue;
      const minutes = num(row[col("estimatedMinutesWatched")]);
      n.watchSeconds = minutes === null ? null : minutes * 60;
      n.avgViewSeconds = num(row[col("averageViewDuration")]);
      n.shares = num(row[col("shares")]);
      n.newFollowers = num(row[col("subscribersGained")]);
    }
  } catch (e) {
    problems.push(`YouTube Analytics: ${(e as Error).message}`);
  }
  return { numbers: out, problems };
}

// ---------- 3. one channel's pull ----------

export async function pullYouTube(env: Env, conn: Connection) {
  const at = Date.now();
  const since = new Date(at - WINDOW_DAYS * DAY).toISOString();
  const report = { brand: conn.brand, channel: conn.account_name, posts: 0, matched: 0, read: 0, readings: 0, unmatched: [] as string[], problems: [] as string[] };
  try {
    const token = await accessToken(env, conn);
    const due = (await env.DB.prepare(
      `SELECT f.campaign, f.item_key, f.job_id, f.brand, f.scheduled_at, f.ghl_post_id, f.platform_post_id,
         COALESCE(NULLIF(json_extract(p.copy, '$.captions.youtubeTitle'), ''), (SELECT title FROM catalog c WHERE c.campaign = f.campaign)) AS title,
         EXISTS (SELECT 1 FROM post_stats s WHERE s.job_id = f.job_id AND s.platform = 'youtube' AND s.item_key = f.item_key AND s.reading = '48h') AS has48,
         EXISTS (SELECT 1 FROM post_stats s WHERE s.job_id = f.job_id AND s.platform = 'youtube' AND s.item_key = f.item_key AND s.reading = '7d') AS has7
       FROM post_features f LEFT JOIN posts p ON p.campaign = f.campaign
       WHERE f.platform = 'youtube' AND f.brand = ? AND f.scheduled_at >= ? AND f.scheduled_at <= ? ORDER BY f.scheduled_at`,
    ).bind(conn.brand, since, new Date(at).toISOString()).all<DueRow>()).results;
    report.posts = due.length;

    const needIds = due.filter((d) => !d.platform_post_id);
    if (needIds.length) {
      const taken = new Set((await env.DB.prepare("SELECT platform_post_id FROM post_features WHERE platform = 'youtube' AND platform_post_id IS NOT NULL").all<{ platform_post_id: string }>()).results.map((r) => r.platform_post_id));
      let ghl = new Map<string, Found>();
      try { ghl = await fromHighLevel(env, conn.account_id, since); } catch (e) { report.problems.push(`HighLevel: ${(e as Error).message}`); }
      const ch = needIds.some((d) => !d.ghl_post_id || !ghl.has(d.ghl_post_id)) ? await myChannel(env, token) : null;
      const list = ch?.uploads ? await uploads(env, token, ch.uploads) : [];
      const saves: D1PreparedStatement[] = [];
      for (const d of needIds) {
        let f = d.ghl_post_id ? ghl.get(d.ghl_post_id) ?? null : null;
        if (!f) { const u = matchUpload(d, list, taken); if (u) f = { id: u.id, url: shortUrl(u.id), by: "title_time" }; }
        if (!f || taken.has(f.id)) { report.unmatched.push(`${d.campaign} (${d.item_key})`); continue; }
        taken.add(f.id);
        d.platform_post_id = f.id;
        report.matched++;
        saves.push(env.DB.prepare("UPDATE post_features SET platform_post_id = ?, platform_url = ?, matched_by = ? WHERE campaign = ? AND item_key = ? AND platform = 'youtube'").bind(f.id, f.url, f.by, d.campaign, d.item_key));
      }
      if (saves.length) await env.DB.batch(saves);
    }

    const known = due.filter((d) => d.platform_post_id);
    if (known.length) {
      const { numbers, problems } = await readNumbers(env, token, known.map((d) => d.platform_post_id!), known[0].scheduled_at);
      report.problems.push(...problems);
      const t = now();
      const rows: D1PreparedStatement[] = [];
      for (const d of known) {
        const n = numbers.get(d.platform_post_id!);
        if (!n) { report.unmatched.push(`${d.campaign} (${d.item_key}): YouTube doesn't show video ${d.platform_post_id}, it may be private or deleted`); continue; }
        report.read++;
        const age = at - Date.parse(d.scheduled_at);
        const readings = ["latest", ...(age >= 2 * DAY && !d.has48 ? ["48h"] : []), ...(age >= 7 * DAY && !d.has7 ? ["7d"] : [])];
        for (const reading of readings) {
          rows.push(env.DB.prepare(
            `INSERT OR REPLACE INTO post_stats (source, post_id, reading, brand, platform, job_id, item_key, posted_at, read_at, views, watch_seconds, avg_view_seconds, likes, comments, shares, new_followers, boosted)
             VALUES ('youtube', ?, ?, ?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          ).bind(d.platform_post_id, reading, d.brand, d.job_id, d.item_key, d.scheduled_at, t, n.views, n.watchSeconds, n.avgViewSeconds, n.likes, n.comments, n.shares, n.newFollowers));
        }
        report.readings += readings.length;
      }
      if (rows.length) await env.DB.batch(rows);
    }
    await env.DB.prepare("UPDATE platform_connections SET last_pull_at = ?, last_error = ? WHERE brand = ? AND platform = 'youtube'")
      .bind(now(), report.problems.length ? report.problems.join(" ").slice(0, 500) : null, conn.brand).run();
  } catch (e) {
    const msg = (e as Error).message;
    report.problems.push(msg);
    await env.DB.prepare("UPDATE platform_connections SET last_pull_at = ?, last_error = ? WHERE brand = ? AND platform = 'youtube'").bind(now(), msg.slice(0, 500), conn.brand).run();
  }
  return report;
}

/** The daily cron: every brand's connected channel. */
export async function pullAllYouTube(env: Env) {
  const conns = (await env.DB.prepare("SELECT * FROM platform_connections WHERE platform = 'youtube'").all<Connection>()).results;
  const out = [];
  for (const c of conns) out.push(await pullYouTube(env, c));
  return out;
}

/** POST /api/connections/youtube/pull?brand=: an admin pulls now instead of waiting for the morning. */
export async function pullNow(env: Env, brand: string) {
  const conn = await env.DB.prepare("SELECT * FROM platform_connections WHERE brand = ? AND platform = 'youtube'").bind(brand).first<Connection>();
  if (!conn) throw new HttpError(404, "YouTube isn't connected");
  return json(await pullYouTube(env, conn));
}

// ---------- showing it ----------

interface StatRow { platform: string; item_key: string; job_id: string; reading: string; read_at: string; views: number | null; watch_seconds: number | null; avg_view_seconds: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; new_followers: number | null }
const READ_ORDER = ["latest", "7d", "48h", "backfill"];

const shown = (s: StatRow | undefined) => s ? {
  reading: s.reading, readAt: s.read_at, views: s.views, watchSeconds: s.watch_seconds, avgViewSeconds: s.avg_view_seconds, likes: s.likes, comments: s.comments, shares: s.shares, saves: s.saves, newFollowers: s.new_followers,
} : null;

/** Every reading of a set of posts, keyed job|platform|item. */
function byPost(rows: StatRow[]) {
  const m = new Map<string, Record<string, StatRow>>();
  for (const r of rows) {
    const k = `${r.job_id}|${r.platform}|${r.item_key}`;
    m.set(k, { ...(m.get(k) ?? {}), [r.reading]: r });
  }
  return m;
}

/** GET /api/jobs/:id/stats: each of a video's posts with its numbers, newest reading first. Any platform. */
export async function jobStats(env: Env, jobId: string) {
  const [features, stats] = await env.DB.batch([
    env.DB.prepare("SELECT campaign, item_key, platform, post_type, scheduled_at, platform_post_id, platform_url FROM post_features WHERE job_id = ? ORDER BY scheduled_at, platform").bind(jobId),
    env.DB.prepare("SELECT * FROM post_stats WHERE job_id = ?").bind(jobId),
  ]);
  const reads = byPost(stats.results as unknown as StatRow[]);
  return json({
    posts: (features.results as any[]).map((f) => {
      const r = reads.get(`${jobId}|${f.platform}|${f.item_key}`) ?? {};
      const newest = READ_ORDER.map((k) => r[k]).find(Boolean);
      return { platform: f.platform, itemKey: f.item_key, type: f.post_type, scheduledAt: f.scheduled_at, url: f.platform_url, postId: f.platform_post_id, now: shown(newest), at48h: shown(r["48h"]), at7d: shown(r["7d"]) };
    }),
  });
}

/** GET /api/youtube?brand=: every Short, most viewed first, with the channel it's read from. */
export async function youtubeList(env: Env, c: Caller, url: URL) {
  const asked = url.searchParams.get("brand") || c.brand;
  if (c.brand !== "*" && asked !== c.brand) throw new HttpError(404, "Not found");
  const where = asked === "*" ? "" : " AND f.brand = ?";
  const bind = asked === "*" ? [] : [asked];
  const [features, stats, conns] = await env.DB.batch([
    env.DB.prepare(
      `SELECT f.job_id, f.campaign, f.item_key, f.brand, f.scheduled_at, f.platform_post_id, f.platform_url, f.hook_text,
         COALESCE(NULLIF(json_extract(p.copy, '$.captions.youtubeTitle'), ''), (SELECT title FROM catalog c WHERE c.campaign = f.campaign), f.campaign) AS title
       FROM post_features f LEFT JOIN posts p ON p.campaign = f.campaign WHERE f.platform = 'youtube'${where} ORDER BY f.scheduled_at DESC`,
    ).bind(...bind),
    env.DB.prepare(`SELECT * FROM post_stats WHERE platform = 'youtube'${where.replace("f.", "")}`).bind(...bind),
    env.DB.prepare(`SELECT brand, account_name, last_pull_at, last_error FROM platform_connections WHERE platform = 'youtube'${where.replace("f.", "")}`).bind(...bind),
  ]);
  const reads = byPost(stats.results as unknown as StatRow[]);
  const shorts = (features.results as any[]).map((f) => {
    const r = reads.get(`${f.job_id}|youtube|${f.item_key}`) ?? {};
    return { job: f.job_id, campaign: f.campaign, itemKey: f.item_key, brand: f.brand, title: f.title, hook: f.hook_text, scheduledAt: f.scheduled_at, url: f.platform_url, videoId: f.platform_post_id, now: shown(READ_ORDER.map((k) => r[k]).find(Boolean)) };
  }).sort((a, b) => (b.now?.views ?? -1) - (a.now?.views ?? -1));
  return json({ shorts, channels: conns.results });
}
