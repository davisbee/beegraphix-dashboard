// YouTube numbers for every Short on the connected channel. Runs once a day (the Worker's cron, index.ts) and when an
// admin presses Pull Now on the Connections page.
//
// 1. List the channel's Shorts from the last 30 days (uploads of 3 minutes or less), so Shorts posted from the
//    Content Factory's command line count too, not only ones that went through Approve and Post.
// 2. Tie each to its video job where possible: HighLevel's published copy of a post carries the video id (its
//    parentPostId is our ghl_post_id) when the Worker has GHL_TOKEN and GHL_LOCATION_ID; then the tracking link in the
//    description (utm_campaign and utm_content); then publish time and title.
// 3. Read them. Views, likes and comments come from the YouTube Data API, live, the same as Studio shows. Watch time,
//    average view duration, shares and subscribers gained come from YouTube Analytics, which runs 2 to 3 days behind.
// 4. Save a "latest" reading each day, plus the 48h and 7d readings the Performance tab scores (each taken once, on
//    the first pull after the Short is that old).

import { HttpError, json, now, type Env } from "./common";
import type { Caller } from "./auth";
import { accessToken, analyticsUrl, myChannel, youtubeUrl, type Connection } from "./connections";
import { saveFeatures } from "./tracking";

const DAY = 86400_000;
const WINDOW_DAYS = 30;
const SHORT_MAX_SECONDS = 180;
// A Short goes out within seconds of its scheduled time; this much slack covers HighLevel running late.
const MATCH_SLACK_MS = 3 * 3600_000;
const ANALYTICS = ["views", "estimatedMinutesWatched", "averageViewDuration", "likes", "comments", "shares", "subscribersGained"];

interface Upload { id: string; title: string; description: string; publishedAt: number }
interface Video extends Upload { seconds: number | null; views: number | null; likes: number | null; comments: number | null }
interface Feature { campaign: string; item_key: string; job_id: string; scheduled_at: string; ghl_post_id: string | null; platform_post_id: string | null; title: string | null }
interface Link { job_id: string | null; campaign: string | null; item_key: string | null; matched_by: string | null }
type Numbers = { watchSeconds: number | null; avgViewSeconds: number | null; shares: number | null; newFollowers: number | null };

