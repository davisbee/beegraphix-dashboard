// HeyGen AI avatar. Admins pick the avatar look and make a test clip (stage 1); anyone can then choose
// "AI avatar" on New video (stage 2): submitting starts one HeyGen clip per line, and the desktop waits for
// them, downloads them and frames them (Content Factory scripts/lib/heygen.mjs).
//
//   GET  /api/heygen/available       anyone signed in: {available, reason?, look?}  can New video offer it now
//   GET  /api/heygen                 {ready, choice, test}  is the key set, which look, the last test clip
//   GET  /api/heygen/looks           the account's own avatar looks (private), to pick from
//   PUT  /api/heygen/choice          {id, name, preview?}   the look every AI-avatar video uses
//   POST /api/heygen/test            {mode: "clear" | "green"}  make a short test clip (uses HeyGen credits)
//   GET  /api/heygen/test/refresh    ask HeyGen how the test clip is doing; copies it here when done
//   GET  /api/heygen/test/video      the saved test clip
//   GET  /api/heygen/preview?u=      a look's preview image (HeyGen hosts only), so the page's CSP stays 'self'
//
// API: https://developers.heygen.com (v3). Videos: POST /v3/videos {type: "avatar", avatar_id: <look id>, script,
// output_format: "webm"} gives a transparent clip when the look was trained with matting. With no voice_id the
// look's own voice speaks. HeyGen's links expire, so finished clips are copied into R2 straight away.
// The choice lives in R2 (settings/heygen.json) so no database migration is needed. The option only turns on
// once the desktop says it can handle HeyGen clips (it sends features with its catalog: settings/desktop.json).
//
//   Desktop: GET /api/desktop/heygen/:videoId -> {status, url, message}  a fresh download link when it's done

import { HttpError, body, json, now, type Env } from "./common";
import type { Caller } from "./auth";

const SETTINGS = "settings/heygen.json";
const TEST_CLIP = "settings/heygen-test";
const TEST_SCRIPT = "Quick test. If you can see me with no background behind me, the Content Factory just got a lot faster.";
export const GREEN = "#00B140";

export interface Look { id: string; name: string; preview: string | null; type: string | null }
interface Test { videoId: string; mode: "clear" | "green"; status: string; startedAt: string; message?: string; saved?: string; type?: string }
interface Settings { choice: Look | null; test: Test | null }

function admin(c: Caller) {
  if (!c.admin) throw new HttpError(403, "Only an admin can set up the AI avatar");
}

function key(env: Env) {
  if (!env.HEYGEN_API_KEY) throw new HttpError(503, "The HeyGen key isn't set yet. Add HEYGEN_API_KEY as a secret in Cloudflare.");
  return env.HEYGEN_API_KEY;
}

