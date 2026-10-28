// End-to-end tests for logins, the Team API, the campaign list and video streaming.
// Same setup as api.test.mjs: run against `npm run dev` with .dev.vars from .dev.vars.example.
import { test } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.DASHBOARD_URL ?? "http://localhost:8787";
const T = {
  worker: "local-worker-token-0123456789abcdef",
  admin: "local-admin-token-0123456789abcdef",
};
const run = Date.now().toString(36);
const email = (who) => `${who}-${run}@example.com`;

/** A browser: keeps the session cookie and sends the dashboard's CSRF header. */
function browser() {
  let cookie = "";
  const call = async (method, path, body, extra = {}) => {
    const res = await fetch(BASE + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        "x-requested-with": "dashboard",
        ...(body ? { "content-type": "application/json" } : {}),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, res };
  };
  return { call, get cookie() { return cookie; } };
}

async function token(method, path, tok, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { authorization: `Bearer ${tok}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

/** Creates a person with the admin token, signs them in and replaces the temporary password. */
async function person(who, brand, role = "staff") {
  const r = await token("POST", "/api/users", T.admin, { email: email(who), name: who, brand, role });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const b = browser();
  assert.equal((await b.call("POST", "/api/login", { email: email(who), password: r.data.tempPassword })).status, 200);
  const password = `${who}-new-password-${run}`;
  assert.equal((await b.call("POST", "/api/me/password", { current: r.data.tempPassword, next: password })).status, 200);
  return { b, id: r.data.user.id, password };
}

test("the screens are served, the API still needs a login", async () => {
  const home = await fetch(BASE + "/");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<div id="app">/);
  assert.match((await fetch(BASE + "/videos/abc")).headers.get("content-type") ?? "", /text\/html/, "deep links load the app");
  assert.equal((await fetch(BASE + "/api/me")).status, 401);
  assert.equal((await fetch(BASE + "/api/jobs")).status, 401);
  assert.equal((await fetch(BASE + "/api/nope")).status, 401);
});

test("first sign in: temporary password, then a new one is required", async () => {
  const r = await token("POST", "/api/users", T.admin, { email: email("first"), name: "First Person", brand: "beegraphix" });
  assert.equal(r.status, 201);
  assert.match(r.data.tempPassword, /^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);
  assert.equal((await token("POST", "/api/users", T.admin, { email: email("first").toUpperCase(), name: "Dup", brand: "beegraphix" })).status, 409, "emails are unique, any case");

  const b = browser();
  assert.equal((await b.call("POST", "/api/login", { email: email("first"), password: "wrong-password" })).status, 401);
  assert.equal((await b.call("POST", "/api/login", { email: "nobody@example.com", password: "x" })).status, 401);
  const ok = await b.call("POST", "/api/login", { email: email("first"), password: r.data.tempPassword });
  assert.equal(ok.status, 200);
  const set = ok.res.headers.get("set-cookie");
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /SameSite=Lax/);

  const me = await b.call("GET", "/api/me");
  assert.equal(me.data.user.mustChange, true);
  assert.deepEqual(me.data.brands, ["beegraphix"]);
  assert.equal((await b.call("GET", "/api/jobs")).status, 403, "nothing else until the password is changed");

  assert.equal((await b.call("POST", "/api/me/password", { current: r.data.tempPassword, next: "short" })).status, 400);
  assert.equal((await b.call("POST", "/api/me/password", { current: "wrong", next: "a-long-enough-password" })).status, 400);
  assert.equal((await b.call("POST", "/api/me/password", { current: r.data.tempPassword, next: "a-long-enough-password" })).status, 200);
  assert.equal((await b.call("GET", "/api/me")).data.user.mustChange, false);
  assert.equal((await b.call("GET", "/api/jobs")).status, 200);

  assert.equal((await b.call("POST", "/api/logout")).status, 200);
  assert.equal((await b.call("GET", "/api/me")).status, 401, "signed out");
});

test("requests from other sites are blocked", async () => {
  const { b } = await person("csrf", "beegraphix");
  const job = { campaign: "c", variant: "v" };
  assert.equal((await b.call("POST", "/api/jobs", job, { "x-requested-with": "" })).status, 403, "no dashboard header");
  assert.equal((await b.call("POST", "/api/jobs", job, { origin: "https://evil.example" })).status, 403, "wrong origin");
  const r = await b.call("POST", "/api/jobs", job);
  assert.equal(r.status, 201);
  assert.equal(r.data.createdBy, email("csrf"), "the job records who asked for it");
  await b.call("POST", `/api/jobs/${r.data.id}/cancel`);
});

test("staff see only their brand and can't manage people", async () => {
  const bgx = await person("bgxstaff", "beegraphix");
  const rug = await person("rugstaff", "rugbee");
  const rj = (await rug.b.call("POST", "/api/jobs", { campaign: "rug-c", variant: "v" })).data;
  assert.equal(rj.brand, "rugbee");
  assert.equal((await bgx.b.call("POST", "/api/jobs", { brand: "rugbee", campaign: "x", variant: "v" })).status, 403);
  assert.ok((await bgx.b.call("GET", "/api/jobs")).data.jobs.every((j) => j.brand === "beegraphix"));
  assert.ok((await bgx.b.call("GET", "/api/jobs?brand=rugbee")).data.jobs.every((j) => j.brand === "beegraphix"), "?brand can't widen a staff view");
  assert.equal((await bgx.b.call("GET", `/api/jobs/${rj.id}`)).status, 404);
  assert.equal((await bgx.b.call("GET", "/api/users")).status, 403);
  assert.equal((await bgx.b.call("POST", "/api/users", { email: email("sneaky"), name: "x", brand: "beegraphix" })).status, 403);
  await rug.b.call("POST", `/api/jobs/${rj.id}/cancel`);
});

test("a brand admin manages only their own brand; an all-brands admin switches brands", async () => {
  const adm = await person("bgxadmin", "beegraphix", "admin");
  const made = await adm.b.call("POST", "/api/users", { email: email("newhire"), name: "New Hire" });
  assert.equal(made.status, 201);
  assert.equal(made.data.user.brand, "beegraphix", "defaults to the admin's brand");
  assert.equal((await adm.b.call("POST", "/api/users", { email: email("rug2"), name: "x", brand: "rugbee" })).status, 403);
  assert.equal((await adm.b.call("POST", "/api/users", { email: email("all2"), name: "x", brand: "*" })).status, 403);
  const list = (await adm.b.call("GET", "/api/users")).data.users;
  assert.ok(list.length >= 2 && list.every((u) => u.brand === "beegraphix"));
  assert.ok(list.every((u) => !("pw_hash" in u) && !("pwHash" in u)), "no password data leaves the server");
  const rugUser = (await token("GET", "/api/users", T.admin)).data.users.find((u) => u.brand === "rugbee");
  assert.equal((await adm.b.call("POST", `/api/users/${rugUser.id}/reset`)).status, 404);
  assert.equal((await adm.b.call("POST", `/api/users/${adm.id}`, { disabled: true })).status, 400, "can't lock yourself out");

  const owner = await person("owner", "*", "admin");
  const me = (await owner.b.call("GET", "/api/me")).data;
  assert.deepEqual(me.brands, ["beegraphix", "rugbee"]);
  assert.equal((await owner.b.call("POST", "/api/jobs", { campaign: "c", variant: "v" })).status, 400, "must name a brand");
  const j = await owner.b.call("POST", "/api/jobs", { brand: "rugbee", campaign: "c", variant: "v" });
  assert.equal(j.status, 201);
  assert.ok((await owner.b.call("GET", "/api/jobs?brand=rugbee")).data.jobs.every((x) => x.brand === "rugbee"));
  await owner.b.call("POST", `/api/jobs/${j.data.id}/cancel`);
});

test("reset, turn off, and lockout after 5 wrong passwords", async () => {
  const p = await person("lockme", "beegraphix");
  const adm = await person("lockadmin", "beegraphix", "admin");

  const reset = await adm.b.call("POST", `/api/users/${p.id}/reset`);
  assert.equal(reset.status, 200);
  assert.equal((await p.b.call("GET", "/api/me")).status, 401, "a reset signs them out everywhere");
  const b = browser();
  assert.equal((await b.call("POST", "/api/login", { email: email("lockme"), password: p.password })).status, 401, "old password stops working");
  assert.equal((await b.call("POST", "/api/login", { email: email("lockme"), password: reset.data.tempPassword })).status, 200);
  assert.equal((await b.call("GET", "/api/me")).data.user.mustChange, true);

  assert.equal((await adm.b.call("POST", `/api/users/${p.id}`, { disabled: true })).status, 200);
  assert.equal((await b.call("GET", "/api/me")).status, 401, "turned off: signed out right away");
  assert.equal((await browser().call("POST", "/api/login", { email: email("lockme"), password: reset.data.tempPassword })).status, 401);
  await adm.b.call("POST", `/api/users/${p.id}`, { disabled: false });

  // The sign in while turned off was wrong try 1; four more make five.
  const x = browser();
  for (let i = 0; i < 4; i++) assert.equal((await x.call("POST", "/api/login", { email: email("lockme"), password: `nope-${i}` })).status, 401);
  assert.equal((await x.call("POST", "/api/login", { email: email("lockme"), password: reset.data.tempPassword })).status, 429, "locked even with the right password");
  await adm.b.call("POST", `/api/users/${p.id}/reset`); // an admin reset clears the lock
});

test("the desktop's campaign list, per brand", async () => {
  const campaigns = [
    { brand: "beegraphix", campaign: "quarter-zips-fall-2026", title: "Top 5 Quarter-Zips", variants: [{ id: "hook-a", label: "Hook A" }, { id: "bad id", label: "x" }] },
    { brand: "rugbee", campaign: "rugbee-kit-2026", title: "Rugbee Kit", variants: [{ id: "main", label: "Main" }] },
    { brand: "acme", campaign: "nope", title: "Not ours", variants: [] },
  ];
  assert.equal((await token("PUT", "/api/desktop/catalog", T.admin, { campaigns })).status, 401, "only the desktop reports it");
  const put = await token("PUT", "/api/desktop/catalog", T.worker, { campaigns });
  assert.equal(put.status, 200);
  assert.equal(put.data.campaigns, 2);
  const { b } = await person("catalog", "beegraphix");
  const mine = (await b.call("GET", "/api/catalog")).data.campaigns;
  assert.deepEqual(mine.map((c) => c.campaign), ["quarter-zips-fall-2026"]);
  assert.deepEqual(mine[0].variants, [{ id: "hook-a", label: "Hook A" }]);
  assert.equal((await token("GET", "/api/catalog", T.admin)).data.campaigns.length, 2);
});

test("videos stream with Range requests and download as a file", async () => {
  for (;;) {
    const c = await token("POST", "/api/desktop/claim", T.worker);
    if (c.status === 204) break;
    await token("POST", `/api/desktop/jobs/${c.data.id}/fail`, T.worker, { message: "drained by test" });
  }
  const { b } = await person("viewer", "beegraphix");
  const job = (await b.call("POST", "/api/jobs", { campaign: "range-test", variant: "v" })).data;
  assert.equal((await token("POST", "/api/desktop/claim", T.worker)).data.id, job.id);
  await token("POST", `/api/desktop/jobs/${job.id}/upload/start`, T.worker);
  const bytes = new Uint8Array(1000).map((_, i) => i & 255);
  const part = await (await fetch(`${BASE}/api/desktop/jobs/${job.id}/upload/part?n=1`, { method: "PUT", headers: { authorization: `Bearer ${T.worker}` }, body: bytes })).json();
  assert.equal((await token("POST", `/api/desktop/jobs/${job.id}/upload/complete`, T.worker, { parts: [part] })).status, 200);

  const url = `${BASE}/api/jobs/${job.id}/video`;
  const ranged = await fetch(url, { headers: { cookie: b.cookie, range: "bytes=10-19" } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("content-range"), "bytes 10-19/1000");
  assert.deepEqual([...new Uint8Array(await ranged.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  const tail = await fetch(url, { headers: { cookie: b.cookie, range: "bytes=-5" } });
  assert.equal(tail.headers.get("content-range"), "bytes 995-999/1000");
  assert.equal((await fetch(url, { headers: { cookie: b.cookie, range: "bytes=5000-" } })).status, 416);
  const full = await fetch(`${url}?download`, { headers: { cookie: b.cookie } });
  assert.equal(full.status, 200);
  assert.match(full.headers.get("content-disposition"), /^attachment; filename="beegraphix-range-test-/);
  assert.equal((await full.arrayBuffer()).byteLength, 1000);
});
