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

test("admins choose several avatars for New video, with one default", async () => {
  assert.equal((await call("POST", "/api/heygen/roster", T.bgx, { id: "look_x1" })).status, 403);
  assert.equal((await call("POST", "/api/heygen/roster", T.admin, { id: "bad id!" })).status, 400);
  const d = await call("PUT", "/api/heygen/choice", T.admin, { id: "look_def001", name: "Davis office" });
  assert.equal(d.status, 200);
  const a = await call("POST", "/api/heygen/roster", T.admin, { id: "look_two002", name: "Davis shop floor" });
  assert.equal(a.status, 200, JSON.stringify(a.data));
  assert.equal(a.data.choice.id, "look_def001", "adding one keeps the default");
  assert.ok(a.data.looks.some((l) => l.id === "look_two002"));
  assert.ok(a.data.looks.some((l) => l.id === "look_def001"));
  const again = await call("POST", "/api/heygen/roster", T.admin, { id: "look_two002", name: "Davis shop floor" });
  assert.equal(again.data.looks.filter((l) => l.id === "look_two002").length, 1, "no duplicates");
  const g = await call("GET", "/api/heygen", T.admin);
  assert.ok(Array.isArray(g.data.looks));
  // Removing the default moves it to another avatar on offer.
  const r = await call("DELETE", "/api/heygen/roster/look_def001", T.admin);
  assert.equal(r.status, 200);
  assert.ok(!r.data.looks.some((l) => l.id === "look_def001"));
  assert.notEqual(r.data.choice?.id, "look_def001");
  assert.equal((await call("DELETE", "/api/heygen/roster/look_two002", T.bgx)).status, 403);
});

test("anyone signed in can load avatar pictures, still HeyGen only", async () => {
  assert.equal((await call("GET", `/api/heygen/preview?u=${encodeURIComponent("https://example.com/x.jpg")}`, T.bgx)).status, 400);
  assert.equal((await call("GET", `/api/heygen/preview?u=${encodeURIComponent("https://example.com/x.jpg")}`)).status, 401);
});

test("the preview proxy only fetches HeyGen images", async () => {
  assert.equal((await call("GET", `/api/heygen/preview?u=${encodeURIComponent("https://example.com/x.jpg")}`, T.admin)).status, 400);
  assert.equal((await call("GET", `/api/heygen/preview?u=${encodeURIComponent("http://files.heygen.ai/x.jpg")}`, T.admin)).status, 400);
  assert.equal((await call("GET", "/api/heygen/preview?u=nope", T.admin)).status, 400);
});

const W = "local-worker-token-0123456789abcdef";

test("New video only offers the AI avatar when it's ready, and says why not", async () => {
  assert.equal((await call("GET", "/api/heygen/available")).status, 401);
  const a = await call("GET", "/api/heygen/available", T.bgx);
  assert.equal(a.status, 200, "any signed-in person can ask");
  assert.equal(a.data.available, false);
  assert.match(a.data.reason, /isn't connected/);
});

test("the desktop reports what it can do along with its catalog", async () => {
  const before = await call("GET", "/api/catalog", T.admin);
  const campaigns = (before.data.campaigns ?? []).map((c) => ({ brand: c.brand, campaign: c.campaign, title: c.title, variants: c.variants }));
  const r = await call("PUT", "/api/desktop/catalog", W, { campaigns, features: ["heygen", "BAD feature!"] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal((await call("PUT", "/api/desktop/catalog", W, { campaigns })).status, 200, "older desktops send no features");
  assert.equal((await call("GET", "/api/desktop/heygen/abc123xyz", T.admin)).status, 401, "clip status is for the desktop only");
  assert.equal((await call("GET", "/api/desktop/heygen/bad%20id", W)).status, 400);
});

test("a build with the AI avatar is refused while it isn't available", async () => {
  const { formats } = (await call("GET", "/api/formats", T.bgx)).data;
  const r = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: { template: formats[0].id, title: "Avatar test", goal: "reach", look: "creator", presenter: { mode: "heygen", name: "Davis" } } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /AI avatar isn't available/);
  const bad = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: { template: formats[0].id, title: "Avatar test", goal: "reach", look: "creator", presenter: { mode: "robot", name: "Davis" } } });
  assert.match(bad.data.error, /Pick who's on camera/);
});
