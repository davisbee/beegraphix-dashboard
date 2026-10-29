// Content Factory Dashboard: the web app staff sign in to, and the job queue AI-DESKTOP pulls from.
//
// Staff sign in (see auth.ts) or a script uses one of the SUBMIT_TOKENS; AI-DESKTOP polls for work,
// renders with the job's brand kit and uploads the finished MP4 here. The desktop only ever calls out,
// so nothing on the office network is exposed. Every job belongs to one brand and a person or token
// only sees their own brand's jobs ("*" sees every brand). The screens are static files in public/.
//
//   Staff (session cookie, or Authorization: Bearer <one of SUBMIT_TOKENS>)
//     POST /api/login {email, password}   POST /api/logout   GET /api/me   POST /api/me/password {current, next}
//     POST /api/password-help {email}   "Forgot your password?": emails a link (or, without email, shows on the Team page)
//     POST /api/password-reset {token, next}   the page that link opens
//     GET  /api/catalog               campaigns and variants on the desktop
//     GET  /api/features              what the desktop can render: {showcase, voiceover}
//     GET  /api/voices                the ElevenLabs voices for faceless voiceovers (voiceover.ts)
//     POST /api/jobs                  {campaign, variant, draft?, brand?}  -> job (render a campaign on the desktop)
//     POST /api/jobs                  {kind: "build", spec, draft?, brand?}  -> job (New video: build a campaign, then render it)
//     POST /api/uploads?brand=        {kind: footage|photo, name, type, size} -> {upload, partBytes}
//     PUT  /api/uploads/:id/part?n=1  raw bytes of one piece      POST /api/uploads/:id/complete {parts}
//     POST /api/lookup?brand=         {url} -> {name, style, photo} read from a product page
//     POST /api/lookup/style?brand=   {style} -> {name, style, photo} from the supplier (S&S Activewear)
//     POST /api/lookup/image?brand=   {url} -> {photo}: a photo dragged out of another web page
//     GET  /api/uploads/:id/file      a product photo, to show it on the New video screen
//     GET  /api/formats               the video formats and their beats (formats.ts)
//     POST /api/draft?brand=          {goal, audience, topic, notes, presenter, products: [{name, link}]} -> script
//     GET  /api/drafts?brand=         saved New video drafts     POST /api/drafts?brand= {title, data} -> draft
//     GET/PUT/DELETE /api/drafts/:id  one draft, with its form data (PUT {title, data})
//     GET/PUT /api/jobs/:id/post      approve and post: the page copy and captions for a finished video (posts.ts)
//     POST /api/jobs/:id/post/draft   Claude writes them    POST .../preview  desktop makes the images and a preview link
//     GET  /api/jobs/:id/stills/:name one of the social images the last preview made (carousel-1, teaser-1-feed...)
//     POST /api/jobs/:id/post/approve {start?}  admins: the desktop puts the page live and schedules the posts
//     GET  /api/jobs                  latest jobs (?brand= for someone who sees every brand)
//     GET  /api/jobs/:id              one job
//     POST /api/jobs/:id/cancel       only while still queued
//     GET  /api/jobs/:id/video        the finished MP4 (Range requests; ?download for a file)
//     GET/PUT/POST /api/heygen/...   AI avatar setup, admins only (heygen.ts)
//     GET/POST /api/users, POST /api/users/:id, POST /api/users/:id/reset   Team page (admins)
//
//   Desktop (Authorization: Bearer <WORKER_TOKEN>)
//     POST /api/desktop/claim                     -> oldest queued job, or 204 when there is none
//     PUT  /api/desktop/catalog                   {campaigns: [{brand, campaign, title, variants: [{id, label}]}], features?: ["heygen"]}
//     GET  /api/desktop/heygen/:videoId           an AI avatar clip: {status, url, message} (heygen.ts)
//     GET  /api/desktop/voice/:jobId/:clip        one line of a faceless video's voiceover, MP3 (voiceover.ts)
//     GET  /api/desktop/uploads/:id               a file staff uploaded for a build job
//     POST /api/desktop/jobs/:id/heartbeat        {status: "rendering" | "uploading", progress?, message?}
//     POST /api/desktop/jobs/:id/fail             {message}
//     POST /api/desktop/jobs/:id/finish           {message, result} -> a page or publish job is done (no video)
//     PUT  /api/desktop/jobs/:id/stills/:name     raw PNG: a social image from a page or publish job
//     POST /api/desktop/jobs/:id/upload/start     -> starts an R2 multipart upload
//     PUT  /api/desktop/jobs/:id/upload/part?n=1  raw bytes of one part (5 MB minimum except the last)
//     POST /api/desktop/jobs/:id/upload/complete  {parts: [{partNumber, etag}]} -> job is done

