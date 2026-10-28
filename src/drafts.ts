// Drafts: a New video someone saved to finish later, usually because the footage isn't filmed yet.
// The form is kept as the browser sent it; nothing in it is checked until someone presses Build.

import { HttpError, json, now, type Env } from "./common";
import type { Caller } from "./auth";
import { formatOf } from "./formats";

const MAX_BYTES = 200_000;
const MAX_DRAFTS = 200; // per brand

interface DraftRow { id: string; brand: string; title: string; template: string; data: string; created_by: string; updated_by: string; created_at: string; updated_at: string }

const who = (c: Caller) => c.user?.name || c.label;

const summary = (d: DraftRow) => ({
  id: d.id, brand: d.brand, title: d.title, template: d.template, format: formatOf(d.template)?.name ?? d.template,
  createdBy: d.created_by, updatedBy: d.updated_by, createdAt: d.created_at, updatedAt: d.updated_at,
});

/** The title and data from a save, checked for size. */
async function readSave(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BYTES) throw new HttpError(413, "That draft is too big to save");
  let b: { title?: unknown; data?: unknown };
  try { b = JSON.parse(raw); } catch { throw new HttpError(400, "Body must be JSON"); }
  if (!b.data || typeof b.data !== "object" || Array.isArray(b.data)) throw new HttpError(400, "data must be the New video form");
  const data = b.data as Record<string, unknown>;
  const template = formatOf(data.template)?.id;
  if (!template) throw new HttpError(400, "Unknown format");
  const title = String(b.title ?? "").trim().slice(0, 120) || "Untitled video";
  return { title, template, data: JSON.stringify(data) };
}

async function visibleDraft(env: Env, c: Caller, id: string) {
  const d = await env.DB.prepare("SELECT * FROM drafts WHERE id = ?").bind(id).first<DraftRow>();
  if (!d || (c.brand !== "*" && d.brand !== c.brand)) throw new HttpError(404, "Draft not found");
  return d;
}

export async function listDrafts(env: Env, brand: string) {
  const { results } = await env.DB.prepare("SELECT * FROM drafts WHERE brand = ? ORDER BY updated_at DESC LIMIT 100").bind(brand).all<DraftRow>();
  return json({ drafts: results.map(summary) });
}

export async function getDraft(env: Env, c: Caller, id: string) {
  const d = await visibleDraft(env, c, id);
  return json({ draft: { ...summary(d), data: JSON.parse(d.data) } });
}

export async function createDraft(req: Request, env: Env, c: Caller, brand: string) {
  const s = await readSave(req);
  const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM drafts WHERE brand = ?").bind(brand).first<number>("n");
  if ((n ?? 0) >= MAX_DRAFTS) throw new HttpError(409, `There are already ${MAX_DRAFTS} drafts. Delete some old ones first.`);
  const id = crypto.randomUUID();
  const t = now();
  await env.DB.prepare("INSERT INTO drafts (id, brand, title, template, data, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, brand, s.title, s.template, s.data, who(c), who(c), t, t).run();
  return json({ draft: summary((await visibleDraft(env, c, id))) }, 201);
}

export async function updateDraft(req: Request, env: Env, c: Caller, id: string) {
  await visibleDraft(env, c, id);
  const s = await readSave(req);
  await env.DB.prepare("UPDATE drafts SET title = ?, template = ?, data = ?, updated_by = ?, updated_at = ? WHERE id = ?")
    .bind(s.title, s.template, s.data, who(c), now(), id).run();
  return json({ draft: summary(await visibleDraft(env, c, id)) });
}

export async function deleteDraft(env: Env, c: Caller, id: string) {
  await visibleDraft(env, c, id);
  await env.DB.prepare("DELETE FROM drafts WHERE id = ?").bind(id).run();
  return json({ ok: true });
}