const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const num = (v: unknown) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const shortUrl = (id: string) => `https://www.youtube.com/shorts/${id}`;
/** ISO 8601 duration (PT1M5S) in seconds. */
const seconds = (d: string | undefined) => { const m = String(d ?? "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/); return m ? (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0)) : null; };

async function getJson(url: string, token: string) {
  const r = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const data = (await r.json().catch(() => ({}))) as any;
  if (!r.ok) throw new HttpError(502, `${new URL(url).hostname} said ${r.status}: ${data?.error?.message ?? data?.message ?? "error"}`);
  return data;
}

// ---------- 1. the channel's Shorts ----------

/** Uploads since `since`, newest first, with their length and live counts. Longer videos are left out. */
async function channelShorts(env: Env, token: string, playlist: string, since: number): Promise<Video[]> {
  const list: Upload[] = [];
  let page = "";
  for (let i = 0; i < 4; i++) {
    const d = await getJson(`${youtubeUrl(env)}/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(playlist)}${page ? `&pageToken=${page}` : ""}`, token);
    const items: Upload[] = (d.items ?? []).map((x: any) => ({ id: x.contentDetails?.videoId, title: x.snippet?.title ?? "", description: x.snippet?.description ?? "", publishedAt: Date.parse(x.contentDetails?.videoPublishedAt ?? x.snippet?.publishedAt) }))
      .filter((u: Upload) => u.id && Number.isFinite(u.publishedAt));
    list.push(...items.filter((u) => u.publishedAt >= since));
    if (!d.nextPageToken || items.some((u) => u.publishedAt < since)) break;
    page = d.nextPageToken;
  }
  const out: Video[] = [];
  for (let i = 0; i < list.length; i += 50) {
    const d = await getJson(`${youtubeUrl(env)}/youtube/v3/videos?part=statistics,contentDetails&id=${list.slice(i, i + 50).map((u) => u.id).join(",")}`, token);
    const byId = new Map<string, any>((d.items ?? []).map((v: any) => [v.id, v]));
    for (const u of list.slice(i, i + 50)) {
      const v = byId.get(u.id);
      if (!v) continue; // private or deleted since it was listed
      const s = v.statistics ?? {};
      out.push({ ...u, seconds: seconds(v.contentDetails?.duration), views: num(s.viewCount), likes: num(s.likeCount), comments: num(s.commentCount) });
    }
  }
  return out.filter((v) => v.seconds === null || v.seconds <= SHORT_MAX_SECONDS);
}

// ---------- 2. which video job is it ----------

/** HighLevel's published posts on this channel: video id by the id of the post we scheduled. Empty without its keys. */
async function fromHighLevel(env: Env, channelId: string, since: string) {
  const found = new Map<string, string>();
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
  for (const p of ((await r.json().catch(() => ({}))) as any)?.results?.posts ?? []) if (p.parentPostId && p.postId) found.set(String(p.parentPostId), String(p.postId));
  return found;
}

/** The utm_campaign and utm_content on the first tracking link in a description. */
export function linkTags(description: string) {
  const m = description.match(/https?:\/\/\S*utm_[^\s]*/);
  if (!m) return null;
  try {
    const q = new URL(m[0]).searchParams;
    return { campaign: q.get("utm_campaign"), item: q.get("utm_content"), job: q.get("utm_id") };
  } catch { return null; }
}

/** Published close to when it was scheduled, with the title it was given. Alone in the window, a close time is enough. */
export function matchUpload(post: { scheduled_at: string; title: string | null }, list: Upload[], taken: Set<string>): Upload | null {
  const at = Date.parse(post.scheduled_at);
  const near = list.filter((u) => !taken.has(u.id) && Math.abs(u.publishedAt - at) <= MATCH_SLACK_MS).sort((a, b) => Math.abs(a.publishedAt - at) - Math.abs(b.publishedAt - at));
  const titled = post.title ? near.find((u) => norm(u.title) === norm(post.title)) : undefined;
  if (titled) return titled;
  return near.length === 1 && Math.abs(near[0].publishedAt - at) <= 20 * 60_000 ? near[0] : null;
}

/**
 * Shorts that went out through Approve and Post before the dashboard saved a row per post (migration 0010): their
 * YouTube rows come from what the desktop reported when it scheduled them.
 */
async function backfillFeatures(env: Env, brand: string) {
  const rows = await env.DB.prepare(
    `SELECT p.posted, j.id, j.brand, j.payload FROM posts p JOIN jobs j ON j.id = p.task_job
     WHERE p.brand = ? AND p.task_kind = 'publish' AND j.status = 'done' AND p.posted LIKE '%"youtube"%'
       AND NOT EXISTS (SELECT 1 FROM post_features f WHERE f.campaign = p.campaign AND f.platform = 'youtube')`,
  ).bind(brand).all<{ posted: string; id: string; brand: string; payload: string }>();
  for (const r of rows.results) {
    let posted: unknown[] = [];
    try { posted = JSON.parse(r.posted); } catch { continue; }
    await saveFeatures(env, r, { posted: posted.filter((x: any) => x?.platform === "youtube") });
  }
}

// ---------- 3. Analytics ----------

async function analytics(env: Env, token: string, ids: string[], since: number) {
  const out = new Map<string, Numbers>();
  // Analytics days are Pacific time, so start a day early to be sure the first day is in.
  const q = new URLSearchParams({
    ids: "channel==MINE", startDate: new Date(since - DAY).toISOString().slice(0, 10), endDate: new Date().toISOString().slice(0, 10),
    metrics: ANALYTICS.join(","), dimensions: "video", filters: `video==${ids.join(",")}`, sort: "-views", maxResults: "200",
  });
  const d = await getJson(`${analyticsUrl(env)}/v2/reports?${q}`, token);
  const col = (name: string) => (d.columnHeaders ?? []).findIndex((h: any) => h.name === name);
  for (const row of d.rows ?? []) {
    const minutes = num(row[col("estimatedMinutesWatched")]);
    out.set(row[col("video")], { watchSeconds: minutes === null ? null : minutes * 60, avgViewSeconds: num(row[col("averageViewDuration")]), shares: num(row[col("shares")]), newFollowers: num(row[col("subscribersGained")]) });
  }
  return out;
}

// ---------- one channel's pull ----------

export async function pullYouTube(env: Env, conn: Connection) {
  const at = Date.now();
  const since = at - WINDOW_DAYS * DAY;
  const report = { brand: conn.brand, channel: conn.account_name, shorts: 0, linked: 0, newlyLinked: 0, read: 0, readings: 0, notFound: [] as string[], problems: [] as string[] };
  const mark = (error: string | null) => env.DB.prepare("UPDATE platform_connections SET last_pull_at = ?, last_error = ? WHERE brand = ? AND platform = 'youtube'").bind(now(), error, conn.brand).run();
  try {
    const token = await accessToken(env, conn);
    const ch = await myChannel(env, token);
    if (!ch?.uploads) throw new HttpError(502, "YouTube didn't return the channel's uploads");
    const videos = await channelShorts(env, token, ch.uploads, since);
    report.shorts = videos.length;
    const byId = new Map(videos.map((v) => [v.id, v]));

    await backfillFeatures(env, conn.brand);
    const [featureRows, knownRows] = await env.DB.batch([
      env.DB.prepare(
        `SELECT f.campaign, f.item_key, f.job_id, f.scheduled_at, f.ghl_post_id, f.platform_post_id,
           COALESCE(NULLIF(json_extract(p.copy, '$.captions.youtubeTitle'), ''), (SELECT title FROM catalog c WHERE c.campaign = f.campaign)) AS title
         FROM post_features f LEFT JOIN posts p ON p.campaign = f.campaign
         WHERE f.platform = 'youtube' AND f.brand = ? AND f.scheduled_at >= ? AND f.scheduled_at <= ?`,
      ).bind(conn.brand, new Date(since - DAY).toISOString(), new Date(at).toISOString()),
      env.DB.prepare("SELECT post_id, job_id, campaign, item_key, matched_by FROM platform_posts WHERE platform = 'youtube' AND brand = ?").bind(conn.brand),
    ]);
    const features = featureRows.results as unknown as Feature[];
    const links = new Map<string, Link>((knownRows.results as any[]).map((r) => [r.post_id, r]));
    const taken = new Set(features.map((f) => f.platform_post_id).filter(Boolean) as string[]);
    const saves: D1PreparedStatement[] = [];
    const link = (f: Feature, videoId: string, by: string) => {
      taken.add(videoId);
      f.platform_post_id = videoId;
      links.set(videoId, { job_id: f.job_id, campaign: f.campaign, item_key: f.item_key, matched_by: by });
      saves.push(env.DB.prepare("UPDATE post_features SET platform_post_id = ? WHERE campaign = ? AND item_key = ? AND platform = 'youtube'").bind(videoId, f.campaign, f.item_key));
      report.newlyLinked++;
    };

    // Approve and Post's Shorts: find each one's video.
    const open = features.filter((f) => !f.platform_post_id);
    if (open.length) {
      let ghl = new Map<string, string>();
      try { ghl = await fromHighLevel(env, conn.account_id, new Date(since).toISOString()); } catch (e) { report.problems.push(`HighLevel: ${(e as Error).message}`); }
      for (const f of open) {
        const viaGhl = f.ghl_post_id ? ghl.get(f.ghl_post_id) : undefined;
        if (viaGhl && byId.has(viaGhl) && !taken.has(viaGhl)) { link(f, viaGhl, "highlevel"); continue; }
        const viaLink = videos.find((v) => { const t = linkTags(v.description); return !taken.has(v.id) && t?.item === f.item_key && (t.job === f.job_id || !!t.campaign?.endsWith(f.campaign)); });
        if (viaLink) { link(f, viaLink.id, "link"); continue; }
        const viaTime = matchUpload(f, videos, taken);
        if (viaTime) { link(f, viaTime.id, "title_time"); continue; }
        if (at - Date.parse(f.scheduled_at) > 3600_000) report.notFound.push(`${f.title ?? f.campaign} (${f.item_key})`);
      }
    }

    // Every Short on the channel gets a row; ones from the command line keep the campaign and step their link names.
    const t = now();
    for (const v of videos) {
      const l = links.get(v.id);
      const tags = l?.job_id ? null : linkTags(v.description);
      saves.push(env.DB.prepare(
        `INSERT INTO platform_posts (platform, post_id, brand, title, url, published_at, job_id, campaign, item_key, matched_by, seen_at) VALUES ('youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (platform, post_id) DO UPDATE SET title = excluded.title, published_at = excluded.published_at, seen_at = excluded.seen_at,
           job_id = COALESCE(excluded.job_id, job_id), campaign = COALESCE(excluded.campaign, campaign), item_key = COALESCE(excluded.item_key, item_key), matched_by = COALESCE(excluded.matched_by, matched_by)`,
      ).bind(v.id, conn.brand, v.title.slice(0, 200), shortUrl(v.id), new Date(v.publishedAt).toISOString(), l?.job_id ?? null, l?.campaign ?? tags?.campaign ?? null, l?.item_key ?? tags?.item ?? null, l?.matched_by ?? null, t));
    }
    if (saves.length) await env.DB.batch(saves);
    report.linked = videos.filter((v) => links.get(v.id)?.job_id).length;

    // The numbers.
    if (videos.length) {
      let more = new Map<string, Numbers>();
      try { more = await analytics(env, token, videos.map((v) => v.id), Math.min(...videos.map((v) => v.publishedAt))); }
      catch (e) { report.problems.push(`YouTube Analytics: ${(e as Error).message}`); }
      const had = await env.DB.prepare(`SELECT post_id, reading FROM post_stats WHERE source = 'youtube' AND reading IN ('48h', '7d') AND post_id IN (${videos.map(() => "?").join(",")})`)
        .bind(...videos.map((v) => v.id)).all<{ post_id: string; reading: string }>();
      const done = new Set(had.results.map((r) => `${r.post_id}|${r.reading}`));
      const rows: D1PreparedStatement[] = [];
      for (const v of videos) {
        const l = links.get(v.id);
        const n = more.get(v.id);
        const age = at - v.publishedAt;
        const readings = ["latest", ...(age >= 2 * DAY && !done.has(`${v.id}|48h`) ? ["48h"] : []), ...(age >= 7 * DAY && !done.has(`${v.id}|7d`) ? ["7d"] : [])];
        for (const reading of readings) {
          rows.push(env.DB.prepare(
            `INSERT OR REPLACE INTO post_stats (source, post_id, reading, brand, platform, job_id, item_key, posted_at, read_at, views, watch_seconds, avg_view_seconds, likes, comments, shares, new_followers, boosted)
             VALUES ('youtube', ?, ?, ?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          ).bind(v.id, reading, conn.brand, l?.job_id ?? null, l?.item_key ?? null, new Date(v.publishedAt).toISOString(), t, v.views, n?.watchSeconds ?? null, n?.avgViewSeconds ?? null, v.likes, v.comments, n?.shares ?? null, n?.newFollowers ?? null));
        }
        report.read++;
        report.readings += readings.length;
      }
      if (rows.length) await env.DB.batch(rows);
    }
    await mark(report.problems.length ? report.problems.join(" ").slice(0, 500) : null);
  } catch (e) {
    const msg = (e as Error).message;
    report.problems.push(msg);
    await mark(msg.slice(0, 500));
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

interface StatRow { post_id: string; platform: string; item_key: string | null; job_id: string | null; reading: string; read_at: string; views: number | null; watch_seconds: number | null; avg_view_seconds: number | null; likes: number | null; comments: number | null; shares: number | null; saves: number | null; new_followers: number | null }
const READ_ORDER = ["latest", "7d", "48h", "backfill"];

const shown = (s: StatRow | undefined) => s ? {
  reading: s.reading, readAt: s.read_at, views: s.views, watchSeconds: s.watch_seconds, avgViewSeconds: s.avg_view_seconds, likes: s.likes, comments: s.comments, shares: s.shares, saves: s.saves, newFollowers: s.new_followers,
} : null;

/** Each post's readings, found by its job and plan step, or by the platform's post id. */
function readings(rows: StatRow[]) {
  const m = new Map<string, Record<string, StatRow>>();
  for (const r of rows) {
    for (const k of [r.job_id ? `${r.job_id}|${r.platform}|${r.item_key}` : null, `${r.platform}#${r.post_id}`]) if (k) m.set(k, { ...(m.get(k) ?? {}), [r.reading]: r });
  }
  return (key: string) => m.get(key) ?? {};
}
const newest = (r: Record<string, StatRow>) => READ_ORDER.map((k) => r[k]).find(Boolean);

/** GET /api/jobs/:id/stats: each of a video's posts with its numbers, newest reading first. Any platform. */
export async function jobStats(env: Env, jobId: string) {
  const [features, stats, found] = await env.DB.batch([
    env.DB.prepare("SELECT campaign, item_key, platform, post_type, scheduled_at, platform_post_id FROM post_features WHERE job_id = ? ORDER BY scheduled_at, platform").bind(jobId),
    env.DB.prepare("SELECT * FROM post_stats WHERE job_id = ?").bind(jobId),
    env.DB.prepare("SELECT platform, post_id, url FROM platform_posts WHERE job_id = ?").bind(jobId),
  ]);
  const read = readings(stats.results as unknown as StatRow[]);
  const urls = new Map((found.results as any[]).map((r) => [`${r.platform}#${r.post_id}`, r.url]));
  return json({
    posts: (features.results as any[]).map((f) => {
      const r = read(`${jobId}|${f.platform}|${f.item_key}`);
      return { platform: f.platform, itemKey: f.item_key, type: f.post_type, scheduledAt: f.scheduled_at, url: urls.get(`${f.platform}#${f.platform_post_id}`) ?? null, postId: f.platform_post_id, now: shown(newest(r)), at48h: shown(r["48h"]), at7d: shown(r["7d"]) };
    }),
  });
}

/** GET /api/youtube?brand=: every Short, most viewed first, with the channel it's read from. */
export async function youtubeList(env: Env, c: Caller, url: URL) {
  const asked = url.searchParams.get("brand") || c.brand;
  if (c.brand !== "*" && asked !== c.brand) throw new HttpError(404, "Not found");
  const where = asked === "*" ? "" : " AND brand = ?";
  const bind = asked === "*" ? [] : [asked];
  const [channel, scheduled, stats, conns] = await env.DB.batch([
    env.DB.prepare(`SELECT post_id, brand, title, url, published_at, job_id, campaign, item_key FROM platform_posts WHERE platform = 'youtube'${where}`).bind(...bind),
    // Scheduled through Approve and Post but not found on the channel yet.
    env.DB.prepare(
      `SELECT f.job_id, f.campaign, f.item_key, f.brand, f.scheduled_at,
         COALESCE(NULLIF(json_extract(p.copy, '$.captions.youtubeTitle'), ''), (SELECT title FROM catalog c WHERE c.campaign = f.campaign), f.campaign) AS title
       FROM post_features f LEFT JOIN posts p ON p.campaign = f.campaign
       WHERE f.platform = 'youtube' AND (f.platform_post_id IS NULL OR f.platform_post_id NOT IN (SELECT post_id FROM platform_posts WHERE platform = 'youtube'))${where.replace("brand", "f.brand")}`,
    ).bind(...bind),
    env.DB.prepare(`SELECT * FROM post_stats WHERE platform = 'youtube'${where}`).bind(...bind),
    env.DB.prepare(`SELECT brand, account_name, last_pull_at, last_error FROM platform_connections WHERE platform = 'youtube'${where}`).bind(...bind),
  ]);
  const read = readings(stats.results as unknown as StatRow[]);
  const shorts = [
    ...(channel.results as any[]).map((p) => ({
      job: p.job_id, campaign: p.campaign, itemKey: p.item_key, brand: p.brand, title: p.title, scheduledAt: p.published_at, url: p.url, videoId: p.post_id, found: true, now: shown(newest(read(`youtube#${p.post_id}`))),
    })),
    ...(scheduled.results as any[]).map((f) => ({
      job: f.job_id, campaign: f.campaign, itemKey: f.item_key, brand: f.brand, title: f.title, scheduledAt: f.scheduled_at, url: null, videoId: null, found: false, now: shown(newest(read(`${f.job_id}|youtube|${f.item_key}`))),
    })),
  ].sort((a, b) => (b.now?.views ?? -1) - (a.now?.views ?? -1) || String(b.scheduledAt).localeCompare(String(a.scheduledAt)));
  return json({ shorts, channels: conns.results });
}
