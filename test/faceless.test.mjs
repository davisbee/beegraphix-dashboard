// Faceless (Showcase) videos and transitions. Same local dev server as api.test.mjs. Runs after heygen.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.DASHBOARD_URL ?? "http://localhost:8787";
const T = { worker: "local-worker-token-0123456789abcdef", admin: "local-admin-token-0123456789abcdef", bgx: "local-bgx-token-0123456789abcdef" };

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

const spec = (over = {}) => ({
  template: "top5", title: "Faceless Test Picks", goal: "reach", audience: "crews", look: "creator",
  presenter: { mode: "none" },
  hook: "Stop buying the wrong gear.", hookText: "Stop buying the wrong gear", cta: "Hit the link below.", link: "", greenScreen: true,
  products: [1, 2, 3, 4, 5].map((i) => ({ name: `Product ${i}`, style: `FL${i}`, link: "", script: `Number ${i}, product ${i}.`, shortName: "", tag: "", photo: null })),
  footage: {},
  ...over,
});

async function features(list) {
  const campaigns = ((await call("GET", "/api/catalog", T.admin)).data.campaigns ?? []).map((c) => ({ brand: c.brand, campaign: c.campaign, title: c.title, variants: c.variants }));
  assert.equal((await call("PUT", "/api/desktop/catalog", T.worker, { campaigns, features: list })).status, 200);
}

async function drain() {
  for (;;) {
    const c = await call("POST", "/api/desktop/claim", T.worker);
    if (c.status === 204) return;
    await call("POST", `/api/desktop/jobs/${c.data.id}/fail`, T.worker, { message: "drained by test" });
  }
}

test("faceless and transitions wait for a desktop that can render them", async () => {
  await features(["heygen"]);
  assert.deepEqual((await call("GET", "/api/features", T.bgx)).data, { showcase: false });
  const r = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec() });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /desktop update/);
  const t = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ presenter: { mode: "self", name: "Test" }, transition: "whip" }) });
  assert.match(t.data.error, /Transitions need a desktop update/);
});

test("a faceless build renders the Showcase look, with no presenter and no footage", async () => {
  await features(["heygen", "showcase"]);
  assert.equal((await call("GET", "/api/features", T.bgx)).data.showcase, true);
  await drain();
  const r = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ transition: "honeycomb", footage: { hook: "00000000-0000-0000-0000-000000000000" } }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const job = (await call("POST", "/api/desktop/claim", T.worker)).data;
  assert.equal(job.payload.variant, "showcase");
  assert.equal(job.payload.spec.look, "showcase");
  assert.equal(job.payload.spec.transition, "honeycomb");
  assert.deepEqual(job.payload.spec.presenter, { mode: "none", name: "", title: "" });
  assert.deepEqual(job.payload.spec.footage, {}, "footage is ignored without a presenter");
  assert.equal(job.payload.spec.greenScreen, false);
  await call("POST", `/api/desktop/jobs/${job.id}/fail`, T.worker, { message: "test" });
});

test("bad looks and transitions are refused", async () => {
  assert.match((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ transition: "spin" }) })).data.error, /Pick a transition/);
  const s = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ presenter: { mode: "self", name: "Test" }, look: "showcase" }) });
  assert.match(s.data.error, /Pick a look/, "showcase is only for faceless videos");
  await features(["heygen"]);
});
