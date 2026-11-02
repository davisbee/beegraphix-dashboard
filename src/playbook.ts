// The playbook: findings from the weekly report that an admin approved, so the factory leans toward what works.
//
// Approved hook rules, and template rules for the format being drafted, go into "Draft it for me" for that brand
// and goal. Time, day and platform rules are for whoever schedules posts. People still edit every draft, so a rule
// only steers it. Rejected findings stop showing as "worth a look"; a retired rule can be decided again.

import { HttpError, body, json, now, type Env } from "./common";
import type { Caller } from "./auth";
import { askedBrand, performanceData } from "./performance";

const GOALS = ["reach", "target", "sell"];
const DIMENSIONS = ["template", "hook", "slot", "weekday", "platform"];
const GOAL_NAMES: Record<string, string> = { reach: "Reach", target: "Target", sell: "Sell" };
const SLOT_NAMES: Record<string, string> = { morning: "Morning", lunch: "Lunch", after_school: "After school", evening: "Evening" };
const PLATFORM_NAMES: Record<string, string> = { facebook: "Facebook", instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn" };

export interface PlaybookRow {
  id: string; brand: string; goal: string; dimension: string; key: string; status: "approved" | "rejected" | "retired"; rule: string | null; note: string | null;
  score_at: number | null; posts_at: number | null; decided_by: string; decided_at: string; retired_by: string | null; retired_at: string | null;
}
type Goals = Awaited<ReturnType<typeof performanceData>>["goals"];

/** Where a finding stands in the rankings now, or null when its group has dropped out. */
export function scoreNow(goals: Goals, goal: string, dimension: string, key: string) {
  const r = (goals as Record<string, { ranks: Record<string, Array<{ key: string; score: number; posts: number; tooFew: boolean }>> }>)[goal]?.ranks?.[dimension]?.find((x) => x.key === key);
  return r ? { score: r.score, posts: r.posts, tooFew: r.tooFew } : null;
}

/** The line offered when a finding is approved. The admin can rewrite it. */
export function suggestedRule(goal: string, dimension: string, key: string, score: number) {
  const g = GOAL_NAMES[goal] ?? goal;
  const good = score >= 100;
  if (dimension === "hook") return good ? `Hooks like "${key}" work for ${g}. Open with the same kind of line.` : `Hooks like "${key}" fall flat for ${g}. Don't open that way.`;
  if (dimension === "template") return good ? `The ${key} format works for ${g}.` : `The ${key} format underperforms for ${g}.`;
  if (dimension === "slot") return `${SLOT_NAMES[key] ?? key} posts ${good ? "do well" : "do poorly"} for ${g}.`;
  if (dimension === "platform") return `${PLATFORM_NAMES[key] ?? key} ${good ? "does well" : "does poorly"} for ${g}.`;
  return `${key} posts ${good ? "do well" : "do poorly"} for ${g}.`;
}

/**
 * The brand's decisions ("*" = every brand). Empty, not an error, before migration 0013 is applied, so the weekly
 * report and Draft it for me keep working if the code goes out first.
 */
export async function playbookRows(env: Env, brand: string) {
  try {
    const q = brand === "*" ? env.DB.prepare("SELECT * FROM playbook ORDER BY decided_at DESC") : env.DB.prepare("SELECT * FROM playbook WHERE brand = ? ORDER BY decided_at DESC").bind(brand);
    return (await q.all<PlaybookRow>()).results;
  } catch (e) {
    console.error("playbook", e);
    return [];
  }
}

/** The lines Draft it for me adds for a brand, goal and format. */
export async function playbookPrompt(env: Env, brand: string, goal: string, formatName: string) {
  const rules = (await playbookRows(env, brand)).filter((r) => r.status === "approved" && r.goal === goal && r.rule && (r.dimension === "hook" || (r.dimension === "template" && r.key === formatName)));
  if (!rules.length) return "";
  return `What has worked for this brand, from its own posts. The team approved these, so follow them unless the notes say otherwise:\n${rules.reverse().map((r) => `- ${r.rule}`).join("\n")}`;
}

/** GET /api/playbook?brand= : every decision, with each rule's score now. */
export async function getPlaybook(env: Env, c: Caller, url: URL) {
  const brand = askedBrand(c, url);
  const [rows, perf] = await Promise.all([playbookRows(env, brand), performanceData(env, brand)]);
  return json({
    rules: rows.map((r) => ({ ...r, now: scoreNow(perf.goals, r.goal, r.dimension, r.key) })),
    canEdit: c.admin && brand !== "*",
  });
}

const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** POST /api/playbook {brand, goal, dimension, key, decision: approve | reject, rule?, note?}: an admin decides a finding. */
export async function decide(req: Request, env: Env, c: Caller) {
  if (!c.admin) throw new HttpError(403, "Only an admin can change the playbook.");
  const b = await body<{ brand?: string; goal?: string; dimension?: string; key?: string; decision?: string; rule?: string; note?: string }>(req);
  const brand = text(b.brand, 40) ?? c.brand;
  if (brand === "*") throw new HttpError(400, "Pick a brand first. The playbook is per brand.");
  if (c.brand !== "*" && brand !== c.brand) throw new HttpError(404, "Not found");
  const goal = String(b.goal ?? ""), dimension = String(b.dimension ?? ""), key = text(b.key, 400);
  if (!GOALS.includes(goal) || !DIMENSIONS.includes(dimension) || !key) throw new HttpError(400, "That isn't a finding.");
  if (b.decision !== "approve" && b.decision !== "reject") throw new HttpError(400, "Approve or reject it.");
  const at = scoreNow((await performanceData(env, brand)).goals, goal, dimension, key);
  if (!at || at.tooFew) throw new HttpError(400, "That finding isn't in the numbers anymore. Reload This Week.");
  const approve = b.decision === "approve";
  const rule = approve ? text(b.rule, 300) ?? suggestedRule(goal, dimension, key, at.score) : null;
  if (rule?.includes(String.fromCharCode(8212))) throw new HttpError(400, "No em dashes. Use a period, comma or colon.");
  await env.DB.prepare(
    `INSERT INTO playbook (id, brand, goal, dimension, key, status, rule, note, score_at, posts_at, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (brand, goal, dimension, key) DO UPDATE SET status = excluded.status, rule = excluded.rule, note = excluded.note, score_at = excluded.score_at,
       posts_at = excluded.posts_at, decided_by = excluded.decided_by, decided_at = excluded.decided_at, retired_by = NULL, retired_at = NULL`,
  ).bind(crypto.randomUUID(), brand, goal, dimension, key, approve ? "approved" : "rejected", rule, text(b.note, 300), at.score, at.posts, c.label, now()).run();
  return json({ ok: true, status: approve ? "approved" : "rejected", rule });
}

/** POST /api/playbook/<id>/retire: an approved rule that stopped holding up leaves Draft it for me. A rejected one is set aside the same way, so it can show as a finding again. */
export async function retire(env: Env, c: Caller, id: string) {
  if (!c.admin) throw new HttpError(403, "Only an admin can change the playbook.");
  const r = await env.DB.prepare(`UPDATE playbook SET status = 'retired', retired_by = ?, retired_at = ? WHERE id = ? AND status IN ('approved', 'rejected')${c.brand === "*" ? "" : " AND brand = ?"}`)
    .bind(c.label, now(), id, ...(c.brand === "*" ? [] : [c.brand])).run();
  if (!r.meta.changes) throw new HttpError(404, "Not found");
  return json({ ok: true });
}
