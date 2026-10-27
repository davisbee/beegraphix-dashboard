// Content Factory Dashboard: job queue API (stage 2).
//
// Staff (later: the dashboard) submit video jobs; AI-DESKTOP polls for work, renders with the job's
// brand kit and uploads the finished MP4 here. The desktop only ever calls out, so nothing on the
// office network is exposed. Every job belongs to one brand and a brand token only sees its own jobs.
//
//   Submit side (Authorization: Bearer <one of SUBMIT_TOKENS>)
//     POST /api/jobs                  {campaign, variant, draft?, brand?}  -> job
//     GET  /api/jobs                  latest jobs for the token's brand
//     GET  /api/jobs/:id              one job
//     POST /api/jobs/:id/cancel       only while still queued
//     GET  /api/jobs/:id/video        the finished MP4
//
//   Desktop side (Authorization: Bearer <WORKER_TOKEN>)
//     POST /api/desktop/claim                     -> oldest queued job, or 204 when there is none
//     POST /api/desktop/jobs/:id/heartbeat        {status: "rendering" | "uploading", progress?, message?}
//     POST /api/desktop/jobs/:id/fail             {message}
//     POST /api/desktop/jobs/:id/upload/start     -> starts an R2 multipart upload
//     PUT  /api/desktop/jobs/:id/upload/part?n=1  raw bytes of one part (5 MB minimum except the last)
//     POST /api/desktop/jobs/:id/upload/complete  {parts: [{partNumber, etag}]} -> job is done

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  WORKER_TOKEN: string;
  SUBMIT_TOKENS: string;
}

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

export const BRANDS = ["beegraphix", "rugbee"] as const;
const ACTIVE: Status[] = ["claimed", "rendering", "uploading"];
// A claimed job whose desktop has gone quiet this long goes back in line (or fails after MAX_ATTEMPTS).
const STALE_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const now = () => new Date().toISOString();

// Constant-time compare so a token can't be guessed one character at a time.
function sameToken(a: string, b: string) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function bearer(req: Request) {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)$/i);
  return m?.[1] ?? "";
}

/** Brand the caller may act for ("*" = every brand), or a 401. */
function submitScope(req: Request, env: Env): string {
  const token = bearer(req);
  let map: Record<string, string> = {};
  try {
    map = JSON.parse(env.SUBMIT_TOKENS || "{}");
  } catch {
    throw new HttpError(500, "SUBMIT_TOKENS is not valid JSON");
  }
  if (token) for (const [t, scope] of Object.entries(map)) if (t.length >= 24 && sameToken(token, t)) return scope;
  throw new HttpError(401, "Unauthorized");
}

function requireDesktop(req: Request, env: Env) {
  const token = bearer(req);
  if (!env.WORKER_TOKEN || env.WORKER_TOKEN.length < 24 || !token || !sameToken(token, env.WORKER_TOKEN)) throw new HttpError(401, "Unauthorized");
}

async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
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

async function createJob(req: Request, env: Env, scope: string) {
  const b = await body<{ brand?: string; campaign?: string; variant?: string; draft?: boolean }>(req);
  const brand = scope === "*" ? b.brand : scope;
  if (!brand || !(BRANDS as readonly string[]).includes(brand)) throw new HttpError(400, `brand must be one of ${BRANDS.join(", ")}`);
  if (scope !== "*" && b.brand && b.brand !== scope) throw new HttpError(403, "This token can only submit jobs for its own brand");
  if (!b.campaign || !SLUG.test(b.campaign)) throw new HttpError(400, "campaign must be a campaign id (lowercase letters, numbers, dashes)");
  if (!b.variant || !SLUG.test(b.variant)) throw new HttpError(400, "variant must be a variant id (lowercase letters, numbers, dashes)");
  const id = crypto.randomUUID();
  const t = now();
  const payload = JSON.stringify({ campaign: b.campaign, variant: b.variant, draft: !!b.draft });
  await env.DB.prepare(
    "INSERT INTO jobs (id, brand, kind, payload, status, message, created_by, created_at, updated_at) VALUES (?, ?, 'render', ?, 'queued', 'Waiting for the desktop', ?, ?, ?)",
  ).bind(id, brand, payload, scope === "*" ? "admin" : scope, t, t).run();
  return json(publicJob((await getJob(env, id))!), 201);
}

async function listJobs(url: URL, env: Env, scope: string) {
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
  const rows =
    scope === "*"
      ? await env.DB.prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?").bind(limit).all<JobRow>()
      : await env.DB.prepare("SELECT * FROM jobs WHERE brand = ? ORDER BY created_at DESC LIMIT ?").bind(scope, limit).all<JobRow>();
  return json({ jobs: rows.results.map(publicJob) });
}

async function cancelJob(env: Env, scope: string, id: string) {
  await visibleJob(env, scope, id);
  const t = now();
  const r = await env.DB.prepare("UPDATE jobs SET status = 'cancelled', message = 'Cancelled', updated_at = ?, finished_at = ? WHERE id = ? AND status = 'queued'")
    .bind(t, t, id).run();
  if (!r.meta.changes) throw new HttpError(409, "Only a queued job can be cancelled");
  return json(publicJob((await getJob(env, id))!));
}

async function video(env: Env, scope: string, id: string) {
  const j = await visibleJob(env, scope, id);
  if (j.status !== "done" || !j.output_key) throw new HttpError(409, "The video isn't ready yet");
  const obj = await env.MEDIA.get(j.output_key);
  if (!obj) throw new HttpError(404, "Video file missing");
  return new Response(obj.body, {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(obj.size),
      "content-disposition": `inline; filename="${j.brand}-${j.id}.mp4"`,
      "cache-control": "private, no-store",
    },
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

  if (p === "/" || p === "/api/health") return json({ ok: true, service: "content-factory-dashboard" });

  if (p.startsWith("/api/desktop/")) {
    requireDesktop(req, env);
    if (m === "POST" && p === "/api/desktop/claim") return claim(env);
    const d = p.match(/^\/api\/desktop\/jobs\/([0-9a-f-]{36})\/(heartbeat|fail|upload\/start|upload\/part|upload\/complete)$/);
    if (d) {
      const [, id, action] = d;
      if (m === "POST" && action === "heartbeat") return heartbeat(req, env, id);
      if (m === "POST" && action === "fail") return fail(req, env, id);
      if (m === "POST" && action === "upload/start") return uploadStart(env, id);
      if (m === "PUT" && action === "upload/part") return uploadPart(req, url, env, id);
      if (m === "POST" && action === "upload/complete") return uploadComplete(req, env, id);
    }
    throw new HttpError(404, "Not found");
  }

  if (p === "/api/jobs" || p.startsWith("/api/jobs/")) {
    const scope = submitScope(req, env);
    if (p === "/api/jobs" && m === "POST") return createJob(req, env, scope);
    if (p === "/api/jobs" && m === "GET") return listJobs(url, env, scope);
    const s = p.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(cancel|video))?$/);
    if (s) {
      const [, id, action] = s;
      if (!action && m === "GET") return json(publicJob(await visibleJob(env, scope, id)));
      if (action === "cancel" && m === "POST") return cancelJob(env, scope, id);
      if (action === "video" && m === "GET") return video(env, scope, id);
    }
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
