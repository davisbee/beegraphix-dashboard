// Platform connections: an admin signs in to a platform once (Connections page), and the dashboard reads its numbers
// itself from then on (youtube.ts). Only YouTube so far; the table and these calls are shaped for any platform.
//
// The refresh token is encrypted (AES-GCM) with the CONNECTIONS_KEY secret before it goes in D1, and never leaves the
// Worker. Google is asked for read-only access: youtube.readonly and yt-analytics.readonly.

import { BRANDS, HttpError, json, now, type Env } from "./common";
import { sessionUser, type Caller } from "./auth";

const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];
const STATE_MS = 10 * 60 * 1000;

const accountsUrl = (env: Env) => env.GOOGLE_ACCOUNTS_URL ?? "https://accounts.google.com";
const oauthUrl = (env: Env) => env.GOOGLE_OAUTH_URL ?? "https://oauth2.googleapis.com";
export const youtubeUrl = (env: Env) => env.YOUTUBE_API_URL ?? "https://www.googleapis.com";
export const analyticsUrl = (env: Env) => env.YOUTUBE_ANALYTICS_URL ?? "https://youtubeanalytics.googleapis.com";
const redirectUri = (url: URL) => `${url.origin}/api/connections/youtube/callback`;

/** What's still missing before YouTube can be connected, in the words an admin needs. */
function missing(env: Env) {
  return [
    !env.GOOGLE_CLIENT_ID && "GOOGLE_CLIENT_ID",
    !env.GOOGLE_CLIENT_SECRET && "GOOGLE_CLIENT_SECRET",
    !env.CONNECTIONS_KEY && "CONNECTIONS_KEY",
  ].filter(Boolean) as string[];
}

function admin(c: Caller) {
  if (!c.admin) throw new HttpError(403, "Only an admin can connect accounts");
}

/** The brand a connection is for: the admin's own, or the one an every-brand admin names. */
function brandOf(c: Caller, asked: string | null) {
  const brand = c.brand === "*" ? asked : c.brand;
  if (!brand || !(BRANDS as readonly string[]).includes(brand)) throw new HttpError(400, `brand must be one of ${BRANDS.join(", ")}`);
  return brand;
}

// ---------- the token, encrypted at rest ----------

async function key(env: Env) {
  const raw = Uint8Array.from(atob(env.CONNECTIONS_KEY ?? ""), (ch) => ch.charCodeAt(0));
  if (raw.length !== 32) throw new HttpError(503, "CONNECTIONS_KEY must be 32 random bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)));
const unb64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

async function seal(env: Env, plain: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return `${b64(iv)}.${b64(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(plain)))}`;
}

async function unseal(env: Env, sealed: string) {
  const [iv, data] = sealed.split(".");
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(env), unb64(data)));
}

// ---------- Google ----------

async function google(env: Env, path: string, form: Record<string, string>) {
  const r = await fetch(oauthUrl(env) + path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form) });
  const data = (await r.json().catch(() => ({}))) as Record<string, string>;
  return { ok: r.ok, data };
}

export interface Connection { brand: string; platform: string; account_id: string; account_name: string | null; token: string; scopes: string | null; connected_by: string; connected_at: string; last_pull_at: string | null; last_error: string | null }

/** A fresh access token for a connection. A login Google won't renew any more is marked so the page asks to reconnect. */
export async function accessToken(env: Env, conn: Connection) {
  const { ok, data } = await google(env, "/token", {
    client_id: env.GOOGLE_CLIENT_ID ?? "", client_secret: env.GOOGLE_CLIENT_SECRET ?? "", grant_type: "refresh_token", refresh_token: await unseal(env, conn.token),
  });
  if (!ok || !data.access_token) {
    const why = data.error === "invalid_grant" ? "Google stopped accepting this login. Connect YouTube again." : `Google said: ${data.error_description ?? data.error ?? "no access token"}`;
    throw new HttpError(502, why);
  }
  return data.access_token;
}

