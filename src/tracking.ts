// Performance tracking, step 1: get the data in. Rotates post times on purpose, saves what made each post different
// when it's scheduled, and takes in stats and the starting snapshot once the platform connections exist.

import { HttpError, body, json, now, type Env } from "./common";
import { GOALS } from "./build";

// Eastern. `until` is where the next slot starts, so a time someone picks by hand still lands in a slot.
// The same times are in public/app.js (SLOTS), which shows the week as it's being edited.
export const SLOTS = [
  { id: "morning", time: "08:00", until: "11:00" },
  { id: "lunch", time: "11:30", until: "14:30" },
  { id: "after_school", time: "15:30", until: "17:30" },
  { id: "evening", time: "19:30", until: "24:00" },
] as const;
// The days after day 0 that have posts (postPlan() in the Content Factory's scripts/lib/publish.mjs).
const LATER_DAYS = [1, 2, 4, 5];
const LOOK_BACK_DAYS = 56;
const PLATFORMS = ["instagram", "facebook", "linkedin", "tiktok", "youtube"];

/** Today's date and the time now in Eastern time, as "YYYY-MM-DD" and "HH:MM", the way people pick them. */
export function easternNow(at = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

const slotIndex = (time: string) => SLOTS.findIndex((s) => time < s.until);
export const slotOf = (time: string) => SLOTS[Math.max(slotIndex(time), 0)].id;
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** The rest of the week walks through the slots after day 0's, so one video's posts cover all of them. */
export function laterTimes(startTime: string) {
  const i = Math.max(slotIndex(startTime), 0);
  return Object.fromEntries(LATER_DAYS.map((day, n) => [String(day), SLOTS[(i + 1 + n) % SLOTS.length].time]));
}

/** The least used slot, and the soonest of the least used weekdays in the next 7 days, across this brand's recent videos. */
export async function suggestSchedule(env: Env, brand: string, campaign: string, at = new Date()) {
  const today = easternNow(at).date;
  const rows = await env.DB.prepare("SELECT start_date, start_time FROM posts WHERE brand = ? AND campaign != ? AND start_date >= ? AND start_time IS NOT NULL")
    .bind(brand, campaign, addDays(today, -LOOK_BACK_DAYS)).all<{ start_date: string; start_time: string }>();
  const slots = SLOTS.map(() => 0);
  const weekdays = Array.from({ length: 7 }, () => 0);
  for (const r of rows.results) {
    slots[Math.max(slotIndex(r.start_time), 0)]++;
    weekdays[weekdayOf(r.start_date)]++;
  }
  const slot = SLOTS[slots.indexOf(Math.min(...slots))];
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1));
  const fewest = Math.min(...days.map((d) => weekdays[weekdayOf(d)]));
  return { start: days.find((d) => weekdays[weekdayOf(d)] === fewest)!, startTime: slot.time, slot: slot.id };
}

/** Store ads skip the goal step, so they count as sell. */
export const goalOf = (spec: { goal?: unknown } | null | undefined) => (GOALS as readonly unknown[]).includes(spec?.goal) ? String(spec!.goal) : "sell";

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const whole = (v: unknown) => { const n = count(v); return n === null ? null : Math.round(n); };

interface PublishedJob { id: string; brand: string; payload: string }
interface PostedRow { source_job: string; start_date: string | null; start_time: string | null; suggested_start: string | null; suggested_time: string | null }

