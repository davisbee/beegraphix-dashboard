// New video: uploads, "Draft it for me" and build jobs. Same local dev server as api.test.mjs.
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
  const buf = Buffer.from(await res.arrayBuffer());
  let data = null;
  try { data = JSON.parse(buf.toString()); } catch { data = buf; }
  return { status: res.status, data, res };
}

async function upload(token, kind, type, bytes, brand = "") {
  const s = await call("POST", `/api/uploads${brand ? `?brand=${brand}` : ""}`, token, { kind, name: `test.${type.split("/")[1]}`, type, size: bytes.length });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  const parts = [];
  for (let n = 1, off = 0; off < bytes.length; n++, off += s.data.partBytes) {
    const p = await call("PUT", `/api/uploads/${s.data.upload.id}/part?n=${n}`, token, null, bytes.subarray(off, off + s.data.partBytes));
    assert.equal(p.status, 200, JSON.stringify(p.data));
    parts.push(p.data);
  }
  const c = await call("POST", `/api/uploads/${s.data.upload.id}/complete`, token, { parts });
  assert.equal(c.status, 200, JSON.stringify(c.data));
  assert.equal(c.data.upload.status, "ready");
  return c.data.upload;
}

const spec = (over = {}) => ({
  template: "top5", title: "Top 5 Test Picks", goal: "reach", audience: "crews", look: "creator",
  presenter: { mode: "self", name: "Test Person", title: "" },
  hook: "Stop buying the wrong gear.", hookText: "Stop buying the wrong gear", cta: "Hit the link below.", link: "beegraphix.com/test", greenScreen: false,
  products: [1, 2, 3, 4, 5].map((i) => ({ name: `Product ${i}`, style: `ST${i}`, link: "", script: `Number ${i}, product ${i}.`, shortName: "", tag: "", photo: null })),
  footage: {},
  ...over,
});

async function drain() {
  for (;;) {
    const c = await call("POST", "/api/desktop/claim", T.worker);
    if (c.status === 204) return;
    await call("POST", `/api/desktop/jobs/${c.data.id}/fail`, T.worker, { message: "drained by test" });
  }
}

test("uploads check the file type and size", async () => {
  assert.equal((await call("POST", "/api/uploads", T.bgx, { kind: "footage", name: "a.exe", type: "application/x-msdownload", size: 10 })).status, 400);
  assert.equal((await call("POST", "/api/uploads", T.bgx, { kind: "photo", name: "a.jpg", type: "image/jpeg", size: 26 * 1024 * 1024 })).status, 400);
  assert.equal((await call("POST", "/api/uploads", T.bgx, { kind: "photo", name: "a.jpg", type: "image/jpeg", size: 0 })).status, 400);
  assert.equal((await call("POST", "/api/uploads", T.admin, { kind: "photo", name: "a.jpg", type: "image/jpeg", size: 5 })).status, 400, "admin must name a brand");
  assert.equal((await call("POST", "/api/uploads", null, { kind: "photo", name: "a.jpg", type: "image/jpeg", size: 5 })).status, 401);
});

test("a big video goes up in pieces and the desktop gets it back byte for byte", async () => {
  const bytes = Buffer.alloc(21 * 1024 * 1024 + 123);
  for (let i = 0; i < bytes.length; i += 4096) bytes[i] = i % 251;
  const up = await upload(T.bgx, "footage", "video/mp4", bytes);
  assert.equal(up.bytes, bytes.length);
  // Another brand can't touch it, and staff can't download through the desktop route.
  assert.equal((await call("PUT", `/api/uploads/${up.id}/part?n=1`, T.rugbee, null, Buffer.from("x"))).status, 404);
  assert.equal((await call("GET", `/api/desktop/uploads/${up.id}`, T.bgx)).status, 401);
  const d = await call("GET", `/api/desktop/uploads/${up.id}`, T.worker);
  assert.equal(d.status, 200);
  assert.equal(d.res.headers.get("content-type"), "video/mp4");
  assert.ok(Buffer.compare(d.data, bytes) === 0, "downloaded file matches");
});

test("Draft it for me says it's off until the Claude key is set", async () => {
  const products = [1, 2, 3, 4, 5].map((i) => ({ name: `P${i}` }));
  const r = await call("POST", "/api/draft", T.bgx, { goal: "reach", products });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /switched on/);
});