/** The signed-in account's channel: its id, its name and its uploads playlist. */
export async function myChannel(env: Env, token: string) {
  const r = await fetch(`${youtubeUrl(env)}/youtube/v3/channels?part=snippet,contentDetails&mine=true`, { headers: { authorization: `Bearer ${token}` } });
  const data = (await r.json().catch(() => ({}))) as { items?: Array<{ id: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
  const ch = data.items?.[0];
  if (!r.ok || !ch) return null;
  return { id: ch.id, name: ch.snippet?.title ?? ch.id, uploads: ch.contentDetails?.relatedPlaylists?.uploads ?? null };
}

// ---------- routes ----------

/** GET /api/connections: what's connected, per brand. Admins only. */
export async function listConnections(env: Env, c: Caller) {
  admin(c);
  const rows = c.brand === "*"
    ? await env.DB.prepare("SELECT * FROM platform_connections ORDER BY brand, platform").all<Connection>()
    : await env.DB.prepare("SELECT * FROM platform_connections WHERE brand = ? ORDER BY platform").bind(c.brand).all<Connection>();
  return json({
    missing: missing(env),
    connections: rows.results.map((r) => ({
      brand: r.brand, platform: r.platform, accountId: r.account_id, accountName: r.account_name, connectedBy: r.connected_by, connectedAt: r.connected_at, lastPullAt: r.last_pull_at, lastError: r.last_error,
    })),
  });
}

/** POST /api/connections/youtube/start?brand= -> {url}: the Google sign-in page to send the admin to. */
export async function startYouTube(url: URL, env: Env, c: Caller) {
  admin(c);
  if (missing(env).length) throw new HttpError(503, `Set these Worker secrets first: ${missing(env).join(", ")}`);
  if (!c.user) throw new HttpError(403, "Sign in to the dashboard to connect an account");
  const brand = brandOf(c, url.searchParams.get("brand"));
  const state = b64(crypto.getRandomValues(new Uint8Array(24))).replace(/[+/=]/g, (ch) => ({ "+": "-", "/": "_", "=": "" })[ch]!);
  const t = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_states WHERE created_at < ?").bind(new Date(Date.now() - STATE_MS).toISOString()),
    env.DB.prepare("INSERT INTO oauth_states (state, brand, platform, user_id, created_at) VALUES (?, ?, 'youtube', ?, ?)").bind(state, brand, c.user.id, t),
  ]);
  const q = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!, redirect_uri: redirectUri(url), response_type: "code", scope: GOOGLE_SCOPES.join(" "),
    // offline + consent: Google hands back a refresh token every time, so a reconnect always works.
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state,
  });
  return json({ url: `${accountsUrl(env)}/o/oauth2/v2/auth?${q}` });
}

/** GET /api/connections/youtube/callback: Google sends the admin back here. Ends on the Connections page either way. */
export async function youtubeCallback(req: Request, url: URL, env: Env) {
  const back = (q: Record<string, string>) => Response.redirect(`${url.origin}/#/connections?${new URLSearchParams(q)}`, 302);
  const state = url.searchParams.get("state") ?? "";
  const row = state ? await env.DB.prepare("DELETE FROM oauth_states WHERE state = ? RETURNING *").bind(state).first<{ brand: string; user_id: string; created_at: string }>() : null;
  if (!row || Date.now() - Date.parse(row.created_at) > STATE_MS) return back({ error: "That sign-in link ran out. Press Connect YouTube again." });
  const u = await sessionUser(req, env);
  if (!u || u.id !== row.user_id || u.role !== "admin") return back({ error: "Finish connecting in the same browser you started in, signed in as the same admin." });
  if (url.searchParams.get("error")) return back({ error: url.searchParams.get("error") === "access_denied" ? "Google access wasn't allowed, so nothing was connected." : `Google said: ${url.searchParams.get("error")}` });

  const { ok, data } = await google(env, "/token", {
    code: url.searchParams.get("code") ?? "", client_id: env.GOOGLE_CLIENT_ID ?? "", client_secret: env.GOOGLE_CLIENT_SECRET ?? "", redirect_uri: redirectUri(url), grant_type: "authorization_code",
  });
  if (!ok || !data.refresh_token) return back({ error: `Google didn't hand over a login to keep (${data.error_description ?? data.error ?? "no refresh token"}).` });
  const granted = String(data.scope ?? "").split(" ");
  if (!GOOGLE_SCOPES.every((s) => granted.includes(s))) return back({ error: "Both boxes (YouTube account and YouTube Analytics) need to be ticked on Google's screen. Try again." });
  const ch = await myChannel(env, data.access_token);
  if (!ch) return back({ error: "That Google account doesn't have a YouTube channel. Pick the account that manages the channel." });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO platform_connections (brand, platform, account_id, account_name, token, scopes, connected_by, connected_at, last_pull_at, last_error)
     VALUES (?, 'youtube', ?, ?, ?, ?, ?, ?, NULL, NULL)`,
  ).bind(row.brand, ch.id, ch.name, await seal(env, data.refresh_token), granted.join(" "), u.email, now()).run();
  return back({ connected: "youtube", channel: ch.name });
}

/** POST /api/connections/youtube/disconnect?brand=: gives the access back to Google and forgets the login. */
export async function disconnectYouTube(url: URL, env: Env, c: Caller) {
  admin(c);
  const brand = brandOf(c, url.searchParams.get("brand"));
  const conn = await env.DB.prepare("SELECT * FROM platform_connections WHERE brand = ? AND platform = 'youtube'").bind(brand).first<Connection>();
  if (!conn) throw new HttpError(404, "YouTube isn't connected");
  try { await google(env, "/revoke", { token: await unseal(env, conn.token) }); } catch { /* forgotten here either way */ }
  await env.DB.prepare("DELETE FROM platform_connections WHERE brand = ? AND platform = 'youtube'").bind(brand).run();
  return json({ ok: true });
}

export { brandOf as connectionBrand, admin as requireAdmin };
