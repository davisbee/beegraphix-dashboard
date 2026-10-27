// End-to-end tests for the job queue API. Run against a local dev server:
//   npm run db:migrate:local && npm run dev     (in one terminal, uses .dev.vars)
//   npm test                                    (in another)
// DASHBOARD_URL points them somewhere else. Tokens match .dev.vars.example.
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.DASHBOARD_URL ?? "http://localhost:8787";
const T = {
  worker: "local-worker-token-0123456789abcdef",
  admin: "local-admin-token-0123456789abcdef",
  bgx: "local-bgx-token-0123456789abcdef",
  rugbee: "local-rugbee-token-0123456789abcdef",
};

async function call(method, path, token, body, raw) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body && !raw ? { "content-type": "application/json" } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, res };
}

// Claims until the queue is empty so each test starts clean, failing whatever it picked up.
async function drain() {
  for (;;) {
    const c = await call("POST", "/api/desktop/claim", T.worker);
    if (c.status === 204) return;
    await call("POST", `/api/desktop/jobs/${c.data.id}/fail`, T.worker, { message: "drained by test" });
  }
}

test("health is public, everything else needs a token", async () => {
  assert.equal((await call("GET", "/api/health")).status, 200);
  assert.equal((await call("GET", "/api/jobs")).status, 401);
  assert.equal((await call("GET", "/api/jobs", "wrong-token-but-long-enough-000000")).status, 401);
  assert.equal((await call("POST", "/api/desktop/claim")).status, 401);
  assert.equal((await call("POST", "/api/desktop/claim", T.bgx)).status, 401, "a brand token is not the desktop token");
  assert.equal((await call("GET", "/api/jobs", T.worker)).status, 401, "the desktop token can't submit or list");
});

test("submit validates input and stamps the token's brand", async () => {
  assert.equal((await call("POST", "/api/jobs", T.bgx, { campaign: "Bad Id", variant: "x" })).status, 400);
  assert.equal((await call("POST", "/api/jobs", T.bgx, { campaign: "a", variant: "../x" })).status, 400);
  assert.equal((await call("POST", "/api/jobs", T.bgx, { brand: "rugbee", campaign: "a", variant: "b" })).status, 403);
  assert.equal((await call("POST", "/api/jobs", T.admin, { campaign: "a", variant: "b" })).status, 400, "admin must name a brand");
  assert.equal((await call("POST", "/api/jobs", T.admin, { brand: "acme", campaign: "a", variant: "b" })).status, 400);
  const r = await call("POST", "/api/jobs", T.bgx, { campaign: "carhartt-fall-2026", variant: "creator", draft: true });
  assert.equal(r.status, 201);
  assert.equal(r.data.brand, "beegraphix");
  assert.equal(r.data.status, "queued");
  assert.deepEqual(r.data.payload, { campaign: "carhartt-fall-2026", variant: "creator", draft: true });
  await call("POST", `/api/jobs/${r.data.id}/cancel`, T.bgx);
});

test("each brand only sees its own jobs", async () => {
  const b = (await call("POST", "/api/jobs", T.bgx, { campaign: "c1", variant: "v" })).data;
  const r = (await call("POST", "/api/jobs", T.rugbee, { campaign: "c2", variant: "v" })).data;
  const bList = (await call("GET", "/api/jobs", T.bgx)).data.jobs.map((j) => j.id);
  const rList = (await call("GET", "/api/jobs", T.rugbee)).data.jobs.map((j) => j.id);
  assert.ok(bList.includes(b.id) && !bList.includes(r.id));
  assert.ok(rList.includes(r.id) && !rList.includes(b.id));
  assert.ok((await call("GET", "/api/jobs", T.bgx)).data.jobs.every((j) => j.brand === "beegraphix"));
  assert.equal((await call("GET", `/api/jobs/${r.id}`, T.bgx)).status, 404);
  assert.equal((await call("POST", `/api/jobs/${r.id}/cancel`, T.bgx)).status, 404);
  assert.equal((await call("GET", `/api/jobs/${r.id}/video`, T.bgx)).status, 404);
  assert.equal((await call("GET", `/api/jobs/${r.id}`, T.admin)).status, 200);
  for (const [j, t] of [[b, T.bgx], [r, T.rugbee]]) assert.equal((await call("POST", `/api/jobs/${j.id}/cancel`, t)).data.status, "cancelled");
});