test("build jobs validate the spec and only use the brand's own uploads", async () => {
  await drain();
  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ products: [] }) })).status, 400);
  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ hook: "" }) })).status, 400);
  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ goal: "viral" }) })).status, 400);
  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ presenter: { mode: "heygen", name: "x" } }) })).status, 400);
  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ link: "not a link" }) })).status, 400);

  const rugPhoto = await upload(T.rugbee, "photo", "image/png", Buffer.from("png-bytes"));
  const bgxPhoto = await upload(T.bgx, "photo", "image/jpeg", Buffer.from("jpg-bytes"));
  const bgxClip = await upload(T.admin, "footage", "video/quicktime", Buffer.from("mov-bytes"), "beegraphix");
  const withPhoto = (id) => spec({ products: spec().products.map((p, i) => (i === 0 ? { ...p, photo: id } : p)) });
  const wrong = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: withPhoto(rugPhoto.id) });
  assert.equal(wrong.status, 400, "another brand's photo");
  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spec({ footage: { hook: bgxPhoto.id } }) })).status, 400, "a photo isn't footage");

  const ok = await call("POST", "/api/jobs", T.bgx, { kind: "build", draft: true, spec: { ...withPhoto(bgxPhoto.id), footage: { hook: bgxClip.id, p9: "ignored" } } });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.kind, "build");
  assert.equal(ok.data.brand, "beegraphix");
  assert.match(ok.data.payload.campaign, /^top-5-test-picks-[0-9a-f]{6}$/);
  assert.equal(ok.data.payload.variant, "creator");
  assert.equal(ok.data.payload.title, "Top 5 Test Picks");
  assert.deepEqual(ok.data.payload.spec.footage, { hook: bgxClip.id });
  assert.equal(ok.data.payload.spec.products[0].photo, bgxPhoto.id);

  const c = await call("POST", "/api/desktop/claim", T.worker);
  assert.equal(c.data.id, ok.data.id);
  assert.equal(c.data.kind, "build");
  await call("POST", `/api/desktop/jobs/${c.data.id}/fail`, T.worker, { message: "test" });
});

test("staff can see their own brand's photos, not footage or another brand's", async () => {
  const photo = await upload(T.bgx, "photo", "image/png", Buffer.from("png-bytes"));
  const clip = await upload(T.bgx, "footage", "video/mp4", Buffer.from("mp4-bytes"));
  const r = await call("GET", `/api/uploads/${photo.id}/file`, T.bgx);
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get("content-type"), "image/png");
  assert.equal(r.data.toString(), "png-bytes");
  assert.equal((await call("GET", `/api/uploads/${photo.id}/file`, T.rugbee)).status, 404);
  assert.equal((await call("GET", `/api/uploads/${clip.id}/file`, T.bgx)).status, 404);
  assert.equal((await call("GET", `/api/uploads/${photo.id}/file`)).status, 401);
});

test("product lookup refuses addresses that aren't public web pages", async () => {
  for (const url of ["not a url", "localhost:8787", "http://127.0.0.1/x", "ftp://example.com/x", "intranet"]) {
    const r = await call("POST", "/api/lookup", T.bgx, { url });
    assert.equal(r.status, 400, url);
  }
  assert.equal((await call("POST", "/api/lookup/image", T.bgx, { url: "http://10.0.0.1/a.jpg" })).status, 400);
  assert.equal((await call("POST", "/api/lookup", null, { url: "https://example.com" })).status, 401);
});

