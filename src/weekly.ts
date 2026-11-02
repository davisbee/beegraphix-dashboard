// The weekly report: how the last 7 days went. The Performance tab shows it under This week, and the cron emails it
// to WEEKLY_REPORT_TO every Monday morning, right after the YouTube pull.
//
// It only reads what's already saved: post_stats, post_features, link_events, platform_baseline and HighLevel's
// 7 day account_stats. Its findings are suggestions: an admin approves or rejects each for the playbook (playbook.ts).

import { HttpError, json, type Env } from "./common";
import type { Caller } from "./auth";
import { askedBrand, performanceData, type ScoredPost } from "./performance";
import { playbookRows, scoreNow, suggestedRule } from "./playbook";

const DAY = 86400_000;
const PLATFORMS = ["facebook", "instagram", "tiktok", "youtube", "linkedin"];
// A group this far from typical (100), with enough posts to trust, is worth a look.
const HIGH = 120;
const LOW = 80;
const FINDING_DIMENSIONS = ["template", "hook", "slot", "weekday", "platform"];
// The emailed link goes to the dashboard's own address (wrangler.jsonc routes).
const APP_URL = "https://contentfactory.shopbgx.com";

export interface WeeklyPost { job: string; label: string; platform: string; goal: string; score: number; reading: "48h" | "7d" | null; scheduledAt: string | null }

