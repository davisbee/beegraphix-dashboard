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
  assert.deepEqual((await call("GET", "/api/features", T.bgx)).data, { showcase: false, voiceover: false, broll: false, storead: false });
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
  const r = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ transition: "honeycomb" }) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const job = (await call("POST", "/api/desktop/claim", T.worker)).data;
  assert.equal(job.payload.variant, "showcase");
  assert.equal(job.payload.spec.look, "showcase");
  assert.equal(job.payload.spec.transition, "honeycomb");
  assert.deepEqual(job.payload.spec.presenter, { mode: "none", name: "", title: "" });
  assert.deepEqual(job.payload.spec.footage, {}, "no presenter footage without a presenter");
  assert.equal(job.payload.spec.greenScreen, false);
  await call("POST", `/api/desktop/jobs/${job.id}/fail`, T.worker, { message: "test" });
});

test("voiceovers: faceless only, need the desktop and the ElevenLabs key", async () => {
  assert.deepEqual((await call("GET", "/api/voices", T.bgx)).data, { ready: false, voices: [] });
  assert.equal((await call("GET", "/api/voices")).status, 401);
  await features(["heygen", "showcase"]);
  assert.equal((await call("GET", "/api/features", T.bgx)).data.voiceover, false);
  const r = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ voice: "AbCdEfGh12345678" }) });
  assert.match(r.data.error, /Voiceovers need a desktop update/);
  await features(["heygen", "showcase", "voiceover"]);
  const k = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ voice: "AbCdEfGh12345678" }) });
  assert.equal(k.status, 503);
  assert.match(k.data.error, /ELEVENLABS_API_KEY/);
  // A presenter video ignores a voice: the presenter already speaks.
  await drain();
  const p = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ presenter: { mode: "self", name: "Test" }, voice: "AbCdEfGh12345678" }) });
  assert.equal(p.status, 201, JSON.stringify(p.data));
  const job = (await call("POST", "/api/desktop/claim", T.worker)).data;
  assert.equal(job.payload.spec.voice, undefined);
  await call("POST", `/api/desktop/jobs/${job.id}/fail`, T.worker, { message: "test" });
  assert.equal((await call("GET", `/api/desktop/voice/${job.id}/hook`, T.bgx)).status, 401, "voice files are for the desktop");
  assert.equal((await call("GET", `/api/desktop/voice/${job.id}/hook`, T.worker)).status, 404);
  assert.equal((await call("GET", `/api/voices/preview?u=${encodeURIComponent("https://example.com/a.mp3")}`, T.bgx)).status, 400);
});

test("bad looks and transitions are refused", async () => {
  assert.match((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ transition: "spin" }) })).data.error, /Pick a transition/);
  const s = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ presenter: { mode: "self", name: "Test" }, look: "showcase" }) });
  assert.match(s.data.error, /Pick a look/, "showcase is only for faceless videos");
  await features(["heygen"]);
});

test("Guess the Price needs a price per product and puts it on each reveal beat", async () => {
  await features(["heygen", "showcase"]);
  const early = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ template: "price", title: "Too Early", beats: {} }) });
  assert.match(early.data.error, /Guess the Price needs a desktop update/);
  await features(["heygen", "showcase", "price-story"]);
  await drain();
  const three = (price) => [1, 2, 3].map((i) => ({ name: `Product ${i}`, style: `GP${i}`, link: "", script: `Guess ${i}.`, shortName: "", tag: "", photo: null, ...(price ? { price: `$${i}0 each` } : {}) }));
  const s = (products) => spec({ template: "price", title: "Guess the Price Test", products, beats: {} });
  const missing = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: s(three(false)) });
  assert.match(missing.data.error, /needs its price/);
  const ok = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: s(three(true)) });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  const job = (await call("POST", "/api/desktop/claim", T.worker)).data;
  assert.deepEqual(job.payload.spec.beats.map((b) => b.price), ["$10 each", "$20 each", "$30 each"]);
  assert.equal(job.payload.spec.products[0].price, "$10 each");
  await call("POST", `/api/desktop/jobs/${job.id}/fail`, T.worker, { message: "test" });
  const f = (await call("GET", "/api/formats", T.bgx)).data.formats.map((x) => x.id);
  assert.ok(f.includes("price") && f.includes("textstory"));
  await features(["heygen"]);
});