test("style number lookup needs a style and the S&S login", async () => {
  assert.equal((await call("POST", "/api/lookup/style", null, { style: "5000" })).status, 401);
  assert.equal((await call("POST", "/api/lookup/style", T.bgx, { style: " " })).status, 400);
  // .dev.vars.example has no S&S login, so the lookup says it isn't set up rather than failing.
  const r = await call("POST", "/api/lookup/style", T.bgx, { style: "5000" });
  assert.equal(r.status, 503);
  assert.match(r.data.error, /isn't set up/);
});

test("each format lays out its own beats, and This vs That needs a winner", async () => {
  await drain();
  const f = await call("GET", "/api/formats", T.bgx);
  assert.equal(f.status, 200);
  assert.deepEqual(f.data.formats.map((x) => x.id), ["top5", "spotlight", "versus", "mistakes", "story", "program"]);

  const one = (o = {}) => ({ name: "Thing", style: "", link: "", script: "It fixes that.", shortName: "", tag: "", photo: null, ...o });
  const spotlight = spec({
    template: "spotlight", title: "The Hoodie Crews Wear",
    products: [one({ style: "pc78h" })],
    beats: { problem: { script: "Nobody wears the hoodie.", text: "Hoodies nobody wears" }, proof: { script: "Our crew wears it daily.", text: "" } },
    footage: {},
  });
  const s = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: spotlight });
  assert.equal(s.status, 201, JSON.stringify(s.data));
  const beats = s.data.payload.spec.beats;
  assert.deepEqual(beats.map((b) => [b.id, b.kind]), [["problem", "talk"], ["fix", "product"], ["proof", "talk"]]);
  assert.equal(beats[1].script, "It fixes that.");
  assert.equal(beats[1].badge, "");
  assert.equal(beats[0].text, "Hoodies nobody wears");
  assert.equal(s.data.payload.spec.products[0].style, "PC78H");
  assert.equal(s.data.payload.spec.ctaEyebrow, "Get yours");

  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: { ...spotlight, beats: { problem: { script: "" } } } })).status, 400, "every beat needs its line");
  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: { ...spotlight, products: [one(), one()] } })).status, 400, "spotlight is one product");

  const versus = spec({ template: "versus", title: "This vs That Test", products: [one({ name: "A" }), one({ name: "B" })], beats: { verdict: { script: "B wins.", text: "B wins" } } });
  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: versus })).status, 400, "needs a winner");
  const v = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: { ...versus, winner: 1 } });
  assert.equal(v.status, 201, JSON.stringify(v.data));
  assert.equal(v.data.payload.spec.winner, 1);
  assert.deepEqual(v.data.payload.spec.beats[2].products, [0, 1]);

  const program = spec({
    template: "program", title: "FAN Fundraiser Test", products: [one({ name: "FAN Fundraiser", style: "IGNORED", script: "" })],
    beats: { problem: { script: "Fundraising is a pain." }, what: { text: "Keep up to 90%" }, how: { script: "Here's how.", text: "Pick gear\n\nShare the store\nWe ship it" }, proof: { script: "One team raised $3,000." } },
  });
  assert.equal((await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: program })).status, 400, "the program's own line is required");
  program.products[0].script = "It's a fan store that pays you.";
  const pg = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: program });
  assert.equal(pg.status, 201, JSON.stringify(pg.data));
  assert.equal(pg.data.payload.spec.products[0].style, "", "programs have no style number");
  assert.equal(pg.data.payload.spec.beats.find((b) => b.id === "how").text, "Pick gear\nShare the store\nWe ship it");
  await drain();
});

test("drafts save, update, stay in their brand, and delete", async () => {
  const form = { template: "spotlight", title: "", topic: "Winter hoodies", products: [{ name: "Hoodie" }] };
  assert.equal((await call("POST", "/api/drafts?brand=beegraphix", T.bgx, { data: { template: "nope" } })).status, 400, "unknown format");
  const c = await call("POST", "/api/drafts?brand=beegraphix", T.bgx, { title: "", data: form });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  const id = c.data.draft.id;
  assert.equal(c.data.draft.title, "Untitled video");
  assert.equal(c.data.draft.format, "Product Spotlight");

  const u = await call("PUT", `/api/drafts/${id}`, T.bgx, { title: "Winter hoodies", data: { ...form, hook: "Cold?" } });
  assert.equal(u.status, 200, JSON.stringify(u.data));
  const g = await call("GET", `/api/drafts/${id}`, T.bgx);
  assert.equal(g.data.draft.title, "Winter hoodies");
  assert.equal(g.data.draft.data.hook, "Cold?");
  assert.ok((await call("GET", "/api/drafts?brand=beegraphix", T.bgx)).data.drafts.some((d) => d.id === id));

  assert.equal((await call("GET", `/api/drafts/${id}`, T.rugbee)).status, 404, "another brand can't open it");
  assert.equal((await call("DELETE", `/api/drafts/${id}`, T.rugbee)).status, 404, "or delete it");
  assert.ok(!(await call("GET", "/api/drafts?brand=rugbee", T.rugbee)).data.drafts.some((d) => d.id === id));

  assert.equal((await call("POST", "/api/drafts?brand=beegraphix", T.bgx, { data: { ...form, notes: "x".repeat(250_000) } })).status, 413);
  assert.equal((await call("DELETE", `/api/drafts/${id}`, T.bgx)).status, 200);
  assert.equal((await call("GET", `/api/drafts/${id}`, T.bgx)).status, 404);
});

