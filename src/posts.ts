// Approve and post: a finished video gets a landing page on the blog and social posts in HighLevel.
//
// Claude drafts the page copy and the captions, people edit them, the desktop builds a preview link, and an
// admin approves. Approving queues a "publish" job: the desktop (which holds the HighLevel and Cloudflare
// keys) puts the page live and schedules the posts. Nothing goes public before that click.
// A program spotlight (FAN Fundraiser, stores) already has its own page, so its posts link there instead.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { HttpError, body, json, now, type Env } from "./common";
import type { Caller } from "./auth";
import { BRAND_NOTES, DRAFTS_PER_HOUR, MODEL, str } from "./build";
import { formatOf } from "./formats";

// Only BeeGraphix has a blog and a HighLevel login on the desktop so far (Rugbee comes with stage 5).
const POSTING_BRANDS = ["beegraphix"];
const BLOG = "blog.beegraphix.com";
const SLUG = /^[a-z0-9][a-z0-9-]{2,60}$/;
const ACTIVE = ["queued", "claimed", "rendering", "uploading"];

const PAGE_FIELDS = { title: 70, description: 160, eyebrow: 40, headline: 90, dek: 260, intro: 400 } as const;
const CAPTION_FIELDS = { instagram: 2200, facebook: 2000, linkedin: 3000, youtubeTitle: 100, youtube: 5000, tiktok: 2200 } as const;
type Copy = { page: Record<keyof typeof PAGE_FIELDS, string>; captions: Record<keyof typeof CAPTION_FIELDS, string> };

interface PostRow {
  campaign: string; brand: string; source_job: string; variant: string; slug: string | null; copy: string; start_date: string | null;
  task_job: string | null; task_kind: string | null; preview_url: string | null; live_url: string | null; posted: string | null;
  approved_by: string | null; approved_at: string | null; updated_by: string; updated_at: string;
}
interface Job { id: string; brand: string; kind: string; payload: string; status: string; message: string | null }