/** Calls HeyGen and returns its JSON, turning its errors into plain messages. */
export async function heygen(env: Env, path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${env.HEYGEN_BASE_URL || "https://api.heygen.com"}${path}`, {
    ...init,
    headers: { "x-api-key": key(env), accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  let out: any = null;
  try { out = await res.json(); } catch { out = null; }
  if (res.status === 401 || res.status === 403) throw new HttpError(503, "HeyGen didn't accept the key. Check HEYGEN_API_KEY in Cloudflare.");
  if (!res.ok || out?.error) {
    const msg = out?.error?.message ?? out?.message ?? (typeof out?.error === "string" ? out.error : null);
    console.error("heygen", path, res.status, JSON.stringify(out).slice(0, 500));
    throw new HttpError(502, `HeyGen said: ${msg || `error ${res.status}`}`);
  }
  return out;
}

async function load(env: Env): Promise<Settings> {
  const o = await env.MEDIA.get(SETTINGS);
  if (!o) return { choice: null, test: null };
  try { const v = await o.json<Partial<Settings>>(); return { choice: v.choice ?? null, test: v.test ?? null }; } catch { return { choice: null, test: null }; }
}
async function save(env: Env, s: Settings) {
  await env.MEDIA.put(SETTINGS, JSON.stringify(s), { httpMetadata: { contentType: "application/json" } });
}

/** The look AI-avatar videos use, or null when none is picked yet. */
export async function chosenLook(env: Env) {
  return (await load(env)).choice;
}

// HeyGen's list responses have been shaped a few ways; take whichever array is there.
function listOf(out: any, ...names: string[]): any[] {
  const d = out?.data ?? out;
  if (Array.isArray(d)) return d;
  for (const n of names) if (Array.isArray(d?.[n])) return d[n];
  return [];
}

function toLook(x: any): Look | null {
  const id = x?.id ?? x?.look_id ?? x?.avatar_id;
  if (typeof id !== "string" || !id) return null;
  return {
    id,
    name: String(x.name ?? x.look_name ?? x.avatar_name ?? "Untitled look"),
    preview: x.preview_image_url ?? x.image_url ?? x.thumbnail_url ?? null,
    type: x.avatar_type ?? x.type ?? null,
  };
}

async function looks(env: Env) {
  let out;
  try {
    out = await heygen(env, "/v3/avatars/looks?ownership=private&limit=50");
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 502) throw e;
    out = await heygen(env, "/v3/avatars/looks?avatar_type=digital_twin&limit=50");
  }
  return json({ looks: listOf(out, "looks", "items", "avatar_looks").map(toLook).filter(Boolean) });
}

async function setChoice(req: Request, env: Env) {
  const b = await body<{ id?: string; name?: string; preview?: string | null; type?: string | null }>(req);
  if (typeof b.id !== "string" || !/^[\w.:-]{1,200}$/.test(b.id)) throw new HttpError(400, "Pick a look");
  const s = await load(env);
  s.choice = { id: b.id, name: String(b.name ?? "").slice(0, 120) || "Avatar", preview: typeof b.preview === "string" ? b.preview.slice(0, 2000) : null, type: typeof b.type === "string" ? b.type.slice(0, 40) : null };
  if (s.test) s.test = null; // a test belongs to the look it was made with
  await save(env, s);
  return json({ choice: s.choice });
}

/** Starts a HeyGen avatar video. mode "clear" asks for a transparent WebM; "green" a solid green MP4 to key. */
export async function startVideo(env: Env, look: Look, script: string, mode: "clear" | "green", title: string) {
  const out = await heygen(env, "/v3/videos", {
    method: "POST",
    body: JSON.stringify({
      type: "avatar",
      avatar_id: look.id,
      script,
      title,
      aspect_ratio: "9:16",
      resolution: "1080p",
      ...(mode === "clear" ? { output_format: "webm" } : { output_format: "mp4", background: { type: "color", value: GREEN } }),
    }),
  });
  const id = out?.data?.video_id ?? out?.video_id;
  if (typeof id !== "string") throw new HttpError(502, "HeyGen didn't send back a video id");
  return id;
}

/** HeyGen's status for one video: {status, url, message}. */
export async function videoStatus(env: Env, videoId: string) {
  const out = await heygen(env, `/v3/videos/${encodeURIComponent(videoId)}`);
  const d = out?.data ?? out;
  return {
    status: String(d?.status ?? "unknown"),
    url: (d?.video_url as string | undefined) ?? null,
    message: (d?.failure_message ?? d?.error?.message ?? null) as string | null,
  };
}

/** Copies a finished HeyGen video into R2 before its link expires. */
export async function copyVideo(env: Env, url: string, key: string, meta: Record<string, string> = {}) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new HttpError(502, `Couldn't download the clip from HeyGen (${res.status})`);
  const type = res.headers.get("content-type") || (url.includes(".webm") ? "video/webm" : "video/mp4");
  const len = res.headers.get("content-length");
  const data = len ? res.body : await res.arrayBuffer(); // R2 needs a known length for a stream
  await env.MEDIA.put(key, data as any, { httpMetadata: { contentType: type }, customMetadata: meta });
  return type;
}

async function startTest(req: Request, env: Env, c: Caller) {
  const b = await body<{ mode?: string }>(req);
  const mode = b.mode === "green" ? "green" : "clear";
  const s = await load(env);
  if (!s.choice) throw new HttpError(400, "Pick your avatar look first");
  if (s.test && ["pending", "processing", "waiting"].includes(s.test.status)) throw new HttpError(409, "A test clip is already being made");
  const videoId = await startVideo(env, s.choice, TEST_SCRIPT, mode, `Content Factory test (${mode})`);
  s.test = { videoId, mode, status: "pending", startedAt: now() };
  await save(env, s);
  console.log("heygen test started", c.label, videoId, mode);
  return json({ test: s.test });
}

async function refreshTest(env: Env) {
  const s = await load(env);
  if (!s.test) throw new HttpError(404, "No test clip yet");
  if (s.test.saved || s.test.status === "failed") return json({ test: s.test });
  const st = await videoStatus(env, s.test.videoId);
  s.test.status = st.status;
  if (st.status === "failed") s.test.message = st.message ?? "HeyGen couldn't make it";
  if (st.status === "completed" && st.url) {
    s.test.type = await copyVideo(env, st.url, TEST_CLIP, { heygen: s.test.videoId });
    s.test.saved = now();
  }
  await save(env, s);
  return json({ test: s.test });
}

