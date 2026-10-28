// Staff logins: passwords, sessions and the Team page API.
//
// Passwords are PBKDF2-SHA256 (100,000 rounds, the most Workers allow) with a random salt per person.
// The browser holds only a random session cookie (HttpOnly, Secure, SameSite=Lax); D1 stores its SHA-256.
// Five wrong passwords in a row lock the login for 15 minutes.
import { BRANDS, HttpError, body, json, now, type Env } from "./common";

export interface UserRow {
  id: string;
  email: string;
  name: string;
  brand: string;
  role: "staff" | "admin";
  pw_hash: string;
  pw_salt: string;
  pw_iters: number;
  must_change: number;
  disabled: number;
  failed_logins: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
  reset_requested_at: string | null;
}

/** Who is calling: a signed-in person, or a script holding one of the SUBMIT_TOKENS. */
export interface Caller {
  brand: string; // a brand id, or "*" for every brand
  admin: boolean;
  label: string; // shown as "created by"
  user?: UserRow;
}

const COOKIE = "cfd_session";
const SESSION_DAYS = 30;
const ITERS = 100_000;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)));

async function pbkdf2(password: string, salt: Uint8Array, iters: number) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return hex(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: iters }, key, 256));
}

async function sha256(s: string) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export function sameString(a: string, b: string) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { pw_hash: await pbkdf2(password, salt, ITERS), pw_salt: hex(salt), pw_iters: ITERS };
}

// Easy to read aloud or type from a text message: no 0/O, 1/l/I.
function tempPassword() {
  const abc = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const r = crypto.getRandomValues(new Uint8Array(12));
  const s = [...r].map((x) => abc[x % abc.length]).join("");
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}

function checkNewPassword(p: unknown): string {
  if (typeof p !== "string" || p.length < 10) throw new HttpError(400, "Use at least 10 characters for the password");
  if (p.length > 200) throw new HttpError(400, "That password is too long");
  return p;
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    brand: u.brand,
    role: u.role,
    mustChange: !!u.must_change,
    disabled: !!u.disabled,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    resetRequestedAt: u.reset_requested_at,
  };
}

function cookieValue(req: Request) {
  const m = (req.headers.get("cookie") ?? "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,})`));
  return m?.[1] ?? "";
}

function sessionCookie(value: string, maxAge: number) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** The signed-in person, or null. Mutating calls must also come from this site (CSRF guard). */
export async function sessionUser(req: Request, env: Env): Promise<UserRow | null> {
  const token = cookieValue(req);
  if (!token) return null;
  const u = await env.DB.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND s.expires_at > ? AND u.disabled = 0",
  ).bind(await sha256(token), now()).first<UserRow>();
  if (!u) return null;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const origin = req.headers.get("origin");
    if (req.headers.get("x-requested-with") !== "dashboard" || (origin && origin !== new URL(req.url).origin)) {
      throw new HttpError(403, "Request blocked");
    }
  }
  return u;
}

export function callerFor(u: UserRow): Caller {
  return { brand: u.brand, admin: u.role === "admin", label: u.email, user: u };
}

// ---------- login / logout / own account ----------

export async function login(req: Request, env: Env) {
  const b = await body<{ email?: string; password?: string }>(req);
  const email = String(b.email ?? "").trim();
  const password = String(b.password ?? "");
  const u = email ? await env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<UserRow>() : null;
  const t = now();
  if (u?.locked_until && u.locked_until > t) throw new HttpError(429, "Too many tries. Wait 15 minutes, or ask your admin to reset your password.");
  // Hash even for an unknown email so the response time doesn't reveal who has an account.
  const hash = await pbkdf2(password, u ? unhex(u.pw_salt) : new Uint8Array(16), u?.pw_iters ?? ITERS);
  if (!u || u.disabled || !sameString(hash, u.pw_hash)) {
    if (u) {
      const fails = u.failed_logins + 1;
      const lock = fails >= MAX_FAILS ? new Date(Date.now() + LOCK_MS).toISOString() : null;
      await env.DB.prepare("UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?").bind(lock ? 0 : fails, lock, u.id).run();
    }
    throw new HttpError(401, "Wrong email or password");
  }
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").bind(u.id, t),
    env.DB.prepare("INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256(token), u.id, t, expires),
    env.DB.prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, reset_requested_at = NULL, last_login_at = ? WHERE id = ?").bind(t, u.id),
  ]);
  const res = json({ user: publicUser(u) });
  res.headers.append("set-cookie", sessionCookie(token, SESSION_DAYS * 86400));
  return res;
}

export async function logout(req: Request, env: Env) {
  const token = cookieValue(req);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE id_hash = ?").bind(await sha256(token)).run();
  const res = json({ ok: true });
  res.headers.append("set-cookie", sessionCookie("", 0));
  return res;
}

