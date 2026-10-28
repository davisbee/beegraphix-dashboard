// Footage and product photos from the browser, for the New video screen.
//
// Big phone videos go up in pieces (R2 multipart), so a 1 GB clip never has to fit in one request.
// Every upload belongs to one brand; only that brand's jobs can use it, and only the desktop downloads it.
import { HttpError, body, json, now, type Env } from "./common";
import type { Caller } from "./auth";

export interface UploadRow {
  id: string;
  brand: string;
  kind: "footage" | "photo";
  name: string;
  content_type: string;
  bytes: number;
  r2_key: string;
  upload_id: string | null;
  status: "uploading" | "ready";
  created_by: string | null;
  created_at: string;
}

// 20 MB pieces: well under the Worker's 100 MB request limit, and above R2's 5 MB minimum.
export const PART_BYTES = 20 * 1024 * 1024;
const LIMITS = {
  footage: { bytes: 4 * 1024 ** 3, types: /^video\/(mp4|quicktime|x-m4v)$/, what: "an MP4 or MOV video" },
  photo: { bytes: 25 * 1024 ** 2, types: /^image\/(jpeg|png|webp)$/, what: "a JPG, PNG or WebP photo" },
} as const;
const EXT: Record<string, string> = {
  "video/mp4": "mp4", "video/quicktime": "mov", "video/x-m4v": "mp4", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
};

const publicUpload = (u: UploadRow) => ({ id: u.id, kind: u.kind, name: u.name, type: u.content_type, bytes: u.bytes, status: u.status });

export const extFor = (u: UploadRow) => EXT[u.content_type] ?? "bin";

async function getUpload(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(id).first<UploadRow>();
}

async function ownUpload(env: Env, c: Caller, id: string) {
  const u = await getUpload(env, id);
  if (!u || (c.brand !== "*" && u.brand !== c.brand)) throw new HttpError(404, "Upload not found");
  return u;
}

/** POST /api/uploads {kind, name, type, size, brand?} -> {upload, partBytes} */
export async function startUpload(req: Request, env: Env, c: Caller, brand: string) {
  const b = await body<{ kind?: string; name?: string; type?: string; size?: number }>(req);
  if (b.kind !== "footage" && b.kind !== "photo") throw new HttpError(400, "kind must be footage or photo");
  const lim = LIMITS[b.kind];
  const type = String(b.type ?? "").toLowerCase();
  if (!lim.types.test(type)) throw new HttpError(400, `That file isn't ${lim.what}`);
  const size = Number(b.size);
  if (!(size > 0)) throw new HttpError(400, "That file is empty");
  if (size > lim.bytes) throw new HttpError(400, `That file is too big (${b.kind === "footage" ? "4 GB" : "25 MB"} at most)`);
  const id = crypto.randomUUID();
  const key = `uploads/${brand}/${id}.${EXT[type]}`;
  const up = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: type }, customMetadata: { brand, upload: id } });
  await env.DB.prepare(
    "INSERT INTO uploads (id, brand, kind, name, content_type, bytes, r2_key, upload_id, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?)",
  ).bind(id, brand, b.kind, String(b.name ?? "file").slice(0, 200), type, size, key, up.uploadId, c.label, now()).run();
  return json({ upload: publicUpload((await getUpload(env, id))!), partBytes: PART_BYTES }, 201);
}

/** PUT /api/uploads/:id/part?n=1 with the raw bytes of one piece. */
export async function uploadPiece(req: Request, url: URL, env: Env, c: Caller, id: string) {
  const u = await ownUpload(env, c, id);
  if (u.status !== "uploading" || !u.upload_id) throw new HttpError(409, "This upload is already finished");
  const n = parseInt(url.searchParams.get("n") ?? "", 10);
  if (!(n >= 1 && n <= Math.ceil(u.bytes / PART_BYTES))) throw new HttpError(400, "n must be the piece number");
  if (!req.body) throw new HttpError(400, "Empty piece");
  const part = await env.MEDIA.resumeMultipartUpload(u.r2_key, u.upload_id).uploadPart(n, req.body);
  return json({ partNumber: part.partNumber, etag: part.etag });
}

/** POST /api/uploads/:id/complete {parts: [{partNumber, etag}]} */
export async function finishUpload(req: Request, env: Env, c: Caller, id: string) {
  const u = await ownUpload(env, c, id);
  if (u.status === "ready") return json({ upload: publicUpload(u) });
  if (!u.upload_id) throw new HttpError(409, "This upload was never started");
  const b = await body<{ parts?: Array<{ partNumber: number; etag: string }> }>(req);
  if (!Array.isArray(b.parts) || !b.parts.length) throw new HttpError(400, "parts is required");
  const obj = await env.MEDIA.resumeMultipartUpload(u.r2_key, u.upload_id).complete(b.parts);
  await env.DB.prepare("UPDATE uploads SET status = 'ready', upload_id = NULL, bytes = ? WHERE id = ?").bind(obj.size, id).run();
  return json({ upload: publicUpload((await getUpload(env, id))!) });
}

/** Uploads a job may use: finished, the right kind, and the job's own brand. */
export async function readyUploads(env: Env, brand: string, wanted: Array<{ id: string; kind: "footage" | "photo"; what: string }>) {
  const out: Record<string, UploadRow> = {};
  for (const w of wanted) {
    const u = await getUpload(env, w.id);
    if (!u || u.brand !== brand) throw new HttpError(400, `${w.what}: that upload wasn't found`);
    if (u.kind !== w.kind) throw new HttpError(400, `${w.what}: expected ${w.kind === "footage" ? "a video" : "a photo"}`);
    if (u.status !== "ready") throw new HttpError(400, `${w.what}: still uploading`);
    out[w.id] = u;
  }
  return out;
}

/** GET /api/desktop/uploads/:id: the desktop downloads a file for a campaign it's building. */
export async function desktopDownload(env: Env, id: string) {
  const u = await getUpload(env, id);
  if (!u || u.status !== "ready") throw new HttpError(404, "Upload not found");
  const obj = await env.MEDIA.get(u.r2_key);
  if (!obj) throw new HttpError(404, "Upload file missing");
  return new Response(obj.body, { headers: { "content-type": u.content_type, "content-length": String(obj.size), "cache-control": "no-store" } });
}
