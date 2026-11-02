// The Performance tab: scores each post against its goal and ranks what's working, one goal at a time.
//
// A score of 100 is a typical post. Each number is compared with the median of the posts it competes with, then
// the goal's numbers are averaged. Rankings use final 7 day reads only, and paid posts never count.

import { HttpError, body, json, now, type Env } from "./common";
import type { Caller } from "./auth";
import { formatOf } from "./formats";

export const SCORECARDS = {
  reach: ["watchSeconds", "shares", "newFollowers"],
  target: ["comments", "saves", "linkClicks"],
  sell: ["linkClicks", "leads", "orders"],
} as const;
type Goal = keyof typeof SCORECARDS;
export type Metric = (typeof SCORECARDS)[Goal][number];
type Numbers = Partial<Record<Metric, number | null>>;

export interface ScoredPost {
  job: string; campaign: string; itemKey: string; platform: string; brand: string; goal: string; template: string | null; hook: string | null;
  slot: string | null; weekday: number | null; scheduledAt: string | null; boosted: boolean; reading: "48h" | "7d" | null; views: number | null; numbers: Numbers; score?: number | null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DIMENSIONS: Array<[string, (p: ScoredPost) => string | null, boolean]> = [
  // The last value: compare across platforms. Otherwise each post only competes on its own platform,
  // so Facebook's bigger audience doesn't decide which template or hook wins.
  ["template", (p) => (p.template ? formatOf(p.template)?.name ?? p.template : null), false],
  ["hook", (p) => p.hook, false],
  ["slot", (p) => p.slot, false],
  ["weekday", (p) => (p.weekday === null ? null : WEEKDAYS[p.weekday]), false],
  ["platform", (p) => p.platform, true],
  ["brand", (p) => p.brand, true],
];
const TOO_FEW = 3;

function median(values: number[]) {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** 100 is typical for the group. The +1 keeps a group whose median is 0 from dividing by nothing. */
function scoreAll(posts: ScoredPost[], groupOf: (p: ScoredPost) => string) {
  const out = new Map<ScoredPost, number>();
  const groups = new Map<string, ScoredPost[]>();
  for (const p of posts) groups.set(groupOf(p), [...(groups.get(groupOf(p)) ?? []), p]);
  for (const group of groups.values()) {
    const typical = new Map<Metric, number>();
    for (const m of new Set(group.flatMap((p) => SCORECARDS[p.goal as Goal]))) {
      const values = group.map((p) => p.numbers[m]).filter((v): v is number => typeof v === "number");
      if (values.length) typical.set(m, median(values));
    }
    for (const p of group) {
      const parts = SCORECARDS[p.goal as Goal].flatMap((m) => {
        const v = p.numbers[m];
        return typeof v === "number" ? [(v + 1) / (typical.get(m)! + 1)] : [];
      });
      if (parts.length) out.set(p, Math.round((100 * parts.reduce((a, b) => a + b, 0)) / parts.length));
    }
  }
  return out;
}

/** The scorecards for a set of posts. Goals are never compared with each other. */
export function scorecards(posts: ScoredPost[]) {
  const organic = posts.filter((p) => !p.boosted && p.reading && p.goal in SCORECARDS);
  const own = scoreAll(organic, (p) => `${p.goal}|${p.platform}|${p.reading}`);
  for (const p of posts) p.score = own.get(p) ?? null;
  const goals = Object.fromEntries((Object.keys(SCORECARDS) as Goal[]).map((goal) => {
    const final = organic.filter((p) => p.goal === goal && p.reading === "7d");
    const across = scoreAll(final, () => "all");
    const totals = Object.fromEntries(SCORECARDS[goal].map((m) => {
      const values = final.map((p) => p.numbers[m]).filter((v): v is number => typeof v === "number");
      return [m, values.length ? values.reduce((a, b) => a + b, 0) : null];
    }));
    const ranks = Object.fromEntries(DIMENSIONS.map(([name, keyOf, wide]) => {
      const groups = new Map<string, number[]>();
      for (const p of final) {
        const key = keyOf(p);
        const score = (wide ? across : own).get(p);
        if (key && score !== undefined) groups.set(key, [...(groups.get(key) ?? []), score]);
      }
      return [name, [...groups].map(([key, s]) => ({ key, score: Math.round(s.reduce((a, b) => a + b, 0) / s.length), posts: s.length, tooFew: s.length < TOO_FEW })).sort((a, b) => b.score - a.score)];
    }));
    return [goal, { metrics: SCORECARDS[goal], finalPosts: final.length, earlyPosts: organic.filter((p) => p.goal === goal && p.reading === "48h").length, totals, ranks }];
  }));
  return { goals };
}

interface FeatureRow { job_id: string; campaign: string; item_key: string; platform: string; brand: string; goal: string; template: string | null; hook_text: string | null; slot: string | null; weekday: number | null; scheduled_at: string | null; boosted: number }
interface StatRow { job_id: string; platform: string; item_key: string; reading: string; views: number | null; watch_seconds: number | null; shares: number | null; comments: number | null; saves: number | null; new_followers: number | null; orders: number | null; leads: number | null; link_clicks: number | null; boosted: number }

/** GET /api/performance?brand= : a brand, or everything for someone who can see every brand. */
export async function getPerformance(env: Env, c: Caller, url: URL) {
  const asked = url.searchParams.get("brand") || c.brand;
  if (c.brand !== "*" && asked !== c.brand) throw new HttpError(404, "Not found");
  const where = asked === "*" ? "" : " WHERE brand = ?";
  const bind = asked === "*" ? [] : [asked];
  const [features, stats, events, baseline, pulled] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM post_features${where} ORDER BY scheduled_at DESC`).bind(...bind),
    env.DB.prepare(`SELECT * FROM post_stats${where ? `${where} AND` : " WHERE"} job_id IS NOT NULL`).bind(...bind),
    env.DB.prepare("SELECT job_id, platform, item_key, event, count FROM link_events"),
    env.DB.prepare(`SELECT brand, platform, as_of, followers, avg_views FROM platform_baseline${where} ORDER BY as_of`).bind(...bind),
    env.DB.prepare(`SELECT MAX(read_at) AS at FROM post_stats${where}`).bind(...bind),
  ]);
  const key = (job: unknown, platform: unknown, item: unknown) => `${job}|${platform}|${item}`;
  const reads = new Map<string, StatRow>();
  for (const s of stats.results as unknown as StatRow[]) reads.set(`${key(s.job_id, s.platform, s.item_key)}|${s.reading}`, s);
  const hits = new Map<string, number>();
  for (const e of events.results as unknown as Array<{ job_id: string; platform: string; item_key: string; event: string; count: number }>) hits.set(`${key(e.job_id, e.platform, e.item_key)}|${e.event}`, e.count);
  const at = Date.now();
  const posts = (features.results as unknown as FeatureRow[]).map((f): ScoredPost => {
    const k = key(f.job_id, f.platform, f.item_key);
    const s7 = reads.get(`${k}|7d`), s48 = reads.get(`${k}|48h`);
    const age = f.scheduled_at ? at - Date.parse(f.scheduled_at) : 0;
    const reading = s7 ? "7d" : s48 ? "48h" : age >= 7 * 86400_000 ? "7d" : age >= 2 * 86400_000 ? "48h" : null;
    const s = s7 ?? s48;
    return {
      job: f.job_id, campaign: f.campaign, itemKey: f.item_key, platform: f.platform, brand: f.brand, goal: f.goal, template: f.template, hook: f.hook_text,
      slot: f.slot, weekday: f.weekday, scheduledAt: f.scheduled_at, boosted: !!f.boosted || !!s?.boosted, reading, views: s?.views ?? null,
      numbers: {
        watchSeconds: s?.watch_seconds ?? null, shares: s?.shares ?? null, newFollowers: s?.new_followers ?? null, comments: s?.comments ?? null, saves: s?.saves ?? null,
        // The landing pages count these themselves, for every platform. A page that can't (a program's own page) has none.
        linkClicks: hits.get(`${k}|click`) ?? s?.link_clicks ?? null, leads: hits.get(`${k}|lead`) ?? s?.leads ?? null, orders: s?.orders ?? null,
      },
    };
  });
  return json({ ...scorecards(posts), posts: posts.slice(0, 200), baseline: baseline.results, lastPull: (pulled.results[0] as { at: string | null } | undefined)?.at ?? null, canMark: c.admin });
}

/** POST /api/performance/boosted {job, platform, itemKey, boosted}: an admin marks a post as paid. */
export async function markBoosted(req: Request, env: Env, c: Caller) {
  if (!c.admin) throw new HttpError(403, "Only an admin can mark a post as boosted.");
  const b = await body<{ job?: string; platform?: string; itemKey?: string; boosted?: boolean }>(req);
  const f = await env.DB.prepare("SELECT brand FROM post_features WHERE job_id = ? AND platform = ? AND item_key = ?").bind(String(b.job), String(b.platform), String(b.itemKey)).first<{ brand: string }>();
  if (!f || (c.brand !== "*" && f.brand !== c.brand)) throw new HttpError(404, "Post not found");
  await env.DB.prepare("UPDATE post_features SET boosted = ? WHERE job_id = ? AND platform = ? AND item_key = ?").bind(b.boosted ? 1 : 0, String(b.job), String(b.platform), String(b.itemKey)).run();
  return json({ ok: true });
}

/** POST /api/t: a landing page reports a visit or quote request. No sign-in, so only known tracking links count. */
export async function linkEvent(req: Request, env: Env) {
  let b: { id?: unknown; source?: unknown; content?: unknown; event?: unknown } = {};
  try { b = JSON.parse((await req.text()).slice(0, 1000)); } catch { /* ignored below */ }
  const { id, source, content, event } = b;
  if (typeof id === "string" && typeof source === "string" && typeof content === "string" && (event === "click" || event === "lead")
    && await env.DB.prepare("SELECT 1 FROM post_features WHERE job_id = ? AND platform = ? AND item_key = ?").bind(id, source, content).first()) {
    const t = now();
    await env.DB.prepare("INSERT INTO link_events (job_id, platform, item_key, event, count, last_at) VALUES (?, ?, ?, ?, 1, ?) ON CONFLICT (job_id, platform, item_key, event) DO UPDATE SET count = count + 1, last_at = excluded.last_at")
      .bind(id, source, content, event, t).run();
  }
  return new Response(null, { status: 204 });
}

/** GET /api/desktop/stats/due: posts whose 48 hour or 7 day read hasn't come in. After 30 days it stops asking. TikTok's video and LinkedIn's images are saved as posts, not reels. */
export async function statsDue(env: Env) {
  const rows = await env.DB.prepare(
    `SELECT f.job_id, f.platform, f.item_key, f.brand, f.scheduled_at, f.ghl_post_id,
       EXISTS (SELECT 1 FROM post_stats s WHERE s.job_id = f.job_id AND s.platform = f.platform AND s.item_key = f.item_key AND s.reading = '48h') AS has48,
       EXISTS (SELECT 1 FROM post_stats s WHERE s.job_id = f.job_id AND s.platform = f.platform AND s.item_key = f.item_key AND s.reading = '7d') AS has7
     FROM post_features f WHERE ((f.post_type = 'reel' AND f.platform IN ('facebook', 'instagram')) OR f.platform IN ('tiktok', 'linkedin')) AND f.scheduled_at IS NOT NULL`,
  ).all<{ job_id: string; platform: string; item_key: string; brand: string; scheduled_at: string; ghl_post_id: string | null; has48: number; has7: number }>();
  const at = Date.now();
  const due = rows.results.flatMap((r) => {
    const age = at - Date.parse(r.scheduled_at);
    if (age > 30 * 86400_000) return [];
    const reading = age >= 7 * 86400_000 ? (r.has7 ? null : "7d") : age >= 2 * 86400_000 && !r.has48 ? "48h" : null;
    return reading ? [{ jobId: r.job_id, platform: r.platform, itemKey: r.item_key, brand: r.brand, scheduledAt: r.scheduled_at, ghlPostId: r.ghl_post_id, reading }] : [];
  });
  return json({ due });
}