/** A publish job finished: one row per post, from the video's spec and what the desktop reports. */
export async function saveFeatures(env: Env, j: PublishedJob, result: { posted?: unknown; video?: unknown }) {
  if (!Array.isArray(result.posted)) return;
  const campaign = String(JSON.parse(j.payload).campaign ?? "");
  const post = await env.DB.prepare("SELECT source_job, start_date, start_time, suggested_start, suggested_time FROM posts WHERE task_job = ?").bind(j.id).first<PostedRow>();
  if (!post) return;
  const build = await env.DB.prepare("SELECT payload FROM jobs WHERE kind = 'build' AND brand = ? AND json_extract(payload, '$.campaign') = ? ORDER BY created_at DESC LIMIT 1")
    .bind(j.brand, campaign).first<{ payload: string }>();
  const spec = build ? JSON.parse(build.payload).spec ?? {} : {};
  const video = (result.video && typeof result.video === "object" ? result.video : {}) as { seconds?: unknown; captionStyle?: unknown };
  const timeSource = post.start_date === post.suggested_start && post.start_time === post.suggested_time ? "rotation" : "picked";
  const t = now();
  const rows = result.posted.slice(0, 50).flatMap((x: Record<string, unknown>) => {
    const key = text(x?.key, 60)?.split(":")[0];
    const platform = text(x?.platform, 20);
    if (!key || !platform || !PLATFORMS.includes(platform)) return [];
    const when = typeof x.scheduleDate === "string" && !Number.isNaN(Date.parse(x.scheduleDate)) ? new Date(x.scheduleDate) : null;
    const eastern = when ? easternNow(when) : null;
    return [env.DB.prepare(
      `INSERT OR REPLACE INTO post_features (campaign, item_key, platform, job_id, brand, post_type, day_offset, template, goal, audience, hook_text, length_seconds, presenter, presenter_mode, look, caption_style, scheduled_at, slot, weekday, time_source, tracking_url, ghl_post_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      campaign, key, platform, post.source_job, j.brand, text(x.type, 20), whole(x.day), text(spec.template, 40), goalOf(spec), text(spec.audience, 200),
      text(spec.hookText, 200) ?? text(spec.hook, 400), count(video.seconds), text(spec.presenter?.name, 80), text(spec.presenter?.mode, 20), text(spec.look, 40), text(video.captionStyle, 40),
      when?.toISOString() ?? null, eastern ? slotOf(eastern.time) : null, eastern ? weekdayOf(eastern.date) : null, timeSource, text(x.link, 1000), text(x.id, 100), t,
    )];
  });
  if (rows.length) await env.DB.batch(rows);
}

/** POST /api/desktop/stats: the desktop holds the platform keys, so it sends the numbers here. */
export async function putStats(req: Request, env: Env) {
  const b = await body<{ posts?: unknown; baselines?: unknown; accounts?: unknown }>(req);
  const posts = Array.isArray(b.posts) ? b.posts : [];
  const baselines = Array.isArray(b.baselines) ? b.baselines : [];
  const accounts = Array.isArray(b.accounts) ? b.accounts : [];
  if (posts.length + baselines.length + accounts.length > 500) throw new HttpError(400, "Send 500 rows at most at a time");
  const t = now();
  const need = (v: unknown, what: string, max = 100) => { const s = text(v, max); if (!s) throw new HttpError(400, `A row is missing ${what}`); return s; };
  const platformOf = (v: unknown) => { const s = need(v, "platform", 20); if (!PLATFORMS.includes(s)) throw new HttpError(400, `Unknown platform "${s}"`); return s; };
  const rows = [
    ...posts.map((x: Record<string, unknown>) => {
      const reading = need(x?.reading, "reading", 10);
      if (!["48h", "7d", "backfill"].includes(reading)) throw new HttpError(400, `Unknown reading "${reading}"`);
      return env.DB.prepare(
        `INSERT OR REPLACE INTO post_stats (source, post_id, reading, brand, platform, job_id, item_key, posted_at, read_at, views, watch_seconds, shares, comments, saves, link_clicks, new_followers, leads, orders, boosted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        need(x.source, "source", 40), need(x.postId, "postId"), reading, need(x.brand, "brand", 40), platformOf(x.platform), text(x.jobId, 36), text(x.itemKey, 60), text(x.postedAt, 40), t,
        whole(x.views), count(x.watchSeconds), whole(x.shares), whole(x.comments), whole(x.saves), whole(x.linkClicks), whole(x.newFollowers), whole(x.leads), whole(x.orders), x.boosted === true ? 1 : 0,
      );
    }),
    ...baselines.map((x: Record<string, unknown>) => {
      const asOf = need(x?.asOf, "asOf", 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new HttpError(400, "asOf is a date, YYYY-MM-DD");
      // The starting point stays what it was the first time, however many times this runs; only blanks get filled.
      return env.DB.prepare(
        `INSERT INTO platform_baseline (brand, platform, as_of, followers, avg_views, posts_counted, source, taken_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (brand, platform, as_of) DO UPDATE SET followers = COALESCE(followers, excluded.followers), avg_views = COALESCE(avg_views, excluded.avg_views), posts_counted = COALESCE(posts_counted, excluded.posts_counted)`,
      )
        .bind(need(x.brand, "brand", 40), platformOf(x.platform), asOf, whole(x.followers), count(x.avgViews), whole(x.postsCounted), need(x.source, "source", 40), t);
    }),
    ...accounts.map((x: Record<string, unknown>) => {
      const asOf = need(x?.asOf, "asOf", 10);
      return env.DB.prepare("INSERT OR REPLACE INTO account_stats (brand, as_of, source, raw, taken_at) VALUES (?, ?, ?, ?, ?)")
        .bind(need(x.brand, "brand", 40), asOf, need(x.source, "source", 40), JSON.stringify(x.raw ?? null).slice(0, 200000), t);
    }),
  ];
  if (rows.length) await env.DB.batch(rows);
  return json({ ok: true, posts: posts.length, baselines: baselines.length, accounts: accounts.length });
}