import { BRANDS, HttpError, body, json, now, type Env } from "./common";
import { avatarLines, campaignId, draftScript, validateSpec } from "./build";
import { FORMATS } from "./formats";
import { createDraft, deleteDraft, getDraft, listDrafts, updateDraft } from "./drafts";
import { approvePost, draftPost, getPost, getStill, previewPost, putPost, putStill, taskFinished } from "./posts";
import { lookupImage, lookupProduct, lookupStyle } from "./lookup";
import { desktopCan, desktopClipStatus, heygenRoute, saveDesktopFeatures, startClips } from "./heygen";
import { desktopVoice, speakLines, voicesRoute } from "./voiceover";
import { desktopDownload, finishUpload, startUpload, uploadPiece, viewPhoto } from "./uploads";
import {
  callerFor, changePassword, createUser, listUsers, login, logout, publicUser, requestPasswordHelp, resetPassword, resetWithLink, resetRequests, sameString, sessionUser, updateUser, type Caller,
} from "./auth";

type Status = "queued" | "claimed" | "rendering" | "uploading" | "done" | "failed" | "cancelled";

interface JobRow {
  id: string;
  brand: string;
  kind: string;
  payload: string;
  status: Status;
  message: string | null;
  progress: number | null;
  attempts: number;
  output_key: string | null;
  output_bytes: number | null;
  upload_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
}

const ACTIVE: Status[] = ["claimed", "rendering", "uploading"];
// A claimed job whose desktop has gone quiet this long goes back in line (or fails after MAX_ATTEMPTS).
const STALE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;
// Videos list only shows video jobs; page and publish jobs show on their video's page (posts.ts).
const VIDEO_KINDS = "'render', 'build'";

function bearer(req: Request) {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? "";
}

/** A script holding one of the SUBMIT_TOKENS, or a signed-in person. Otherwise a 401. */
async function caller(req: Request, env: Env): Promise<Caller> {
  const token = bearer(req);
  if (token) {
    let map: Record<string, string> = {};
    try {
      map = JSON.parse(env.SUBMIT_TOKENS || "{}");
    } catch {
      throw new HttpError(500, "SUBMIT_TOKENS is not valid JSON");
    }
    for (const [t, scope] of Object.entries(map)) if (t.length >= 24 && sameString(token, t)) return { brand: scope, admin: scope === "*", label: scope === "*" ? "admin" : scope };
    throw new HttpError(401, "Unauthorized");
  }
  const u = await sessionUser(req, env);
  if (!u) throw new HttpError(401, "Please sign in");
  if (u.must_change) throw new HttpError(403, "Set a new password first");
  return callerFor(u);
}

function requireDesktop(req: Request, env: Env) {
  const token = bearer(req);
  if (!env.WORKER_TOKEN || env.WORKER_TOKEN.length < 24 || !token || !sameString(token, env.WORKER_TOKEN)) throw new HttpError(401, "Unauthorized");
}

function publicJob(j: JobRow) {
  return {
    id: j.id,
    brand: j.brand,
    kind: j.kind,
    payload: JSON.parse(j.payload),
    status: j.status,
    message: j.message,
    progress: j.progress,
    attempts: j.attempts,
    hasVideo: j.status === "done" && !!j.output_key,
    outputBytes: j.output_bytes,
    createdBy: j.created_by,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    claimedAt: j.claimed_at,
    finishedAt: j.finished_at,
  };
}

async function getJob(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
}

/** A job the caller's brand can see; other brands' jobs look like they don't exist. */
async function visibleJob(env: Env, scope: string, id: string) {
  const j = await getJob(env, id);
  if (!j || (scope !== "*" && j.brand !== scope)) throw new HttpError(404, "Job not found");
  return j;
}