test("the desktop claims oldest first, renders, uploads in parts, and the brand downloads it", async () => {
  await drain();
  const first = (await call("POST", "/api/jobs", T.rugbee, { campaign: "first", variant: "v" })).data;
  const second = (await call("POST", "/api/jobs", T.bgx, { campaign: "second", variant: "v" })).data;

  const claimed = await call("POST", "/api/desktop/claim", T.worker);
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.id, first.id);
  assert.equal(claimed.data.status, "claimed");
  assert.equal(claimed.data.attempts, 1);

  assert.equal((await call("POST", `/api/jobs/${first.id}/cancel`, T.rugbee)).status, 409, "a claimed job can't be cancelled");
  assert.equal((await call("POST", `/api/desktop/jobs/${first.id}/heartbeat`, T.worker, { status: "done" })).status, 400);
  const hb = await call("POST", `/api/desktop/jobs/${first.id}/heartbeat`, T.worker, { status: "rendering", progress: 0.4, message: "Rendering 40%" });
  assert.equal(hb.data.status, "rendering");
  assert.equal(hb.data.progress, 0.4);
  assert.equal((await call("GET", `/api/jobs/${first.id}/video`, T.rugbee)).status, 409, "no video before upload");

  // 6 MB + 1 KB: two parts, the first at R2's 5 MB minimum.
  const video = new Uint8Array(6 * 1024 * 1024 + 1024);
  for (let i = 0; i < video.length; i++) video[i] = (i * 31 + 7) & 255;
  assert.equal((await call("PUT", `/api/desktop/jobs/${first.id}/upload/part?n=1`, T.worker, null, video)).status, 409, "start first");
  const start = await call("POST", `/api/desktop/jobs/${first.id}/upload/start`, T.worker);
  assert.equal(start.status, 200);
  assert.equal(start.data.key, `outputs/rugbee/${first.id}.mp4`);
  const cut = 6 * 1024 * 1024;
  const p1 = await call("PUT", `/api/desktop/jobs/${first.id}/upload/part?n=1`, T.worker, null, video.slice(0, cut));
  const p2 = await call("PUT", `/api/desktop/jobs/${first.id}/upload/part?n=2`, T.worker, null, video.slice(cut));
  assert.equal(p1.status, 200);
  assert.equal(p2.status, 200);
  const done = await call("POST", `/api/desktop/jobs/${first.id}/upload/complete`, T.worker, { parts: [p1.data, p2.data] });
  assert.equal(done.status, 200);
  assert.equal(done.data.status, "done");
  assert.equal(done.data.outputBytes, video.length);
  assert.equal(done.data.hasVideo, true);

  const dl = await fetch(`${BASE}/api/jobs/${first.id}/video`, { headers: { authorization: `Bearer ${T.rugbee}` } });
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "video/mp4");
  const got = new Uint8Array(await dl.arrayBuffer());
  assert.equal(got.length, video.length);
  assert.ok(got.every((v, i) => v === video[i]), "downloaded bytes match");
  assert.equal((await call("GET", `/api/jobs/${first.id}/video`, T.bgx)).status, 404, "other brand can't download it");

  assert.equal((await call("POST", `/api/desktop/jobs/${first.id}/heartbeat`, T.worker, { status: "rendering" })).status, 409, "finished jobs are closed");

  const next = await call("POST", "/api/desktop/claim", T.worker);
  assert.equal(next.data.id, second.id);
  const failed = await call("POST", `/api/desktop/jobs/${second.id}/fail`, T.worker, { message: "Campaign isn't on this PC." });
  assert.equal(failed.data.status, "failed");
  assert.equal((await call("GET", `/api/jobs/${second.id}`, T.bgx)).data.message, "Campaign isn't on this PC.");
  assert.equal((await call("POST", "/api/desktop/claim", T.worker)).status, 204);
});

test("cancelled jobs are never handed to the desktop", async () => {
  await drain();
  const j = (await call("POST", "/api/jobs", T.bgx, { campaign: "c", variant: "v" })).data;
  assert.equal((await call("POST", `/api/jobs/${j.id}/cancel`, T.bgx)).data.status, "cancelled");
  assert.equal((await call("POST", "/api/desktop/claim", T.worker)).status, 204);
});