const who = (c: Caller) => c.user?.name || c.label;
// Brand rule: no em dashes in anything customers read.
const clean = (s: unknown, max: number) => String(s ?? "").replace(/\s*—\s*/g, ", ").replace(/\r\n/g, "\n").trim().slice(0, max);
const blankCopy = (): Copy => ({
  page: { title: "", description: "", eyebrow: "", headline: "", dek: "", intro: "" },
  captions: { instagram: "", facebook: "", linkedin: "", youtubeTitle: "", youtube: "", tiktok: "" },
});
function readCopy(v: unknown): Copy {
  const o = (v && typeof v === "object" ? v : {}) as { page?: Record<string, unknown>; captions?: Record<string, unknown> };
  const c = blankCopy();
  for (const [k, max] of Object.entries(PAGE_FIELDS)) c.page[k as keyof typeof PAGE_FIELDS] = clean(o.page?.[k], max).replace(/\s+/g, " ");
  for (const [k, max] of Object.entries(CAPTION_FIELDS)) c.captions[k as keyof typeof CAPTION_FIELDS] = clean(o.captions?.[k], max);
  return c;
}
const tomorrow = () => new Date(Date.now() + 86400_000).toISOString().slice(0, 10);
const withHttps = (u: string) => (!u ? "" : /^https?:\/\//i.test(u) ? u : `https://${u}`);

/** The finished video a person is posting, and the New video spec its campaign was built from. */
async function source(env: Env, c: Caller, jobId: string) {
  const j = await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<Job>();
  if (!j || (c.brand !== "*" && j.brand !== c.brand)) throw new HttpError(404, "Job not found");
  const payload = JSON.parse(j.payload);
  const campaign = String(payload.campaign ?? "");
  const build = j.kind === "build" ? j : await env.DB.prepare(
    "SELECT * FROM jobs WHERE kind = 'build' AND brand = ? AND json_extract(payload, '$.campaign') = ? ORDER BY created_at DESC LIMIT 1",
  ).bind(j.brand, campaign).first<Job>();
  const spec = build ? JSON.parse(build.payload).spec : null;
  const format = spec ? formatOf(spec.template) : null;
  return { job: j, campaign, variant: String(payload.variant ?? ""), spec, format };
}

async function rowOf(env: Env, campaign: string) {
  return env.DB.prepare("SELECT * FROM posts WHERE campaign = ?").bind(campaign).first<PostRow>();
}

async function view(env: Env, c: Caller, s: Awaited<ReturnType<typeof source>>) {
  const r = await rowOf(env, s.campaign);
  const task = r?.task_job ? await env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(r.task_job).first<Job>() : null;
  const program = s.format?.id === "program";
  return {
    supported: !!s.spec && POSTING_BRANDS.includes(s.job.brand),
    why: !s.spec ? "Only videos made on the New video screen can be posted from here." : POSTING_BRANDS.includes(s.job.brand) ? "" : "Posting for this brand isn't set up yet.",
    format: s.format?.name ?? null,
    program,
    // A program's posts send people to the program's own page.
    link: program ? withHttps(s.spec?.products?.[0]?.link ?? "") : r?.slug ? `https://${BLOG}/${r.slug}/` : "",
    canApprove: c.admin,
    suggestedSlug: r?.slug ?? (program || !s.spec ? null : await freeSlug(env, s.campaign, String(s.spec.title ?? ""))),
    videoReady: s.job.status === "done",
    post: r && {
      campaign: r.campaign, sourceJob: r.source_job, variant: r.variant, slug: r.slug, copy: JSON.parse(r.copy), start: r.start_date,
      previewUrl: r.preview_url, liveUrl: r.live_url, posted: r.posted ? JSON.parse(r.posted) : null,
      approvedBy: r.approved_by, approvedAt: r.approved_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
      task: task && { id: task.id, kind: task.kind, status: task.status, message: task.message, busy: ACTIVE.includes(task.status) },
    },
  };
}

function check(s: Awaited<ReturnType<typeof source>>) {
  if (!s.spec) throw new HttpError(409, "Only videos made on the New video screen can be posted from here.");
  if (!POSTING_BRANDS.includes(s.job.brand)) throw new HttpError(409, "Posting for this brand isn't set up yet.");
}
async function notBusy(env: Env, r: PostRow | null) {
  if (!r?.task_job) return;
  const t = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(r.task_job).first<{ status: string }>();
  if (t && ACTIVE.includes(t.status)) throw new HttpError(409, "The desktop is still working on this. Wait for it to finish.");
}

/** Saves copy, slug and start date (creating the row the first time). */
async function save(env: Env, c: Caller, s: Awaited<ReturnType<typeof source>>, b: { slug?: unknown; copy?: unknown; start?: unknown }) {
  const r = await rowOf(env, s.campaign);
  await notBusy(env, r);
  if (r?.live_url || r?.posted) throw new HttpError(409, "This one is already posted. Make changes in HighLevel.");
  const program = s.format?.id === "program";
  const slug = program ? null : String(b.slug ?? r?.slug ?? "").trim().toLowerCase();
  if (!program && !SLUG.test(slug!)) throw new HttpError(400, "The page address can use lowercase letters, numbers and dashes (3 to 61 characters)");
  if (slug && await env.DB.prepare("SELECT 1 FROM posts WHERE slug = ? AND campaign != ?").bind(slug, s.campaign).first()) throw new HttpError(409, "Another video already uses that page address");
  const start = String(b.start || r?.start_date || tomorrow());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || Number.isNaN(Date.parse(start))) throw new HttpError(400, "Pick a start date");
  const copy = readCopy(b.copy ?? (r ? JSON.parse(r.copy) : null));
  const t = now();
  await env.DB.prepare(
    `INSERT INTO posts (campaign, brand, source_job, variant, slug, copy, start_date, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (campaign) DO UPDATE SET source_job = excluded.source_job, variant = excluded.variant, slug = excluded.slug, copy = excluded.copy,
       start_date = excluded.start_date, preview_url = CASE WHEN posts.copy = excluded.copy AND IFNULL(posts.slug, '') = IFNULL(excluded.slug, '') AND posts.source_job = excluded.source_job THEN posts.preview_url END,
       updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).bind(s.campaign, s.job.brand, s.job.id, s.variant, slug, JSON.stringify(copy), start, who(c), t).run();
}

export async function getPost(env: Env, c: Caller, jobId: string) {
  return json(await view(env, c, await source(env, c, jobId)));
}

export async function putPost(req: Request, env: Env, c: Caller, jobId: string) {
  const s = await source(env, c, jobId);
  check(s);
  await save(env, c, s, await body(req));
  return json(await view(env, c, s));
}

/** A page address from a title, made unique if another video has it. */
async function freeSlug(env: Env, campaign: string, from: string) {
  let slug = from.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
  if (!SLUG.test(slug)) slug = campaign.slice(0, 50).replace(/-+$/, "");
  if (await env.DB.prepare("SELECT 1 FROM posts WHERE slug = ? AND campaign != ?").bind(slug, campaign).first()) slug = `${slug.slice(0, 54)}-${campaign.slice(-6)}`;
  return slug;
}

// ---------- Claude writes the page and captions ----------

const DraftSchema = z.object({
  slug: z.string().describe("short page address: lowercase words joined by dashes, e.g. quarter-zips-top-5"),
  page: z.object({
    title: z.string().describe("browser tab / Google title, under 65 characters, ending with | BeeGraphix"),
    description: z.string().describe("Google description, under 155 characters"),
    eyebrow: z.string().describe("2 to 4 word label above the headline"),
    headline: z.string(),
    dek: z.string().describe("one or two sentences under the headline"),
    intro: z.string().describe("one or two sentences that open the article"),
  }),
  captions: z.object({
    instagram: z.string(), facebook: z.string(), linkedin: z.string(), youtubeTitle: z.string(), youtube: z.string(), tiktok: z.string(),
  }),
});

export async function draftPost(env: Env, c: Caller, jobId: string) {
  const s = await source(env, c, jobId);
  check(s);
  await notBusy(env, await rowOf(env, s.campaign));
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "Claude isn't switched on. Write the page and captions yourself for now.");
  const since = new Date(Date.now() - 3600_000).toISOString();
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE who = ? AND at > ?").bind(c.label, since).first<{ n: number }>();
  if ((used?.n ?? 0) >= DRAFTS_PER_HOUR) throw new HttpError(429, "That's a lot of drafts this hour. Try again in a bit.");
  await env.DB.prepare("INSERT INTO ai_calls (who, at) VALUES (?, ?)").bind(c.label, now()).run();

  const sp = s.spec;
  const f = s.format!;
  const program = f.id === "program";
  const beats: Array<{ id: string; kind: string; product?: number; script?: string; text?: string }> = Array.isArray(sp.beats) ? sp.beats : [];
  const prompt = [
    `A ${f.name} video just finished: "${str(sp.title, 120)}", presented by ${str(sp.presenter?.name, 80) || "the presenter"}${sp.presenter?.title ? `, ${str(sp.presenter.title, 80)}` : ""}.`,
    BRAND_NOTES[s.job.brand] ?? "",
    sp.audience ? `Audience: ${str(sp.audience, 200)}` : "",
    `${f.products.title}: ${sp.products.map((p: { name: string; style?: string }) => `${str(p.name, 120)}${p.style ? ` (${str(p.style, 30)})` : ""}`).join("; ")}`,
    "What they say in the video:",
    `Hook: ${str(sp.hook, 400)}`,
    ...beats.map((b) => `${b.id}: ${str(b.script, 800)}${b.text ? ` [on screen: ${str(b.text, 200)}]` : ""}`),
    `Payoff: ${str(sp.cta, 400)}`,
    "",
    program
      ? "There's no new web page for this one: the posts link to the program's own page. Still fill in the page fields briefly; they aren't used."
      : `It gets its own article page on ${BLOG} with the video, each product with the presenter's own words, and a custom quote form. Write that page's copy.`,
    "Then write the social captions that go out with the video:",
    "- instagram and tiktok: hook line first, 2 to 4 short sentences, end with \"Link in bio.\" then 3 to 5 relevant hashtags on their own line.",
    "- facebook: hook line first, 2 to 3 short sentences, then the link on its own line as {url}. No hashtags.",
    "- linkedin: a little more professional, 3 to 5 short sentences for business owners and managers, the link as {url} on its own line, up to 3 hashtags.",
    "- youtubeTitle: under 90 characters. youtube: a 2 to 3 sentence description with {url} on its own line.",
    "Write {url} exactly like that; it becomes the tracked link when the post goes out.",
    "Sound like the presenter talking: plain words, contractions. No em dashes, no emoji.",
    "Only say what the video says. Don't invent prices, specs, materials, results or deadlines.",
  ].filter((x) => x !== "").join("\n");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 2, timeout: 60_000 });
  let out: z.infer<typeof DraftSchema> | null;
  try {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(DraftSchema) },
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") throw new HttpError(422, "Claude wouldn't write this one. Write it yourself for now.");
    out = res.parsed_output;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "Claude is busy. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The Claude key isn't working. Ask Davis to check it.");
    if (e instanceof Anthropic.APIError) { console.error("post draft", e.status, e.message); throw new HttpError(502, "Claude didn't answer. Try again."); }
    throw e;
  }
  if (!out) throw new HttpError(502, "The draft came back incomplete. Try again.");
  // Keep the address they already chose; otherwise use Claude's (made unique if it's taken).
  const r = await rowOf(env, s.campaign);
  const slug = s.format?.id === "program" ? null : r?.slug || await freeSlug(env, s.campaign, out.slug);
  await save(env, c, s, { slug, copy: { page: out.page, captions: out.captions } });
  return json(await view(env, c, s));
}

// ---------- the desktop does the rest ----------

async function queue(env: Env, c: Caller, s: Awaited<ReturnType<typeof source>>, kind: "page" | "publish") {
  const r = (await rowOf(env, s.campaign))!;
  const copy = JSON.parse(r.copy) as Copy;
  const program = s.format?.id === "program";
  const id = crypto.randomUUID();
  const t = now();
  const payload = {
    campaign: s.campaign, variant: r.variant, format: s.format?.id, slug: r.slug, copy, start: r.start_date,
    link: program ? withHttps(s.spec.products?.[0]?.link ?? "") : `${BLOG}/${r.slug}`,
  };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO jobs (id, brand, kind, payload, status, message, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?)")
      .bind(id, s.job.brand, kind, JSON.stringify(payload), kind === "page" ? "Waiting to build the preview" : "Waiting to post", who(c), t, t),
    kind === "publish"
      ? env.DB.prepare("UPDATE posts SET task_job = ?, task_kind = ?, approved_by = ?, approved_at = ? WHERE campaign = ?").bind(id, kind, who(c), t, s.campaign)
      : env.DB.prepare("UPDATE posts SET task_job = ?, task_kind = ?, preview_url = NULL WHERE campaign = ?").bind(id, kind, s.campaign),
  ]);
}

function ready(s: Awaited<ReturnType<typeof source>>, r: PostRow | null, needCaptions: boolean) {
  if (s.job.status !== "done") throw new HttpError(409, "Wait for the video to finish first.");
  if (!r) throw new HttpError(409, "Write the page and captions first.");
  const copy = JSON.parse(r.copy) as Copy;
  const program = s.format?.id === "program";
  if (!program && (!copy.page.headline || !copy.page.title)) throw new HttpError(400, "The page needs a headline and a title.");
  if (program && !/^https?:\/\/\S+\.\S+/.test(withHttps(s.spec.products?.[0]?.link ?? ""))) throw new HttpError(400, "This program has no page link. Add it on the New video screen and build the video again.");
  if (needCaptions && !Object.values(copy.captions).some((x) => x.trim())) throw new HttpError(400, "Write at least one caption.");
}

export async function previewPost(env: Env, c: Caller, jobId: string) {
  const s = await source(env, c, jobId);
  check(s);
  const r = await rowOf(env, s.campaign);
  await notBusy(env, r);
  if (r?.live_url || r?.posted) throw new HttpError(409, "This one is already posted.");
  if (s.format?.id === "program") throw new HttpError(409, "A program's posts link to its own page, so there's no preview to build.");
  ready(s, r, false);
  await queue(env, c, s, "page");
  return json(await view(env, c, s), 202);
}

export async function approvePost(req: Request, env: Env, c: Caller, jobId: string) {
  const s = await source(env, c, jobId);
  check(s);
  if (!c.admin) throw new HttpError(403, "Only an admin can approve and post.");
  const b = await body<{ start?: string }>(req);
  const r0 = await rowOf(env, s.campaign);
  await notBusy(env, r0);
  if (r0?.live_url || r0?.posted) throw new HttpError(409, "This one is already posted.");
  if (b.start) await save(env, c, s, { start: b.start });
  const r = await rowOf(env, s.campaign);
  ready(s, r, true);
  if (r!.start_date! < new Date().toISOString().slice(0, 10)) throw new HttpError(400, "The start date has passed. Pick today or later.");
  await queue(env, c, s, "publish");
  return json(await view(env, c, s), 202);
}

/** The desktop finished a page or publish job: keep what it reported. */
export async function taskFinished(env: Env, j: Job, result: { previewUrl?: unknown; liveUrl?: unknown; posted?: unknown }) {
  const url = (u: unknown) => (typeof u === "string" && /^https:\/\/[^\s"<>]+$/.test(u) ? u.slice(0, 500) : null);
  if (j.kind === "page") {
    await env.DB.prepare("UPDATE posts SET preview_url = ? WHERE task_job = ?").bind(url(result.previewUrl), j.id).run();
  } else if (j.kind === "publish") {
    const posted = Array.isArray(result.posted) ? JSON.stringify(result.posted.slice(0, 50)) : "[]";
    await env.DB.prepare("UPDATE posts SET live_url = ?, posted = ? WHERE task_job = ?").bind(url(result.liveUrl), posted.slice(0, 20000), j.id).run();
  }
}
