// ElevenLabs voiceover for faceless (Showcase) videos.
//
//   GET  /api/voices                 anyone signed in: {ready, voices: [{id, name, category, gender, accent, preview}]}
//   GET  /api/voices/preview?u=      a voice's sample, fetched from ElevenLabs' own hosts (the page's CSP is 'self')
//   Desktop: GET /api/desktop/voice/:jobId/:clip   one line of a job's voiceover (MP3)
//
// On submit (index.ts createJob) each line (hook, every beat, payoff) is spoken once and saved in R2 at
// voice/<jobId>/<clip>.mp3, so the desktop never needs the key. API: POST /v1/text-to-speech/{voice_id}
// with the xi-api-key header; GET /v1/voices lists the account's voices. ELEVENLABS_MODEL picks the model.

import { HttpError, json, type Env } from "./common";

const VOICES_CACHE = "settings/elevenlabs-voices.json";
const CACHE_MS = 60 * 60 * 1000;
const CLIP = /^[a-z0-9-]{1,40}$/;
const VOICE_ID = /^[A-Za-z0-9]{8,40}$/;

export interface Voice { id: string; name: string; category: string | null; gender: string | null; accent: string | null; preview: string | null }

function key(env: Env) {
  if (!env.ELEVENLABS_API_KEY) throw new HttpError(503, "ElevenLabs isn't connected yet. Add ELEVENLABS_API_KEY as a secret in Cloudflare.");
  return env.ELEVENLABS_API_KEY;
}

async function eleven(env: Env, path: string, init: RequestInit = {}) {
  const res = await fetch(`${env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io"}${path}`, {
    ...init,
    headers: { "xi-api-key": key(env), ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers ?? {}) },
  });
  if (res.status === 401 || res.status === 403) throw new HttpError(503, "ElevenLabs didn't accept the key. Check ELEVENLABS_API_KEY in Cloudflare.");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = "";
    try { const j = JSON.parse(text); msg = j?.detail?.message ?? j?.detail ?? j?.message ?? ""; } catch { msg = text.slice(0, 200); }
    console.error("elevenlabs", path, res.status, text.slice(0, 400));
    throw new HttpError(502, `ElevenLabs said: ${typeof msg === "string" && msg ? msg : `error ${res.status}`}`);
  }
  return res;
}

/** The account's voices, cached for an hour. */
export async function listVoices(env: Env): Promise<Voice[]> {
  const cached = await env.MEDIA.get(VOICES_CACHE);
  if (cached) {
    try {
      const c = await cached.json<{ at: number; voices: Voice[] }>();
      if (Date.now() - c.at < CACHE_MS && Array.isArray(c.voices)) return c.voices;
    } catch { /* refetch */ }
  }
  const out: any = await (await eleven(env, "/v1/voices")).json();
  const voices: Voice[] = (Array.isArray(out?.voices) ? out.voices : [])
    .filter((v: any) => typeof v?.voice_id === "string" && VOICE_ID.test(v.voice_id))
    .map((v: any) => ({
      id: v.voice_id, name: String(v.name ?? "Voice").slice(0, 80), category: v.category ?? null,
      gender: v.labels?.gender ?? null, accent: v.labels?.accent ?? null, preview: v.preview_url ?? null,
    }))
    // their own voices (cloned, designed) first, then the rest by name
    .sort((a: Voice, b: Voice) => Number(a.category === "premade") - Number(b.category === "premade") || a.name.localeCompare(b.name));
  await env.MEDIA.put(VOICES_CACHE, JSON.stringify({ at: Date.now(), voices }), { httpMetadata: { contentType: "application/json" } });
  return voices;
}

/** Checks a voice id against the account's voices; returns the voice. */
export async function checkVoice(env: Env, id: unknown): Promise<Voice> {
  if (typeof id !== "string" || !VOICE_ID.test(id)) throw new HttpError(400, "Pick a voice");
  const v = (await listVoices(env)).find((x) => x.id === id);
  if (!v) throw new HttpError(400, "That voice isn't on the ElevenLabs account anymore. Pick another.");
  return v;
}

/** Speaks each line and saves it at voice/<jobId>/<clip>.mp3. Returns the clip ids. */
export async function speakLines(env: Env, jobId: string, voiceId: string, lines: Array<{ clip: string; script: string }>) {
  const done: string[] = [];
  for (const { clip, script } of lines) {
    if (!CLIP.test(clip) || !script.trim()) continue;
    const res = await eleven(env, `/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: "POST",
      body: JSON.stringify({ text: script, model_id: env.ELEVENLABS_MODEL || "eleven_multilingual_v2" }),
    });
    await env.MEDIA.put(`voice/${jobId}/${clip}.mp3`, await res.arrayBuffer(), { httpMetadata: { contentType: "audio/mpeg" }, customMetadata: { voice: voiceId } });
    done.push(clip);
  }
  return done;
}

/** GET /api/desktop/voice/:jobId/:clip */
export async function desktopVoice(env: Env, jobId: string, clip: string) {
  if (!CLIP.test(clip)) throw new HttpError(400, "Bad clip");
  const o = await env.MEDIA.get(`voice/${jobId}/${clip}.mp3`);
  if (!o) throw new HttpError(404, "No voiceover for that line");
  return new Response(o.body, { headers: { "content-type": "audio/mpeg", "content-length": String(o.size) } });
}

/** A voice's sample, from ElevenLabs' hosts only. */
async function preview(url: URL) {
  let u: URL;
  try { u = new URL(url.searchParams.get("u") ?? ""); } catch { throw new HttpError(400, "Bad sample link"); }
  const host = u.hostname.toLowerCase();
  const ok = u.protocol === "https:" && (host === "elevenlabs.io" || host.endsWith(".elevenlabs.io") || (host === "storage.googleapis.com" && u.pathname.startsWith("/eleven-")));
  if (!ok) throw new HttpError(400, "Only ElevenLabs samples");
  const res = await fetch(u.toString());
  const type = res.headers.get("content-type") ?? "audio/mpeg";
  if (!res.ok || !/^audio\//.test(type)) throw new HttpError(502, "Couldn't load that sample");
  return new Response(res.body, { headers: { "content-type": type, "cache-control": "private, max-age=86400" } });
}

export async function voicesRoute(req: Request, url: URL, env: Env, p: string): Promise<Response | null> {
  if (!p.startsWith("/api/voices") || req.method !== "GET") return null;
  if (p === "/api/voices") {
    if (!env.ELEVENLABS_API_KEY) return json({ ready: false, voices: [] });
    return json({ ready: true, voices: await listVoices(env) });
  }
  if (p === "/api/voices/preview") return preview(url);
  throw new HttpError(404, "Not found");
}