test("Logo to Gear needs the desktop and the customer's logo", async () => {
  const three = [1, 2, 3].map((i) => ({ name: `Piece ${i}`, style: `LG${i}`, link: "", script: `Piece ${i}.`, shortName: "", tag: "", photo: null }));
  const s = (over) => spec({ template: "mockup", title: "Logo to Gear Test", products: three, beats: {}, ...over });
  await features(["heygen", "showcase"]);
  assert.match((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: s({}) })).data.error, /Logo to Gear needs a desktop update/);
  await features(["heygen", "showcase", "mockup"]);
  assert.match((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: s({}) })).data.error, /Upload the customer's logo/);
  assert.match((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: s({ logo: "not-an-id" }) })).data.error, /Bad logo/);
  const missing = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: s({ logo: "00000000-0000-0000-0000-000000000000" }) });
  assert.equal(missing.status, 400, "the logo has to be an upload of this brand's");
  await features(["heygen"]);
});

test("faceless videos take shop footage behind a line once the desktop can play it", async () => {
  await drain();
  const up = "00000000-0000-0000-0000-000000000000";
  await features(["heygen", "showcase"]);
  assert.match((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ footage: { hook: up } }) })).data.error, /Shop footage needs a desktop update/);
  await features(["heygen", "showcase", "broll"]);
  const bad = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ footage: { hook: up } }) });
  assert.equal(bad.status, 400, "the clip must be this brand's finished upload");
  const none = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec() });
  assert.equal(none.status, 201, JSON.stringify(none.data));
  const job = (await call("POST", "/api/desktop/claim", T.worker)).data;
  assert.equal(job.payload.spec.broll, undefined);
  assert.deepEqual(job.payload.spec.footage, {});
  await call("POST", `/api/desktop/jobs/${job.id}/fail`, T.worker, { message: "test" });
  assert.equal((await call("GET", "/api/features", T.bgx)).data.broll, true);
  await features(["heygen"]);
});

test("store ads: an InkSoft link in, a store job with its caption out", async () => {
  const sa = (over) => ({ kind: "build", spec: { template: "storead", storeUrl: "https://stores.inksoft.com/171arw/shop/home", ...over } });
  assert.match((await call("POST", "/api/jobs", T.bgx, sa({ storeUrl: "https://example.com/shop" }))).data.error, /InkSoft link/);
  await features(["heygen"]);
  assert.match((await call("POST", "/api/jobs", T.bgx, sa({}))).data.error, /desktop update/);
  await features(["heygen", "storead"]);
  await drain();
  const r = await call("POST", "/api/jobs", T.bgx, sa({ note: "Orders close Friday" }));
  if (r.status === 400 && /no store/.test(r.data.error)) return; // InkSoft unreachable from this machine
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const job = (await call("POST", "/api/desktop/claim", T.worker)).data;
  assert.equal(job.payload.variant, "store");
  assert.equal(job.payload.spec.storeUri, "171arw");
  assert.equal(job.payload.spec.caption, "The 171st Air Refueling Wing store is open. Orders close Friday. Shop it here: https://stores.inksoft.com/171arw");
  assert.doesNotMatch(job.payload.spec.caption, /—/, "no em dashes");
  await call("POST", `/api/desktop/jobs/${job.id}/fail`, T.worker, { message: "test" });
  assert.equal((await call("GET", "/api/features", T.bgx)).data.storead, true);
  await features(["heygen"]);
});
