// AI avatar setup (heygen.ts). Same local dev server as api.test.mjs; .dev.vars has no HEYGEN_API_KEY,
// so these check the guard rails, not HeyGen itself.
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.DASHBOARD_URL ?? "http://localhost:8787";
const T = { admin: "local-admin-token-0123456789abcdef", bgx: "local-bgx-token-0123456789abcdef" };

async function call(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  return { status: res.status, data };
}

test("only admins can set up the AI avatar", async () => {
  assert.equal((await call("GET", "/api/heygen")).status, 401);
  assert.equal((await call("GET", "/api/heygen", T.bgx)).status, 403);
  assert.equal((await call("PUT", "/api/heygen/choice", T.bgx, { id: "look_1" })).status, 403);
  assert.equal((await call("POST", "/api/heygen/test", T.bgx, { mode: "clear" })).status, 403);
});

test("without the key it says so instead of calling HeyGen", async () => {
  const r = await call("GET", "/api/heygen", T.admin);
  assert.equal(r.status, 200);
  assert.equal(r.data.ready, false);
  const l = await call("GET", "/api/heygen/looks", T.admin);
  assert.equal(l.status, 503);
  assert.match(l.data.error, /HEYGEN_API_KEY/);
});

test("picking a look is saved, and a test clip needs the key", async () => {
  assert.equal((await call("PUT", "/api/heygen/choice", T.admin, { id: "" })).status, 400);
  assert.equal((await call("PUT", "/api/heygen/choice", T.admin, { id: "bad id!" })).status, 400);
  const c = await call("PUT", "/api/heygen/choice", T.admin, { id: "look_abc123", name: "Davis office", preview: "https://files.heygen.ai/x.jpg" });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.choice.id, "look_abc123");
  const g = await call("GET", "/api/heygen", T.admin);
  assert.equal(g.data.choice.name, "Davis office");
  assert.equal(g.data.test, null);
  assert.equal((await call("POST", "/api/heygen/test", T.admin, { mode: "clear" })).status, 503);
});

test("the preview proxy only fetches HeyGen images", async () => {
  assert.equal((await call("GET", `/api/heygen/preview?u=${encodeURIComponent("https://example.com/x.jpg")}`, T.admin)).status, 400);
  assert.equal((await call("GET", `/api/heygen/preview?u=${encodeURIComponent("http://files.heygen.ai/x.jpg")}`, T.admin)).status, 400);
  assert.equal((await call("GET", "/api/heygen/preview?u=nope", T.admin)).status, 400);
});