/** The report for a brand ("*" = every brand), for the 7 days up to `at`. */
export async function weeklyReport(env: Env, brand: string, at = Date.now()) {
  const from = new Date(at - 7 * DAY).toISOString();
  const to = new Date(at).toISOString();
  const nextWeek = new Date(at + 7 * DAY).toISOString();
  const all = brand === "*";
  const and = (col = "brand") => (all ? "" : ` AND ${col} = ?`);
  const b = all ? [] : [brand];
  const [perf, decisions, [posted, links, coming, accounts]] = await Promise.all([
    performanceData(env, brand),
    playbookRows(env, brand),
    env.DB.batch([
      env.DB.prepare(`SELECT platform, source, post_id, views, read_at FROM post_stats WHERE posted_at >= ? AND posted_at < ? AND reading != 'backfill'${and()}`).bind(from, to, ...b),
      // Counts are lifetime, so a video shows here if anyone clicked or asked for a quote this week.
      env.DB.prepare(
        `SELECT e.job_id, COALESCE(json_extract(j.payload, '$.title'), json_extract(j.payload, '$.campaign')) AS title,
           SUM(CASE WHEN e.event = 'click' THEN e.count ELSE 0 END) AS clicks, SUM(CASE WHEN e.event = 'lead' THEN e.count ELSE 0 END) AS leads
         FROM link_events e JOIN jobs j ON j.id = e.job_id
         WHERE e.job_id IN (SELECT job_id FROM link_events WHERE last_at >= ?)${and("j.brand")}
         GROUP BY e.job_id ORDER BY leads DESC, clicks DESC LIMIT 10`,
      ).bind(from, ...b),
      // Posts going out next week, and this week's posts, which turn 7 days old next week and get their final read.
      env.DB.prepare(
        `SELECT platform, SUM(scheduled_at >= ?) AS going_out, SUM(scheduled_at < ? AND boosted = 0) AS final_reads
         FROM post_features WHERE scheduled_at >= ? AND scheduled_at < ?${and()} GROUP BY platform`,
      ).bind(to, to, from, nextWeek, ...b),
      env.DB.prepare(`SELECT raw FROM account_stats WHERE source = 'highlevel' AND as_of >= ?${and()} ORDER BY as_of DESC LIMIT 1`).bind(from.slice(0, 10), ...b),
    ]),
  ]);

  // Each post's newest reading so far.
  const newest = new Map<string, { platform: string; views: number | null; read_at: string }>();
  for (const r of posted.results as Array<{ platform: string; source: string; post_id: string; views: number | null; read_at: string }>) {
    const k = `${r.source}|${r.post_id}`;
    if (!newest.has(k) || newest.get(k)!.read_at < r.read_at) newest.set(k, r);
  }
  let hl: any = null;
  try { hl = JSON.parse((accounts.results[0] as { raw: string } | undefined)?.raw ?? "null")?.results ?? null; } catch { /* kept as HighLevel sent it; unreadable means no numbers */ }
  const platforms = PLATFORMS.map((platform) => {
    const ours = [...newest.values()].filter((r) => r.platform === platform);
    const views = ours.map((r) => r.views).filter((v): v is number => typeof v === "number");
    const start = perf.baseline.filter((x) => x.platform === platform).at(-1);
    const n = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : null);
    return {
      platform,
      posts: n(hl?.breakdowns?.posts?.platforms?.[platform]?.value) ?? (ours.length || null),
      avgViews: views.length ? Math.round(views.reduce((a, c) => a + c, 0) / views.length) : null,
      startViews: start?.avg_views === null || start?.avg_views === undefined ? null : Math.round(start.avg_views),
      startFollowers: start?.followers ?? null,
      newFollowers: n(hl?.platformTotals?.followers?.[platform]?.total),
      reach: n(hl?.breakdowns?.reach?.platforms?.[platform]?.value),
    };
  }).filter((p) => p.posts || p.avgViews !== null || p.newFollowers || p.reach);

  // Best and weakest: posts from the last 2 weeks with a score, so this week's final 7 day reads are in.
  const since = at - 14 * DAY;
  const scored = perf.posts
    .filter((p): p is ScoredPost & { score: number } => typeof p.score === "number" && !!p.scheduledAt && Date.parse(p.scheduledAt) >= since)
    .sort((x, y) => y.score - x.score)
    .map((p): WeeklyPost => ({ job: p.job, label: p.hook || p.campaign, platform: p.platform, goal: p.goal, score: p.score, reading: p.reading, scheduledAt: p.scheduledAt }));
  const best = scored.slice(0, 3);
  const worst = scored.slice(3).slice(-3).reverse();

  // Already approved or rejected: no need to ask again. A retired rule can come back.
  const decided = new Set(decisions.filter((d) => d.status !== "retired").map((d) => `${d.goal}|${d.dimension}|${d.key}`));
  const findings = Object.entries(perf.goals).flatMap(([goal, g]) => FINDING_DIMENSIONS.flatMap((dimension) => {
    const trusted = (g.ranks[dimension] ?? []).filter((r) => !r.tooFew);
    if (trusted.length < 2) return []; // nothing to compare it with
    return trusted.filter((r) => (r.score >= HIGH || r.score <= LOW) && !decided.has(`${goal}|${dimension}|${r.key}`))
      .map((r) => ({ goal, dimension, key: r.key, score: r.score, posts: r.posts, rule: suggestedRule(goal, dimension, r.key, r.score) }));
  })).sort((x, y) => Math.abs(y.score - 100) - Math.abs(x.score - 100)).slice(0, 6);

  // The playbook: what was approved this week, and approved rules whose score has crossed back over 100.
  const approved = decisions.filter((d) => d.status === "approved" && d.rule);
  const playbook = {
    added: approved.filter((d) => d.decided_at >= from).map((d) => ({ rule: d.rule!, by: d.decided_by })),
    slipping: approved.flatMap((d) => {
      const at = scoreNow(perf.goals, d.goal, d.dimension, d.key);
      if (!at || at.tooFew || d.score_at === null || (d.score_at >= 100) === (at.score >= 100)) return [];
      return [{ id: d.id, rule: d.rule!, scoreAt: d.score_at, scoreNow: at.score }];
    }),
  };

  const next = coming.results as Array<{ platform: string; going_out: number | null; final_reads: number | null }>;
  return {
    brand, from, to, lastPull: perf.lastPull, platforms, best, worst, findings, playbook,
    links: (links.results as Array<{ job_id: string; title: string | null; clicks: number; leads: number }>).map((l) => ({ job: l.job_id, title: l.title ?? "A video", clicks: l.clicks, leads: l.leads })),
    goingOut: next.reduce((a, r) => a + (r.going_out ?? 0), 0),
    finalReads: next.reduce((a, r) => a + (r.final_reads ?? 0), 0),
  };
}
type Report = Awaited<ReturnType<typeof weeklyReport>>;