const RESET_MS = 60 * 60 * 1000; // a reset link works for an hour
const RESETS_PER_HOUR = 3;

/**
 * "Forgot your password?": emails the person a one-time link to pick a new password. Without email set up (or if the
 * email can't be sent) their admin sees the request on the Team page instead. The answer is the same whether or not
 * the email has an account, so nobody can use it to find out who works here.
 */
export async function requestPasswordHelp(req: Request, env: Env) {
  const b = await body<{ email?: string }>(req);
  const email = String(b.email ?? "").trim();
  if (!EMAIL.test(email) || email.length > 200) throw new HttpError(400, "Enter your email address");
  const via = env.RESEND_API_KEY ? "email" : "admin";
  const u = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND disabled = 0").bind(email).first<UserRow>();
  if (!u) return json({ ok: true, via });
  const t = now();
  const askAdmin = () => env.DB.prepare("UPDATE users SET reset_requested_at = ? WHERE id = ?").bind(t, u.id).run();
  if (via === "admin") {
    await askAdmin();
    return json({ ok: true, via });
  }
  const hourAgo = new Date(Date.now() - RESET_MS).toISOString();
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ? AND created_at > ?").bind(u.id, hourAgo).first<{ n: number }>();
  if ((recent?.n ?? 0) >= RESETS_PER_HOUR) return json({ ok: true, via }); // enough links in their inbox already
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM password_resets WHERE expires_at <= ?").bind(t),
    env.DB.prepare("INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256(token), u.id, t, new Date(Date.now() + RESET_MS).toISOString()),
  ]);
  const link = `${new URL(req.url).origin}/#/reset?token=${token}`;
  try {
    await sendResetEmail(env, u, link);
  } catch (e) {
    console.error("reset email failed", e);
    await askAdmin();
  }
  return json({ ok: true, via });
}