/** A job the desktop is allowed to work on right now. */
async function activeJob(env: Env, id: string) {
  const j = await getJob(env, id);
  if (!j) throw new HttpError(404, "Job not found");
  if (!ACTIVE.includes(j.status)) throw new HttpError(409, `Job is ${j.status}`);
  return j;
}

// ---------- submit side ----------

/** The brand a request acts for: the caller's own, or the one a "*" caller names. */
function brandFor(c: Caller, asked: unknown) {
  const brand = c.brand === "*" ? asked : c.brand;
  if (typeof brand !== "string" || !(BRANDS as readonly string[]).includes(brand)) throw new HttpError(400, `brand must be one of ${BRANDS.join(", ")}`);
  if (c.brand !== "*" && asked && asked !== c.brand) throw new HttpError(403, "You can only submit jobs for your own brand");
  return brand;
}

async function createJob(req: Request, env: Env, c: Caller) {
  const b = await body<{ kind?: string; brand?: string; campaign?: string; variant?: string; draft?: boolean; spec?: unknown }>(req);
  const brand = brandFor(c, b.brand);
  const id = crypto.randomUUID();
  let kind = "render";
  let payload: Record<string, unknown>;
  if (b.kind === "build") {
    const spec = await validateSpec(env, brand, b.spec);
    // AI avatar: HeyGen starts on every line now, so the clips are ready (or nearly) when the desktop claims it.
    if (spec.presenter.mode === "heygen" && spec.presenter.look) {
      spec.heygen = await startClips(env, { ...spec.presenter.look, preview: null, type: null }, avatarLines(spec), spec.title);
    }
    // Faceless voiceover: ElevenLabs speaks every line now; the desktop downloads them (voiceover.ts).
    if (spec.voice) spec.voice.clips = await speakLines(env, id, spec.voice.id, avatarLines(spec));
    kind = "build";
    payload = { campaign: campaignId(spec.title, id), variant: spec.look, draft: !!b.draft, title: spec.title, spec };
  } else {
    if (!b.campaign || !SLUG.test(b.campaign)) throw new HttpError(400, "campaign must be a campaign id (lowercase letters, numbers, dashes)");
    if (!b.variant || !SLUG.test(b.variant)) throw new HttpError(400, "variant must be a variant id (lowercase letters, numbers, dashes)");
    payload = { campaign: b.campaign, variant: b.variant, draft: !!b.draft };
  }
  const t = now();
  await env.DB.prepare(
    "INSERT INTO jobs (id, brand, kind, payload, status, message, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 'Waiting for the desktop', ?, ?, ?)",
  ).bind(id, brand, kind, JSON.stringify(payload), c.label, t, t).run();
  return json(publicJob((await getJob(env, id))!), 201);
}

async function listJobs(url: URL, env: Env, c: Caller) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  // Someone who sees every brand can narrow the list to one.
  const want = url.searchParams.get("brand");
  const brand = c.brand !== "*" ? c.brand : want && (BRANDS as readonly string[]).includes(want) ? want : null;
  const rows = brand
    ? await env.DB.prepare(`SELECT * FROM jobs WHERE brand = ? AND kind IN (${VIDEO_KINDS}) ORDER BY created_at DESC LIMIT ?`).bind(brand, limit).all<JobRow>()
    : await env.DB.prepare(`SELECT * FROM jobs WHERE kind IN (${VIDEO_KINDS}) ORDER BY created_at DESC LIMIT ?`).bind(limit).all<JobRow>();
  return json({ jobs: rows.results.map(publicJob) });
}

async function cancelJob(env: Env, c: Caller, id: string) {
  await visibleJob(env, c.brand, id);
  const t = now();
  const r = await env.DB.prepare("UPDATE jobs SET status = 'cancelled', message = 'Cancelled', updated_at = ?, finished_at = ? WHERE id = ? AND status = 'queued'")
    .bind(t, t, id).run();
  if (!r.meta.changes) throw new HttpError(409, "Only a queued job can be cancelled");
  return json(publicJob((await getJob(env, id))!));
}