test("approve and post: copy, preview, only admins approve, and the desktop reports back", async () => {
  await drain();
  const sp = spec({
    template: "spotlight", title: "Post Test Hoodie", products: [{ name: "Hoodie", style: "PC78H", link: "", script: "It fixes that.", shortName: "", tag: "", photo: null }],
    beats: { problem: { script: "Nobody wears them.", text: "Nobody wears them" }, fix: { text: "Soft and tough" }, proof: { script: "Our crew does.", text: "Worn daily" } },
  });
  const made = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: sp });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const id = made.data.id;
  const slug = `post-test-${Date.now().toString(36)}`; // the local database keeps addresses between runs
  assert.equal((await call("GET", `/api/jobs/${id}/post`, T.bgx)).data.supported, true);
  assert.equal((await call("PUT", `/api/jobs/${id}/post`, T.bgx, { slug: "x", copy: {} })).status, 400, "slug too short");
  const copy = { page: { title: "Hoodie | BeeGraphix", headline: "The hoodie your crew wears", description: "d" }, captions: { facebook: "Look — at this {url}" } };
  assert.equal((await call("POST", `/api/jobs/${id}/post/preview`, T.bgx)).status, 409, "needs copy and a finished video");
  const put = await call("PUT", `/api/jobs/${id}/post`, T.bgx, { slug, copy, start: "2099-01-05" });
  assert.equal(put.status, 200, JSON.stringify(put.data));
  assert.equal(put.data.post.copy.captions.facebook, "Look, at this {url}", "no em dashes");
  assert.equal(put.data.link, `https://blog.beegraphix.com/${slug}/`);
  assert.equal((await call("POST", `/api/jobs/${id}/post/draft`, T.bgx)).status, 503, "Claude is off in tests");
  assert.equal((await call("GET", `/api/jobs/${id}/post`, T.rugbee)).status, 404, "other brand");

  // finish the video
  const job = (await call("POST", "/api/desktop/claim", T.worker)).data;
  assert.equal(job.id, id);
  assert.equal((await call("POST", `/api/desktop/jobs/${id}/finish`, T.worker, {})).status, 409, "a video job needs its video");
  await call("POST", `/api/desktop/jobs/${id}/upload/start`, T.worker);
  const part = await call("PUT", `/api/desktop/jobs/${id}/upload/part?n=1`, T.worker, null, Buffer.from("fake mp4"));
  assert.equal((await call("POST", `/api/desktop/jobs/${id}/upload/complete`, T.worker, { parts: [part.data] })).status, 200);

  const pv = await call("POST", `/api/jobs/${id}/post/preview`, T.bgx);
  assert.equal(pv.status, 202, JSON.stringify(pv.data));
  assert.equal(pv.data.post.task.kind, "page");
  assert.equal((await call("POST", `/api/jobs/${id}/post/preview`, T.bgx)).status, 409, "busy");
  assert.ok(!(await call("GET", "/api/jobs", T.bgx)).data.jobs.some((j) => j.kind === "page"), "page jobs stay off the Videos list");
  const pj = (await call("POST", "/api/desktop/claim", T.worker)).data;
  assert.equal(pj.kind, "page");
  assert.equal(pj.payload.slug, slug);
  assert.equal(pj.payload.copy.page.headline, "The hoodie your crew wears");
  // the images: the desktop sends PNGs, the dashboard shows them on the video's page
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake image")]);
  assert.equal((await call("PUT", `/api/desktop/jobs/${pj.id}/stills/carousel-1`, T.worker, null, png)).status, 200);
  assert.equal((await call("PUT", `/api/desktop/jobs/${pj.id}/stills/teaser-1-feed`, T.worker, null, png)).status, 200);
  assert.equal((await call("PUT", `/api/desktop/jobs/${pj.id}/stills/evil`, T.worker, null, png)).status, 400, "unknown name");
  assert.equal((await call("PUT", `/api/desktop/jobs/${pj.id}/stills/carousel-2`, T.worker, null, Buffer.from("not a png"))).status, 400, "PNG only");
  assert.equal((await call("PUT", `/api/desktop/jobs/${id}/stills/carousel-1`, T.worker, null, png)).status, 409, "only page and publish jobs");
  await call("POST", `/api/desktop/jobs/${pj.id}/finish`, T.worker, { message: "Preview ready", result: { previewUrl: `https://preview.beegraphix-blog.pages.dev/${slug}/`, stills: ["carousel-1", "teaser-1-feed", "../x"] } });
  const ready = (await call("GET", `/api/jobs/${id}/post`, T.bgx)).data.post;
  assert.equal(ready.previewUrl, `https://preview.beegraphix-blog.pages.dev/${slug}/`);
  assert.deepEqual(ready.stills, ["carousel-1", "teaser-1-feed"]);
  const img = await fetch(`${BASE}/api/jobs/${id}/stills/carousel-1`, { headers: { authorization: `Bearer ${T.bgx}` } });
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await img.arrayBuffer()).equals(png));
  assert.equal((await fetch(`${BASE}/api/jobs/${id}/stills/carousel-1`, { headers: { authorization: `Bearer ${T.rugbee}` } })).status, 404, "other brand");
  // new words on the images mean the images are out of date; caption edits don't
  await call("PUT", `/api/jobs/${id}/post`, T.bgx, { copy: { ...copy, captions: { ...copy.captions, teaser1: "Day one {url}" } } });
  assert.equal((await call("GET", `/api/jobs/${id}/post`, T.bgx)).data.post.stills.length, 2);
  const words = await call("PUT", `/api/jobs/${id}/post`, T.bgx, { copy: { ...copy, images: { teaser1: " Stop \n buying \n the \n wrong " } } });
  assert.equal(words.data.post.copy.images.teaser1, "Stop\nbuying\nthe", "3 lines at most");
  assert.deepEqual(words.data.post.stills, []);

  assert.equal((await call("POST", `/api/jobs/${id}/post/approve`, T.bgx, {})).status, 403, "staff can't approve");
  const ap = await call("POST", `/api/jobs/${id}/post/approve`, T.admin, { start: "2099-01-06" });
  assert.equal(ap.status, 202, JSON.stringify(ap.data));
  const pub = (await call("POST", "/api/desktop/claim", T.worker)).data;
  assert.equal(pub.kind, "publish");
  assert.equal(pub.payload.start, "2099-01-06");
  assert.equal(pub.payload.link, `blog.beegraphix.com/${slug}`);
  await call("POST", `/api/desktop/jobs/${pub.id}/finish`, T.worker, { message: "Posted", result: { liveUrl: `https://blog.beegraphix.com/${slug}/`, posted: [{ platform: "facebook", status: "scheduled" }] } });
  const after = (await call("GET", `/api/jobs/${id}/post`, T.bgx)).data.post;
  assert.equal(after.liveUrl, `https://blog.beegraphix.com/${slug}/`);
  assert.equal(after.posted[0].platform, "facebook");
  assert.equal((await call("PUT", `/api/jobs/${id}/post`, T.bgx, { copy })).status, 409, "posted ones are locked");

  // another video can't take the same address
  const other = await call("POST", "/api/jobs", T.bgx, { kind: "build", spec: { ...sp, title: "Other Hoodie" } });
  assert.equal((await call("PUT", `/api/jobs/${other.data.id}/post`, T.bgx, { slug, copy })).status, 409);
  // Rugbee can't post yet
  const rb = await call("POST", "/api/jobs", T.rugbee, { kind: "build", spec: sp });
  assert.equal((await call("GET", `/api/jobs/${rb.data.id}/post`, T.rugbee)).data.supported, false);
  await drain();
});