async function sendResetEmail(env: Env, u: UserRow, link: string) {
  const first = u.name.split(/\s+/)[0];
  const text = `Hi ${first},\n\nSomeone asked to reset your Content Factory password. To pick a new one, open this link (it works once, for the next hour):\n\n${link}\n\nIf you didn't ask, ignore this email. Your password stays the same.`;
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:24px;color:#1d1d1f;max-width:520px">
<p>Hi ${esc(first)},</p><p>Someone asked to reset your Content Factory password. To pick a new one, press the button. It works once, for the next hour.</p>
<p style="margin:28px 0"><a href="${esc(link)}" style="background:#F9B023;color:#1d1d1f;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px;display:inline-block">Pick a New Password</a></p>
<p style="color:#6b6b6b;font-size:14px">If you didn't ask, ignore this email. Your password stays the same.</p></div>`;
  const r = await fetch(`${env.RESEND_BASE_URL ?? "https://api.resend.com"}/emails`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      from: env.EMAIL_FROM || "Content Factory <noreply@shopbgx.com>",
      to: [u.email],
      subject: "Reset your Content Factory password",
      text,
      html,
    }),
  });
  if (!r.ok) throw new Error(`Resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
}

/** The page the emailed link opens: sets the new password and signs out every browser. */
export async function resetWithLink(req: Request, env: Env) {
  const b = await body<{ token?: string; next?: string }>(req);
  const token = String(b.token ?? "");
  const bad = new HttpError(400, "That link has expired or was already used. Ask for a new one on the sign-in page.");
  if (!/^[0-9a-f]{64}$/.test(token)) throw bad;
  const t = now();
  const row = await env.DB.prepare(
    "SELECT r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ? AND u.disabled = 0",
  ).bind(await sha256(token), t).first<{ user_id: string }>();
  if (!row) throw bad;
  const h = await hashPassword(checkNewPassword(b.next));
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iters = ?, must_change = 0, failed_logins = 0, locked_until = NULL, reset_requested_at = NULL, updated_at = ? WHERE id = ?")
      .bind(h.pw_hash, h.pw_salt, h.pw_iters, t, row.user_id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id),
    env.DB.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(t, row.user_id),
  ]);
  return json({ ok: true });
}

export async function changePassword(req: Request, env: Env, u: UserRow) {
  const b = await body<{ current?: string; next?: string }>(req);
  const current = await pbkdf2(String(b.current ?? ""), unhex(u.pw_salt), u.pw_iters);
  if (!sameString(current, u.pw_hash)) throw new HttpError(400, "Your current password isn't right");
  const next = checkNewPassword(b.next);
  if (next === b.current) throw new HttpError(400, "Pick a new password, not the same one");
  const h = await hashPassword(next);
  const token = cookieValue(req);
  // Sign out every other browser, keep this one.
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iters = ?, must_change = 0, reset_requested_at = NULL, updated_at = ? WHERE id = ?")
      .bind(h.pw_hash, h.pw_salt, h.pw_iters, now(), u.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id_hash != ?").bind(u.id, await sha256(token)),
  ]);
  return json({ ok: true });
}

// ---------- Team page (admins) ----------

function requireAdmin(c: Caller) {
  if (!c.admin) throw new HttpError(403, "Only an admin can manage people");
}

/** An admin manages people of their own brand; a "*" admin manages everyone. */
function canManage(c: Caller, brand: string) {
  return c.brand === "*" || c.brand === brand;
}

async function managedUser(env: Env, c: Caller, id: string) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  if (!u || !canManage(c, u.brand)) throw new HttpError(404, "Person not found");
  return u;
}

function checkBrand(c: Caller, brand: unknown): string {
  const ok = [...BRANDS, "*"] as string[];
  if (typeof brand !== "string" || !ok.includes(brand)) throw new HttpError(400, `brand must be one of ${ok.join(", ")}`);
  if (!canManage(c, brand)) throw new HttpError(403, "You can only add people to your own brand");
  return brand;
}

function checkRole(role: unknown): "staff" | "admin" {
  if (role !== "staff" && role !== "admin") throw new HttpError(400, "role must be staff or admin");
  return role;
}

/** How many people this admin manages are waiting on a new password (0 for staff), for the Team link. */
export async function resetRequests(env: Env, u: UserRow) {
  if (u.role !== "admin") return 0;
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE reset_requested_at IS NOT NULL AND disabled = 0 AND (? = '*' OR brand = ?)")
    .bind(u.brand, u.brand).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function listUsers(env: Env, c: Caller) {
  requireAdmin(c);
  const rows =
    c.brand === "*"
      ? await env.DB.prepare("SELECT * FROM users ORDER BY brand, name").all<UserRow>()
      : await env.DB.prepare("SELECT * FROM users WHERE brand = ? ORDER BY name").bind(c.brand).all<UserRow>();
  return json({ users: rows.results.map(publicUser) });
}

export async function createUser(req: Request, env: Env, c: Caller) {
  requireAdmin(c);
  const b = await body<{ email?: string; name?: string; brand?: string; role?: string }>(req);
  const email = String(b.email ?? "").trim().toLowerCase();
  const name = String(b.name ?? "").trim();
  if (!EMAIL.test(email) || email.length > 200) throw new HttpError(400, "Enter a valid email address");
  if (!name || name.length > 100) throw new HttpError(400, "Enter the person's name");
  const brand = checkBrand(c, b.brand ?? (c.brand === "*" ? undefined : c.brand));
  const role = checkRole(b.role ?? "staff");
  if (await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()) throw new HttpError(409, "Someone already has that email");
  const password = tempPassword();
  const h = await hashPassword(password);
  const id = crypto.randomUUID();
  const t = now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, brand, role, pw_hash, pw_salt, pw_iters, must_change, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
  ).bind(id, email, name, brand, role, h.pw_hash, h.pw_salt, h.pw_iters, t, t).run();
  const u = (await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>())!;
  return json({ user: publicUser(u), tempPassword: password }, 201);
}

export async function updateUser(req: Request, env: Env, c: Caller, id: string) {
  requireAdmin(c);
  const u = await managedUser(env, c, id);
  const b = await body<{ name?: string; brand?: string; role?: string; disabled?: boolean }>(req);
  const name = b.name === undefined ? u.name : String(b.name).trim();
  if (!name || name.length > 100) throw new HttpError(400, "Enter the person's name");
  const brand = b.brand === undefined ? u.brand : checkBrand(c, b.brand);
  const role = b.role === undefined ? u.role : checkRole(b.role);
  const disabled = b.disabled === undefined ? u.disabled : b.disabled ? 1 : 0;
  if (c.user?.id === u.id && (disabled || role !== "admin" || brand !== u.brand)) throw new HttpError(400, "You can't lock yourself out. Ask another admin.");
  const stmts = [
    env.DB.prepare("UPDATE users SET name = ?, brand = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?").bind(name, brand, role, disabled, now(), id),
  ];
  if (disabled || brand !== u.brand) stmts.push(env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(id));
  await env.DB.batch(stmts);
  return json({ user: publicUser((await env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>())!) });
}

export async function resetPassword(env: Env, c: Caller, id: string) {
  requireAdmin(c);
  const u = await managedUser(env, c, id);
  const password = tempPassword();
  const h = await hashPassword(password);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iters = ?, must_change = 1, failed_logins = 0, locked_until = NULL, reset_requested_at = NULL, updated_at = ? WHERE id = ?")
      .bind(h.pw_hash, h.pw_salt, h.pw_iters, now(), u.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(u.id),
  ]);
  return json({ user: publicUser(u), tempPassword: password });
}