/** Streams the MP4. Supports Range requests so the browser's player can seek (Safari needs this). */
async function video(req: Request, url: URL, env: Env, c: Caller, id: string) {
  const j = await visibleJob(env, c.brand, id);
  if (j.status !== "done" || !j.output_key) throw new HttpError(409, "The video isn't ready yet");
  const head = await env.MEDIA.head(j.output_key);
  if (!head) throw new HttpError(404, "Video file missing");
  const size = head.size;
  const headers: Record<string, string> = {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "content-disposition": `${url.searchParams.has("download") ? "attachment" : "inline"}; filename="${j.brand}-${JSON.parse(j.payload).campaign ?? "video"}-${j.id.slice(0, 8)}.mp4"`,
    "cache-control": "private, no-store",
  };
  const m = (req.headers.get("range") ?? "").match(/^bytes=(\d*)-(\d*)$/);
  if (m && (m[1] || m[2])) {
    let start = m[1] ? parseInt(m[1], 10) : Math.max(size - parseInt(m[2], 10), 0);
    let end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1;
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
    const obj = await env.MEDIA.get(j.output_key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) throw new HttpError(404, "Video file missing");
    return new Response(obj.body, { status: 206, headers: { ...headers, "content-length": String(end - start + 1), "content-range": `bytes ${start}-${end}/${size}` } });
  }
  const obj = await env.MEDIA.get(j.output_key);
  if (!obj) throw new HttpError(404, "Video file missing");
  return new Response(obj.body, { headers: { ...headers, "content-length": String(size) } });
}

// ---------- catalog: campaigns the desktop can render ----------

interface CatalogEntry {
  brand: string;
  campaign: string;
  title: string;
  variants: Array<{ id: string; label: string }>;
}

/** The desktop reports every campaign on the PC; this replaces the whole list. */
async function putCatalog(req: Request, env: Env) {
  const b = await body<{ campaigns?: CatalogEntry[]; features?: unknown }>(req);
  await saveDesktopFeatures(env, b.features);
  if (!Array.isArray(b.campaigns) || b.campaigns.length > 500) throw new HttpError(400, "campaigns must be a list");
  const t = now();
  const rows = b.campaigns
    .filter((c) => (BRANDS as readonly string[]).includes(c.brand) && SLUG.test(c.campaign ?? "") && Array.isArray(c.variants))
    .map((c) => ({
      brand: c.brand,
      campaign: c.campaign,
      title: String(c.title ?? c.campaign).slice(0, 200),
      variants: c.variants.filter((v) => SLUG.test(v?.id ?? "")).slice(0, 50).map((v) => ({ id: v.id, label: String(v.label ?? v.id).slice(0, 200) })),
    }));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM catalog"),
    ...rows.map((r) => env.DB.prepare("INSERT INTO catalog (brand, campaign, title, variants, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(r.brand, r.campaign, r.title, JSON.stringify(r.variants), t)),
  ]);
  return json({ ok: true, campaigns: rows.length });
}

async function getCatalog(env: Env, c: Caller) {
  const rows = c.brand === "*"
    ? await env.DB.prepare("SELECT * FROM catalog ORDER BY brand, title").all<{ brand: string; campaign: string; title: string; variants: string; updated_at: string }>()
    : await env.DB.prepare("SELECT * FROM catalog WHERE brand = ? ORDER BY title").bind(c.brand).all<{ brand: string; campaign: string; title: string; variants: string; updated_at: string }>();
  return json({
    campaigns: rows.results.map((r) => ({ brand: r.brand, campaign: r.campaign, title: r.title, variants: JSON.parse(r.variants), updatedAt: r.updated_at })),
  });
}

// ---------- desktop side ----------