/** GET /api/performance/weekly?brand= */
export async function getWeekly(env: Env, c: Caller, url: URL) {
  const r = await weeklyReport(env, askedBrand(c, url));
  return json({ ...r, recipients: c.admin ? recipients(env) : [] });
}

/** POST /api/performance/weekly/send: an admin sends this week's email now, to the same people the Monday one goes to. */
export async function sendWeeklyNow(env: Env, c: Caller) {
  if (!c.admin) throw new HttpError(403, "Only an admin can send the weekly report.");
  return json({ sent: await sendWeekly(env) });
}

const recipients = (env: Env) => (env.WEEKLY_REPORT_TO ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Emails the BeeGraphix report. Returns who it went to. */
export async function sendWeekly(env: Env, at = Date.now()) {
  const to = recipients(env);
  if (!env.RESEND_API_KEY || !to.length) throw new HttpError(503, "The weekly email isn't set up. It needs RESEND_API_KEY and WEEKLY_REPORT_TO.");
  const r = await weeklyReport(env, "beegraphix", at);
  const res = await fetch(`${env.RESEND_BASE_URL ?? "https://api.resend.com"}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.EMAIL_FROM || "Content Factory <noreply@shopbgx.com>", to, subject: `BeeGraphix this week: ${span(r)}`, text: emailText(r), html: emailHtml(r) }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return to;
}

// ---------- The email. Brand voice: short sentences, no em dashes, no bullet points in emails. ----------

const GOALS: Record<string, string> = { reach: "Reach", target: "Target", sell: "Sell" };
const NAMES: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn" };
const SLOTS: Record<string, string> = { morning: "Morning", lunch: "Lunch", after_school: "After school", evening: "Evening" };
const DIMENSIONS: Record<string, string> = { template: "Template", hook: "Hook", slot: "Time of day", weekday: "Day", platform: "Platform" };
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
const span = (r: Report) => `${day(r.from)} to ${day(new Date(Date.parse(r.to) - 1).toISOString())}`;
const num = (v: number | null) => (v === null ? "" : v.toLocaleString("en-US"));
const read = (p: WeeklyPost) => (p.reading === "7d" ? "final" : "48 hours");
// Templates already rank by their name.
const keyName = (dimension: string, key: string) => (dimension === "slot" ? SLOTS[key] ?? key : dimension === "platform" ? NAMES[key] ?? key : key);

/** One line per finding, the same words on the This week view. */
export function findingLine(f: Report["findings"][number]) {
  return `${DIMENSIONS[f.dimension]} "${keyName(f.dimension, f.key)}" scored ${f.score} for ${GOALS[f.goal] ?? f.goal} over ${f.posts} posts. Typical is 100.`;
}

function emailText(r: Report) {
  const lines = [`Here's how ${span(r)} went. Every post is on the Performance tab: ${APP_URL}/#/week`, ""];
  lines.push("PLATFORMS");
  if (!r.platforms.length) lines.push("Nothing posted or read this week.");
  for (const p of r.platforms) lines.push(`${NAMES[p.platform]}: ${p.posts ?? 0} posts, ${p.avgViews === null ? "no views read yet" : `${num(p.avgViews)} average views so far`}${p.startViews === null ? "" : ` (${num(p.startViews)} before)`}, ${p.newFollowers ?? 0} new followers.`);
  lines.push("", "BEST POSTS");
  if (!r.best.length) lines.push("No post has a score yet. Scores start 48 hours after a video goes out through Approve and Post.");
  for (const p of r.best) lines.push(`${p.score}: ${p.label} (${NAMES[p.platform] ?? p.platform}, ${GOALS[p.goal] ?? p.goal}, ${read(p)})`);
  if (r.worst.length) { lines.push("", "WEAKEST POSTS"); for (const p of r.worst) lines.push(`${p.score}: ${p.label} (${NAMES[p.platform] ?? p.platform}, ${GOALS[p.goal] ?? p.goal}, ${read(p)})`); }
  lines.push("", "CLICKS AND LEADS");
  if (!r.links.length) lines.push("No clicks on a tracked link this week.");
  for (const l of r.links) lines.push(`${l.title}: ${l.clicks} clicks, ${l.leads} leads`);
  lines.push("", "NEXT WEEK", nextWeek(r), "", "WORTH A LOOK");
  if (!r.findings.length) lines.push(NO_FINDINGS);
  else lines.push(...r.findings.map(findingLine), "", FINDINGS_NOTE);
  if (r.playbook.added.length || r.playbook.slipping.length) {
    lines.push("", "PLAYBOOK", ...r.playbook.added.map((x) => `Approved this week: ${x.rule}`), ...r.playbook.slipping.map(slipLine));
  }
  return lines.join("\n");
}

const slipLine = (x: Report["playbook"]["slipping"][number]) => `No longer holding up: ${x.rule} It scored ${x.scoreAt} when it was approved and ${x.scoreNow} now. Retire it on the Playbook page if that sticks.`;
const NO_FINDINGS = "Nothing yet. A finding needs at least 3 posts with a final 7 day score in each group it compares.";
const FINDINGS_NOTE = "These are hunches, not rules. Approve or reject each one on the This Week page. Approved hooks and formats steer Draft It For Me.";
const nextWeek = (r: Report) => `${r.goingOut} ${r.goingOut === 1 ? "post goes" : "posts go"} out, and ${r.finalReads} ${r.finalReads === 1 ? "post gets its" : "posts get their"} final 7 day read.`;

function emailHtml(r: Report) {
  const esc = (x: unknown) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const h = (t: string) => `<h3 style="font-size:16px;margin:28px 0 8px">${esc(t)}</h3>`;
  const p = (t: string) => `<p style="margin:0 0 10px">${esc(t)}</p>`;
  const cell = "padding:6px 10px;border-bottom:1px solid #e6e6e6;text-align:left";
  const table = (head: string[], rows: unknown[][]) => `<table style="border-collapse:collapse;font-size:14px;width:100%"><tr>${head.map((x) => `<th style="${cell};color:#6b6b6b;font-weight:normal">${esc(x)}</th>`).join("")}</tr>${rows.map((row) => `<tr>${row.map((x) => `<td style="${cell}">${esc(x)}</td>`).join("")}</tr>`).join("")}</table>`;
  const posts = (list: WeeklyPost[]) => table(["Post", "Platform", "Goal", "Score"], list.map((x) => [x.label, NAMES[x.platform] ?? x.platform, GOALS[x.goal] ?? x.goal, `${x.score} (${read(x)})`]));
  return `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:24px;color:#1d1d1f;max-width:620px">
${p(`Here's how ${span(r)} went. A score of 100 is a typical post for its goal.`)}
${h("Platforms")}${r.platforms.length ? table(["Platform", "Posts", "Average views so far", "Before", "New followers"], r.platforms.map((x) => [NAMES[x.platform], num(x.posts), num(x.avgViews), num(x.startViews), num(x.newFollowers)])) : p("Nothing posted or read this week.")}
${h("Best posts")}${r.best.length ? posts(r.best) : p("No post has a score yet. Scores start 48 hours after a video goes out through Approve and Post.")}
${r.worst.length ? `${h("Weakest posts")}${posts(r.worst)}` : ""}
${h("Clicks and leads")}${r.links.length ? table(["Video", "Clicks", "Leads"], r.links.map((l) => [l.title, l.clicks, l.leads])) : p("No clicks on a tracked link this week.")}
${h("Next week")}${p(nextWeek(r))}
${h("Worth a look")}${r.findings.length ? r.findings.map((f) => p(findingLine(f))).join("") + `<p style="margin:0 0 10px;color:#6b6b6b;font-size:14px">${esc(FINDINGS_NOTE)}</p>` : p(NO_FINDINGS)}
${r.playbook.added.length || r.playbook.slipping.length ? h("Playbook") + r.playbook.added.map((x) => p(`Approved this week: ${x.rule}`)).join("") + r.playbook.slipping.map((x) => p(slipLine(x))).join("") : ""}
<p style="margin:32px 0"><a href="${APP_URL}/#/week" style="background:#F9B023;color:#1d1d1f;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;display:inline-block">See the Whole Week</a></p></div>`;
}