async function testVideo(req: Request, env: Env) {
  const o = await env.MEDIA.get(TEST_CLIP, { range: req.headers });
  if (!o) throw new HttpError(404, "No test clip saved yet");
  const h = new Headers({ "content-type": o.httpMetadata?.contentType ?? "video/webm", "accept-ranges": "bytes", "cache-control": "no-store" });
  const r = (o as any).range as { offset?: number; length?: number } | undefined;
  if (r && req.headers.has("range")) {
    const start = r.offset ?? 0, len = r.length ?? o.size - start;
    h.set("content-range", `bytes ${start}-${start + len - 1}/${o.size}`);
    h.set("content-length", String(len));
    return new Response(o.body, { status: 206, headers: h });
  }
  h.set("content-length", String(o.size));
  return new Response(o.body, { headers: h });
}

/** A look's preview image, fetched from HeyGen's own hosts only. */
async function preview(url: URL) {
  let u: URL;
  try { u = new URL(url.searchParams.get("u") ?? ""); } catch { throw new HttpError(400, "Bad image link"); }
  const host = u.hostname.toLowerCase();
  const ok = u.protocol === "https:" && ["heygen.com", "heygen.ai", "heygen.io"].some((d) => host === d || host.endsWith(`.${d}`));
  if (!ok) throw new HttpError(400, "Only HeyGen images");
  const res = await fetch(u.toString());
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.startsWith("image/")) throw new HttpError(502, "Couldn't load that preview");
  return new Response(res.body, { headers: { "content-type": type, "cache-control": "private, max-age=3600" } });
}

// ---------- Stage 2: New video ----------

const DESKTOP = "settings/desktop.json";
const HEYGEN_ID = /^[A-Za-z0-9_-]{6,80}$/;
/** Avatar IV digital twin, USD per minute (help.heygen.com, API pricing). For the estimate on New video only. */
export const USD_PER_MINUTE = 4.83;

/** The desktop sends what it can do along with its catalog (worker.mjs). */
export async function saveDesktopFeatures(env: Env, features: unknown) {
  if (!Array.isArray(features)) return;
  const list = features.filter((f) => typeof f === "string" && /^[a-z0-9-]{1,40}$/.test(f)).slice(0, 20);
  await env.MEDIA.put(DESKTOP, JSON.stringify({ features: list, at: now() }), { httpMetadata: { contentType: "application/json" } });
}

async function desktopCan(env: Env, feature: string) {
  const o = await env.MEDIA.get(DESKTOP);
  if (!o) return false;
  try { return ((await o.json<{ features?: string[] }>()).features ?? []).includes(feature); } catch { return false; }
}

/** Whether New video can offer the AI avatar right now, and why not when it can't. */
export async function avatarAvailability(env: Env) {
  if (!env.HEYGEN_API_KEY) return { available: false, reason: "HeyGen isn't connected yet" } as const;
  const look = await chosenLook(env);
  if (!look) return { available: false, reason: "An admin needs to pick the avatar on the AI avatar page" } as const;
  if (!(await desktopCan(env, "heygen"))) return { available: false, reason: "Needs a desktop update" } as const;
  return { available: true, look } as const;
}

/** Starts one transparent HeyGen clip per line. Returns {clip: videoId}. */
export async function startClips(env: Env, look: Look, lines: Array<{ clip: string; script: string }>, title: string) {
  const out: Record<string, string> = {};
  for (const { clip, script } of lines) out[clip] = await startVideo(env, look, script, "clear", `${title.slice(0, 80)} (${clip})`);
  return out;
}

/** GET /api/desktop/heygen/:videoId: how a clip is doing, with a fresh link once it's finished. */
export async function desktopClipStatus(env: Env, videoId: string) {
  if (!HEYGEN_ID.test(videoId)) throw new HttpError(400, "Bad HeyGen video id");
  return json(await videoStatus(env, videoId));
}

export async function heygenRoute(req: Request, url: URL, env: Env, c: Caller, p: string): Promise<Response | null> {
  if (!p.startsWith("/api/heygen")) return null;
  if (p === "/api/heygen/available" && req.method === "GET") {
    const a = await avatarAvailability(env);
    return json(a.available ? { available: true, look: { name: a.look.name }, usdPerMinute: USD_PER_MINUTE } : a);
  }
  admin(c);
  const m = req.method;
  if (p === "/api/heygen" && m === "GET") {
    const s = await load(env);
    return json({ ready: Boolean(env.HEYGEN_API_KEY), choice: s.choice, test: s.test });
  }
  if (p === "/api/heygen/looks" && m === "GET") return looks(env);
  if (p === "/api/heygen/choice" && m === "PUT") return setChoice(req, env);
  if (p === "/api/heygen/test" && m === "POST") return startTest(req, env, c);
  if (p === "/api/heygen/test/refresh" && m === "GET") return refreshTest(env);
  if (p === "/api/heygen/test/video" && m === "GET") return testVideo(req, env);
  if (p === "/api/heygen/preview" && m === "GET") return preview(url);
  throw new HttpError(404, "Not found");
}