/** Puts jobs from a desktop that went quiet back in line, or fails them after MAX_ATTEMPTS. */
async function recoverStale(env: Env) {
  const cutoff = new Date(Date.now() - STALE_MS).toISOString();
  const t = now();
  const marks = ACTIVE.map(() => "?").join(", ");
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE jobs SET status = 'failed', message = 'The desktop stopped responding ${MAX_ATTEMPTS} times', upload_id = NULL, updated_at = ?, finished_at = ? WHERE status IN (${marks}) AND heartbeat_at < ? AND attempts >= ?`,
    ).bind(t, t, ...ACTIVE, cutoff, MAX_ATTEMPTS),
    env.DB.prepare(
      `UPDATE jobs SET status = 'queued', message = 'Back in line: the desktop stopped responding', progress = NULL, upload_id = NULL, updated_at = ? WHERE status IN (${marks}) AND heartbeat_at < ? AND attempts < ?`,
    ).bind(t, ...ACTIVE, cutoff, MAX_ATTEMPTS),
  ]);
}

async function claim(env: Env) {
  await recoverStale(env);
  const t = now();
  const j = await env.DB.prepare(
    `UPDATE jobs SET status = 'claimed', message = 'Picked up by the desktop', progress = 0, attempts = attempts + 1, claimed_at = ?, heartbeat_at = ?, updated_at = ?
     WHERE id = (SELECT id FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1) AND status = 'queued' RETURNING *`,
  ).bind(t, t, t).first<JobRow>();
  if (!j) return new Response(null, { status: 204 });
  return json(publicJob(j));
}

async function heartbeat(req: Request, env: Env, id: string) {
  await activeJob(env, id);
  const b = await body<{ status?: string; progress?: number; message?: string }>(req);
  if (b.status !== "rendering" && b.status !== "uploading") throw new HttpError(400, "status must be rendering or uploading");
  const progress = typeof b.progress === "number" && Number.isFinite(b.progress) ? Math.min(Math.max(b.progress, 0), 1) : null;
  const t = now();
  await env.DB.prepare("UPDATE jobs SET status = ?, progress = COALESCE(?, progress), message = COALESCE(?, message), heartbeat_at = ?, updated_at = ? WHERE id = ?")
    .bind(b.status, progress, b.message?.slice(0, 500) ?? null, t, t, id).run();
  return json(publicJob((await getJob(env, id))!));
}

async function fail(req: Request, env: Env, id: string) {
  const j = await activeJob(env, id);
  const b = await body<{ message?: string }>(req);
  if (j.upload_id && j.output_key) await env.MEDIA.resumeMultipartUpload(j.output_key, j.upload_id).abort().catch(() => {});
  const t = now();
  await env.DB.prepare("UPDATE jobs SET status = 'failed', message = ?, upload_id = NULL, updated_at = ?, finished_at = ? WHERE id = ?")
    .bind((b.message || "Render failed").slice(0, 2000), t, t, id).run();
  return json(publicJob((await getJob(env, id))!));
}

/** A page or publish job (approve and post) is done: it has no video, just what the desktop reports. */
async function finish(req: Request, env: Env, id: string) {
  const j = await activeJob(env, id);
  if (j.kind !== "page" && j.kind !== "publish") throw new HttpError(409, "Only page and publish jobs finish without a video");
  const b = await body<{ message?: string; result?: Record<string, unknown> }>(req);
  await taskFinished(env, j, b.result ?? {});
  const t = now();
  await env.DB.prepare("UPDATE jobs SET status = 'done', message = ?, progress = 1, heartbeat_at = ?, updated_at = ?, finished_at = ? WHERE id = ?")
    .bind((b.message || "Done").slice(0, 500), t, t, t, id).run();
  return json(publicJob((await getJob(env, id))!));
}

const outputKey = (j: JobRow) => `outputs/${j.brand}/${j.id}.mp4`;

async function uploadStart(env: Env, id: string) {
  const j = await activeJob(env, id);
  const key = outputKey(j);
  if (j.upload_id) await env.MEDIA.resumeMultipartUpload(key, j.upload_id).abort().catch(() => {});
  const up = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: "video/mp4" }, customMetadata: { brand: j.brand, job: j.id } });
  const t = now();
  await env.DB.prepare("UPDATE jobs SET status = 'uploading', message = 'Uploading the video', upload_id = ?, output_key = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?")
    .bind(up.uploadId, key, t, t, id).run();
  return json({ key, uploadId: up.uploadId });
}

async function uploadPart(req: Request, url: URL, env: Env, id: string) {
  const j = await activeJob(env, id);
  if (!j.upload_id || !j.output_key) throw new HttpError(409, "Start the upload first");
  const n = parseInt(url.searchParams.get("n") ?? "", 10);
  if (!(n >= 1 && n <= 10000)) throw new HttpError(400, "n must be the part number, 1 to 10000");
  if (!req.body) throw new HttpError(400, "Empty part");
  const part = await env.MEDIA.resumeMultipartUpload(j.output_key, j.upload_id).uploadPart(n, req.body);
  const t = now();
  await env.DB.prepare("UPDATE jobs SET heartbeat_at = ?, updated_at = ? WHERE id = ?").bind(t, t, id).run();
  return json({ partNumber: part.partNumber, etag: part.etag });
}

async function uploadComplete(req: Request, env: Env, id: string) {
  const j = await activeJob(env, id);
  if (!j.upload_id || !j.output_key) throw new HttpError(409, "Start the upload first");
  const b = await body<{ parts?: Array<{ partNumber: number; etag: string }> }>(req);
  if (!Array.isArray(b.parts) || !b.parts.length) throw new HttpError(400, "parts is required");
  const obj = await env.MEDIA.resumeMultipartUpload(j.output_key, j.upload_id).complete(b.parts);
  const t = now();
  await env.DB.prepare(
    "UPDATE jobs SET status = 'done', message = 'Ready to review', progress = 1, output_bytes = ?, upload_id = NULL, heartbeat_at = ?, updated_at = ?, finished_at = ? WHERE id = ?",
  ).bind(obj.size, t, t, t, id).run();
  return json(publicJob((await getJob(env, id))!));
}

// ---------- routing ----------

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname.replace(/\/+$/, "") || "/";
  const m = req.method;

  if (!p.startsWith("/api/")) return env.ASSETS.fetch(req);
  if (p === "/api/health") return json({ ok: true, service: "content-factory-dashboard" });

  if (p.startsWith("/api/desktop/")) {
    requireDesktop(req, env);
    if (m === "POST" && p === "/api/desktop/claim") return claim(env);
    if (m === "PUT" && p === "/api/desktop/catalog") return putCatalog(req, env);
    const dv = p.match(/^\/api\/desktop\/voice\/([0-9a-f-]{36})\/([a-z0-9-]{1,40})$/);
    if (m === "GET" && dv) return desktopVoice(env, dv[1], dv[2]);
    const hv = p.match(/^\/api\/desktop\/heygen\/([^/]+)$/);
    if (m === "GET" && hv) return desktopClipStatus(env, decodeURIComponent(hv[1]));
    const dl = p.match(/^\/api\/desktop\/uploads\/([0-9a-f-]{36})$/);
    if (m === "GET" && dl) return desktopDownload(env, dl[1]);
    const st = p.match(/^\/api\/desktop\/jobs\/([0-9a-f-]{36})\/stills\/([a-z0-9-]{1,40})$/);
    if (m === "PUT" && st) return putStill(req, env, await activeJob(env, st[1]), st[2]);
    const d = p.match(/^\/api\/desktop\/jobs\/([0-9a-f-]{36})\/(heartbeat|fail|finish|upload\/start|upload\/part|upload\/complete)$/);
    if (d) {
      const [, id, action] = d;
      if (m === "POST" && action === "heartbeat") return heartbeat(req, env, id);
      if (m === "POST" && action === "fail") return fail(req, env, id);
      if (m === "POST" && action === "finish") return finish(req, env, id);
      if (m === "POST" && action === "upload/start") return uploadStart(env, id);
      if (m === "PUT" && action === "upload/part") return uploadPart(req, url, env, id);
      if (m === "POST" && action === "upload/complete") return uploadComplete(req, env, id);
    }
    throw new HttpError(404, "Not found");
  }

  // Signing in, and a person's own account (allowed while they still have a temporary password).
  if (p === "/api/login" && m === "POST") return login(req, env);
  if (p === "/api/logout" && m === "POST") return logout(req, env);
  if (p === "/api/password-help" && m === "POST") return requestPasswordHelp(req, env);
  if (p === "/api/password-reset" && m === "POST") return resetWithLink(req, env);
  if (p === "/api/me" || p === "/api/me/password") {
    const u = await sessionUser(req, env);
    if (!u) throw new HttpError(401, "Please sign in");
    if (p === "/api/me" && m === "GET") return json({ user: publicUser(u), brands: u.brand === "*" ? BRANDS : [u.brand], resetRequests: await resetRequests(env, u) });
    if (p === "/api/me/password" && m === "POST") return changePassword(req, env, u);
    throw new HttpError(404, "Not found");
  }

  const c = await caller(req, env);
  const hg = await heygenRoute(req, url, env, c, p);
  if (hg) return hg;
  const vo = await voicesRoute(req, url, env, p);
  if (vo) return vo;

  if (p === "/api/catalog" && m === "GET") return getCatalog(env, c);
  if (p === "/api/features" && m === "GET") return json({ showcase: await desktopCan(env, "showcase"), voiceover: await desktopCan(env, "voiceover") });

  if (p === "/api/users" && m === "GET") return listUsers(env, c);
  if (p === "/api/users" && m === "POST") return createUser(req, env, c);
  const um = p.match(/^\/api\/users\/([0-9a-f-]{36})(?:\/(reset))?$/);
  if (um && m === "POST") return um[2] ? resetPassword(env, c, um[1]) : updateUser(req, env, c, um[1]);

  if (p === "/api/uploads" && m === "POST") return startUpload(req, env, c, brandFor(c, url.searchParams.get("brand")));
  const up = p.match(/^\/api\/uploads\/([0-9a-f-]{36})\/(part|complete|file)$/);
  if (up && up[2] === "file" && m === "GET") return viewPhoto(env, c, up[1]);
  if (up && up[2] === "part" && m === "PUT") return uploadPiece(req, url, env, c, up[1]);
  if (up && up[2] === "complete" && m === "POST") return finishUpload(req, env, c, up[1]);
  if (p === "/api/lookup/style" && m === "POST") return lookupStyle(req, env, c, brandFor(c, url.searchParams.get("brand")));
  if (p === "/api/lookup/image" && m === "POST") return lookupImage(req, env, c, brandFor(c, url.searchParams.get("brand")));
  if (p === "/api/lookup" && m === "POST") return lookupProduct(req, env, c, brandFor(c, url.searchParams.get("brand")));
  if (p === "/api/formats" && m === "GET") return json({ formats: FORMATS });
  if (p === "/api/draft" && m === "POST") return draftScript(req, env, c, brandFor(c, url.searchParams.get("brand")));

  if (p === "/api/drafts" && m === "GET") return listDrafts(env, brandFor(c, url.searchParams.get("brand")));
  if (p === "/api/drafts" && m === "POST") return createDraft(req, env, c, brandFor(c, url.searchParams.get("brand")));
  const dm = p.match(/^\/api\/drafts\/([0-9a-f-]{36})$/);
  if (dm && m === "GET") return getDraft(env, c, dm[1]);
  if (dm && m === "PUT") return updateDraft(req, env, c, dm[1]);
  if (dm && m === "DELETE") return deleteDraft(env, c, dm[1]);

  if (p === "/api/jobs" && m === "POST") return createJob(req, env, c);
  if (p === "/api/jobs" && m === "GET") return listJobs(url, env, c);
  const pm = p.match(/^\/api\/jobs\/([0-9a-f-]{36})\/post(?:\/(draft|preview|approve))?$/);
  if (pm && !pm[2] && m === "GET") return getPost(env, c, pm[1]);
  if (pm && !pm[2] && m === "PUT") return putPost(req, env, c, pm[1]);
  if (pm && pm[2] === "draft" && m === "POST") return draftPost(env, c, pm[1]);
  if (pm && pm[2] === "preview" && m === "POST") return previewPost(env, c, pm[1]);
  if (pm && pm[2] === "approve" && m === "POST") return approvePost(req, env, c, pm[1]);
  const sm = p.match(/^\/api\/jobs\/([0-9a-f-]{36})\/stills\/([a-z0-9-]{1,40})$/);
  if (sm && m === "GET") return getStill(env, c, sm[1], sm[2]);
  const s = p.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(cancel|video))?$/);
  if (s) {
    const [, id, action] = s;
    if (!action && m === "GET") return json(publicJob(await visibleJob(env, c.brand, id)));
    if (action === "cancel" && m === "POST") return cancelJob(env, c, id);
    if (action === "video" && m === "GET") return video(req, url, env, c, id);
  }
  throw new HttpError(404, "Not found");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: "Server error" }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
