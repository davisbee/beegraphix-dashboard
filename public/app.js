// Content Factory dashboard: the screens staff use. Plain JavaScript, no build step.
// Pages: #/videos, #/videos/<id>, #/render, #/team, #/account. Everything talks to /api/.
"use strict";

const BRAND_INFO = {
  beegraphix: { name: "BeeGraphix", logo: "/brands/beegraphix/logo.svg", icon: "/brands/beegraphix/icon.svg" },
  rugbee: { name: "Rugbee", logo: "/brands/rugbee/logo.png", icon: "/brands/rugbee/icon.png" },
};
const STATUS = {
  queued: ["Waiting", ""],
  claimed: ["Starting", "active"],
  rendering: ["Rendering", "active"],
  uploading: ["Uploading", "active"],
  done: ["Ready to review", "done"],
  failed: ["Failed", "failed"],
  cancelled: ["Cancelled", ""],
};
const ACTIVE = ["queued", "claimed", "rendering", "uploading"];

const state = { me: null, brands: [], brand: null, catalog: null, timer: null };
const app = document.getElementById("app");

// ---------- helpers ----------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const $ = (sel, root = document) => root.querySelector(sel);

async function api(method, path, data) {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: { "x-requested-with": "dashboard", ...(data ? { "content-type": "application/json" } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  let out = null;
  try { out = await res.json(); } catch { out = null; }
  if (res.status === 401 && path !== "/api/login") { state.me = null; showLogin(); throw new Error("Please sign in"); }
  if (!res.ok) throw new Error(out?.error || `Something went wrong (${res.status})`);
  return out;
}

function store(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private window */ }
}
function recall(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function ago(iso) {
  if (!iso) return "";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}
const when = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
const mb = (b) => (b ? `${(b / 1024 / 1024).toFixed(1)} MB` : "");
const brandName = (id) => (id === "*" ? "All brands" : BRAND_INFO[id]?.name ?? id);

function paint(brand) {
  const b = BRAND_INFO[brand] ? brand : "beegraphix";
  document.body.dataset.brand = b;
  $("#favicon").href = BRAND_INFO[b].icon;
}

function stopTimer() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

async function loadCatalog(force) {
  if (!state.catalog || force) state.catalog = (await api("GET", "/api/catalog")).campaigns;
  return state.catalog;
}

function jobTitle(j) {
  const c = state.catalog?.find((x) => x.brand === j.brand && x.campaign === j.payload.campaign);
  const v = c?.variants.find((x) => x.id === j.payload.variant);
  return { title: c?.title ?? j.payload.campaign, variant: v?.label ?? j.payload.variant };
}

function statusPill(j) {
  const [label, cls] = STATUS[j.status] ?? [j.status, ""];
  const pct = j.status === "rendering" && j.progress != null ? ` ${Math.round(j.progress * 100)}%` : "";
  return `<span class="pill ${cls}">${esc(label + pct)}</span>`;
}

// ---------- shell ----------

function shell(page, inner) {
  const nav = [
    ["videos", "Videos"],
    ["render", "Render a video"],
    ...(state.me.role === "admin" ? [["team", "Team"]] : []),
    ["account", "Account"],
  ];
  const brandPick = state.brands.length > 1
    ? `<select id="brandPick" aria-label="Brand">${state.brands.map((b) => `<option value="${b}" ${b === state.brand ? "selected" : ""}>${esc(brandName(b))}</option>`).join("")}</select>`
    : "";
  app.innerHTML = `
    <header class="topbar"><div class="topbar-in">
      <a href="#/videos" aria-label="Videos"><img class="logo" src="${BRAND_INFO[state.brand].logo}" alt="${esc(brandName(state.brand))}"></a>
      <nav class="nav">${nav.map(([id, label]) => `<a href="#/${id}" ${page === id ? 'aria-current="page"' : ""}>${label}</a>`).join("")}</nav>
      <div class="who">${brandPick}<span>${esc(state.me.name)}</span><button class="linkbtn" id="signout">Sign out</button></div>
    </div></header>
    <main>${inner}</main>`;
  $("#signout").onclick = async () => { await api("POST", "/api/logout").catch(() => {}); state.me = null; showLogin(); };
  const pick = $("#brandPick");
  if (pick) pick.onchange = () => { state.brand = pick.value; store("brand", pick.value); paint(state.brand); route(); };
}

function header(eyebrow, title, lead, action = "") {
  return `<div class="head"><div><div class="eyebrow">${esc(eyebrow)}</div><h1 class="title">${esc(title)}</h1>${lead ? `<p class="lead">${esc(lead)}</p>` : ""}</div>${action}</div>`;
}

// ---------- sign in ----------

function showLogin(message) {
  stopTimer();
  paint(recall("brand") || "beegraphix");
  const b = document.body.dataset.brand;
  app.innerHTML = `
    <div class="login"><div class="login-in">
      <img class="logo" src="${BRAND_INFO[b].logo}" alt="${esc(BRAND_INFO[b].name)}">
      <form class="card" id="loginForm" novalidate>
      <h1>Sign in</h1>
      <p class="muted small" style="margin:0 0 20px">Content Factory. Plan, build and post your brand's videos.</p>
      <div id="err">${message ? `<div class="error">${esc(message)}</div>` : ""}</div>
      <div class="field"><label for="email">Email</label><input type="email" id="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input type="password" id="password" autocomplete="current-password" required></div>
      <button class="btn" type="submit">Sign In</button>
      <p class="muted small" style="margin:16px 0 0">Forgot your password? Ask your admin to reset it.</p>
    </form></div></div>`;
  $("#email").focus();
  $("#loginForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      await api("POST", "/api/login", { email: $("#email").value, password: $("#password").value });
      await start();
    } catch (err) {
      $("#err").innerHTML = `<div class="error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  };
}

// ---------- videos ----------

async function pageVideos() {
  shell("videos", `${header(brandName(state.brand), "Videos", "Everything your team has asked the desktop to build, newest first.", `<a class="btn" href="#/render">Render a Video</a>`)}<div id="list"><div class="card empty">Loading…</div></div>`);
  await loadCatalog().catch(() => {});
  const refresh = async () => {
    const qs = state.brands.length > 1 ? `?brand=${state.brand}` : "";
    const { jobs } = await api("GET", `/api/jobs${qs}`);
    const list = $("#list");
    if (!list) return;
    list.innerHTML = jobs.length
      ? `<div class="jobs">${jobs.map((j) => {
          const t = jobTitle(j);
          const bar = ["claimed", "rendering", "uploading"].includes(j.status) ? `<div class="bar"><span style="width:${Math.round((j.progress ?? 0) * 100)}%"></span></div>` : "";
          return `<a class="job" href="#/videos/${j.id}">
            <div class="job-title">${esc(t.title)}${j.payload.draft ? '<span class="tag">Preview</span>' : ""}</div>${statusPill(j)}
            <div class="job-meta">${esc(t.variant)} · ${esc(j.createdBy ?? "")} · ${esc(ago(j.createdAt))}</div>${bar}
          </a>`;
        }).join("")}</div>`
      : `<div class="card empty"><p>No videos yet.</p><a class="btn" href="#/render">Render Your First Video</a></div>`;
    stopTimer();
    if (jobs.some((j) => ACTIVE.includes(j.status))) state.timer = setTimeout(() => refresh().catch(() => {}), 5000);
  };
  await refresh();
}

async function pageVideo(id) {
  shell("videos", `<div id="detail"><div class="card empty">Loading…</div></div>`);
  await loadCatalog().catch(() => {});
  const refresh = async () => {
    const j = await api("GET", `/api/jobs/${id}`);
    const box = $("#detail");
    if (!box) return;
    const t = jobTitle(j);
    const [label] = STATUS[j.status] ?? [j.status];
    const playing = $("video", box);
    const player = j.hasVideo
      ? (playing ? null : `<video controls playsinline preload="metadata" src="/api/jobs/${j.id}/video"></video>`)
      : `<div class="wait">${j.status === "failed" ? "This one didn't finish." : j.status === "cancelled" ? "Cancelled." : `${esc(label)}${j.progress != null && j.status === "rendering" ? ` ${Math.round(j.progress * 100)}%` : ""}…<br><span class="small">${esc(j.message ?? "")}</span>`}</div>`;
    const actions = [
      j.hasVideo ? `<a class="btn" href="/api/jobs/${j.id}/video?download">Download</a>` : "",
      j.status === "queued" ? `<button class="btn outline" id="cancel">Cancel</button>` : "",
      ["done", "failed", "cancelled"].includes(j.status) ? `<a class="btn outline" href="#/render?campaign=${encodeURIComponent(j.payload.campaign)}&variant=${encodeURIComponent(j.payload.variant)}">Render Again</a>` : "",
    ].join("");
    const html = `
      <p class="small" style="margin:0 0 16px"><a href="#/videos">← All videos</a></p>
      <div class="detail">
        <div class="player" id="player">${player ?? ""}</div>
        <div>
          <div class="card">
            <div class="eyebrow">${esc(brandName(j.brand))}</div>
            <h1 class="title" style="font-size:26px;line-height:32px">${esc(t.title)}</h1>
            <p class="muted" style="margin:4px 0 12px">${esc(t.variant)}${j.payload.draft ? " · quick preview (720p)" : ""}</p>
            ${statusPill(j)}
            ${j.status === "failed" && j.message ? `<pre class="log">${esc(j.message)}</pre>` : ""}
            <dl class="facts">
              <dt>Asked for by</dt><dd>${esc(j.createdBy ?? "")}</dd>
              <dt>Asked for</dt><dd>${esc(when(j.createdAt))}</dd>
              ${j.finishedAt ? `<dt>Finished</dt><dd>${esc(when(j.finishedAt))}</dd>` : ""}
              ${j.outputBytes ? `<dt>File size</dt><dd>${esc(mb(j.outputBytes))}</dd>` : ""}
              ${j.attempts > 1 ? `<dt>Tries</dt><dd>${j.attempts}</dd>` : ""}
            </dl>
            <div class="row" style="margin-top:20px">${actions}</div>
          </div>
          ${j.status === "done" ? `<div class="card"><h2>Posting</h2><p class="muted small" style="margin:0">Approve and post to your social accounts is coming next. For now, download the video.</p></div>` : ""}
        </div>
      </div>`;
    if (player === null) {
      // Keep the video element (and its playback position) while the rest refreshes.
      const keep = playing;
      box.innerHTML = html;
      $("#player", box).appendChild(keep);
    } else box.innerHTML = html;
    const cancel = $("#cancel");
    if (cancel) cancel.onclick = async () => { cancel.disabled = true; await api("POST", `/api/jobs/${j.id}/cancel`).catch((e) => alert(e.message)); refresh(); };
    stopTimer();
    if (ACTIVE.includes(j.status)) state.timer = setTimeout(() => refresh().catch(() => {}), 4000);
  };
  try { await refresh(); } catch (e) { $("#detail").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

// ---------- render a video ----------

async function pageRender(params) {
  shell("render", `${header(brandName(state.brand), "Render a Video", "Pick a campaign that's already set up on the desktop. It goes in line and renders on its own.")}<div id="form"><div class="card empty">Loading…</div></div>`);
  const all = await loadCatalog(true);
  const list = all.filter((c) => c.brand === state.brand);
  const box = $("#form");
  if (!list.length) {
    box.innerHTML = `<div class="card empty"><p>No ${esc(brandName(state.brand))} campaigns on the desktop yet.</p><p class="small">The desktop sends its list when the worker starts. If you just set one up, give it a few minutes.</p></div>`;
    return;
  }
  const pickC = params.get("campaign");
  let campaign = list.find((c) => c.campaign === pickC) ?? list[0];
  const draw = (variant) => {
    box.innerHTML = `<form class="card" id="renderForm">
      <div id="err"></div>
      <div class="field"><label for="campaign">Campaign</label>
        <select id="campaign">${list.map((c) => `<option value="${esc(c.campaign)}" ${c === campaign ? "selected" : ""}>${esc(c.title)}</option>`).join("")}</select></div>
      <div class="field"><label>Version</label><div class="choices">
        ${campaign.variants.map((v, i) => `<label class="choice"><input type="radio" name="variant" value="${esc(v.id)}" ${(variant ? v.id === variant : i === 0) ? "checked" : ""}><span><b>${esc(v.label)}</b><span class="small muted">${esc(v.id)}</span></span></label>`).join("")}
      </div></div>
      <div class="field"><label class="check"><input type="checkbox" id="draft"><span>Quick preview<br><span class="small muted">720p and faster. Use it to check the cut, then render the full version to post.</span></span></label></div>
      <button class="btn" type="submit">Render It</button>
    </form>`;
    $("#campaign").onchange = (e) => { campaign = list.find((c) => c.campaign === e.target.value); draw(); };
    $("#renderForm").onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      try {
        const v = e.target.querySelector("input[name=variant]:checked")?.value;
        const j = await api("POST", "/api/jobs", { brand: state.brand, campaign: campaign.campaign, variant: v, draft: $("#draft").checked });
        location.hash = `#/videos/${j.id}`;
      } catch (err) {
        $("#err").innerHTML = `<div class="error">${esc(err.message)}</div>`;
        btn.disabled = false;
      }
    };
  };
  draw(params.get("variant"));
}

// ---------- team ----------

async function pageTeam() {
  if (state.me.role !== "admin") { location.hash = "#/videos"; return; }
  const canAll = state.me.brand === "*";
  shell("team", `${header(canAll ? "All brands" : brandName(state.me.brand), "Team", "Who can sign in. New people get a temporary password and pick their own the first time they sign in.")}
    <div id="shown"></div>
    <div class="card"><h2>Add a person</h2><p class="muted small" style="margin:0 0 16px">They'll only see their own brand's videos.</p>
      <form id="addForm"><div id="err"></div>
        <div class="grid2">
          <div class="field"><label for="nName">Name</label><input type="text" id="nName" required></div>
          <div class="field"><label for="nEmail">Email</label><input type="email" id="nEmail" required></div>
          ${canAll ? `<div class="field"><label for="nBrand">Brand</label><select id="nBrand">${["beegraphix", "rugbee", "*"].map((b) => `<option value="${b}" ${b === state.brand ? "selected" : ""}>${esc(brandName(b))}</option>`).join("")}</select></div>` : ""}
          <div class="field"><label for="nRole">Role</label><select id="nRole"><option value="staff">Staff: make and post videos</option><option value="admin">Admin: also manage people</option></select></div>
        </div>
        <button class="btn" type="submit">Add Person</button>
      </form></div>
    <div class="card"><h2>People</h2><div class="table-wrap" id="people"><p class="muted">Loading…</p></div></div>`);

  const showSecret = (who, pw) => {
    $("#shown").innerHTML = `<div class="notice"><b>Temporary password for ${esc(who.name)}</b> (${esc(who.email)})<br>
      <span class="secret">${esc(pw)}</span><br><span class="small">Send it to them yourself. It won't be shown again. They'll pick their own password when they sign in at ${esc(location.origin)}.</span></div>`;
    $("#shown").scrollIntoView({ behavior: "smooth" });
  };

  const load = async () => {
    const { users } = await api("GET", "/api/users");
    $("#people").innerHTML = `<table><thead><tr><th>Name</th><th>Email</th>${canAll ? "<th>Brand</th>" : ""}<th>Role</th><th>Last sign in</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr class="${u.disabled ? "off" : ""}" data-id="${u.id}">
        <td>${esc(u.name)}${u.id === state.me.id ? ' <span class="tag">You</span>' : ""}${u.disabled ? ' <span class="tag">Turned off</span>' : ""}</td>
        <td>${esc(u.email)}</td>${canAll ? `<td>${esc(brandName(u.brand))}</td>` : ""}
        <td>${u.role === "admin" ? "Admin" : "Staff"}</td>
        <td class="small">${u.lastLoginAt ? esc(ago(u.lastLoginAt)) : u.mustChange ? "Not yet" : ""}</td>
        <td><div class="row" style="justify-content:flex-end;gap:6px">${u.id === state.me.id ? "" : `
          <button class="btn outline small" data-act="reset">Reset Password</button>
          <button class="btn outline small" data-act="role">${u.role === "admin" ? "Make Staff" : "Make Admin"}</button>
          <button class="btn outline small" data-act="toggle">${u.disabled ? "Turn On" : "Turn Off"}</button>`}</div></td>
      </tr>`).join("")}</tbody></table>`;
    $("#people").querySelectorAll("button[data-act]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.closest("tr").dataset.id;
        const u = users.find((x) => x.id === id);
        try {
          if (btn.dataset.act === "reset") {
            if (!confirm(`Give ${u.name} a new temporary password? Their current one stops working.`)) return;
            const r = await api("POST", `/api/users/${id}/reset`);
            showSecret(u, r.tempPassword);
          } else if (btn.dataset.act === "role") {
            await api("POST", `/api/users/${id}`, { role: u.role === "admin" ? "staff" : "admin" });
          } else {
            if (!u.disabled && !confirm(`Turn off ${u.name}'s login? They're signed out right away.`)) return;
            await api("POST", `/api/users/${id}`, { disabled: !u.disabled });
          }
          await load();
        } catch (e) { alert(e.message); }
      };
    });
  };

  $("#addForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      const r = await api("POST", "/api/users", {
        name: $("#nName").value, email: $("#nEmail").value, role: $("#nRole").value,
        brand: canAll ? $("#nBrand").value : state.me.brand,
      });
      e.target.reset();
      $("#err").innerHTML = "";
      showSecret(r.user, r.tempPassword);
      await load();
    } catch (err) { $("#err").innerHTML = `<div class="error">${esc(err.message)}</div>`; }
    btn.disabled = false;
  };
  await load();
}

// ---------- account ----------

function pageAccount(forced) {
  const inner = `${header(brandName(state.me.brand), forced ? "Pick Your Password" : "Account", forced ? "You signed in with a temporary password. Choose your own to keep going." : `${state.me.name} · ${state.me.email}`)}
    <form class="card" id="pwForm" style="max-width:520px"><h2>${forced ? "New password" : "Change password"}</h2><div id="err"></div>
      <div class="field"><label for="cur">${forced ? "Temporary password" : "Current password"}</label><input type="password" id="cur" autocomplete="current-password" required></div>
      <div class="field"><label for="nxt">New password</label><input type="password" id="nxt" autocomplete="new-password" minlength="10" required><div class="hint">At least 10 characters. A short sentence works well.</div></div>
      <div class="field"><label for="nxt2">New password again</label><input type="password" id="nxt2" autocomplete="new-password" required></div>
      <button class="btn" type="submit">Save Password</button>
    </form>`;
  if (forced) {
    app.innerHTML = `<header class="topbar"><div class="topbar-in"><img class="logo" src="${BRAND_INFO[state.brand].logo}" alt="${esc(brandName(state.brand))}"></div></header><main>${inner}</main>`;
  } else shell("account", inner);
  $("#pwForm").onsubmit = async (e) => {
    e.preventDefault();
    if ($("#nxt").value !== $("#nxt2").value) { $("#err").innerHTML = `<div class="error">The two new passwords don't match.</div>`; return; }
    try {
      await api("POST", "/api/me/password", { current: $("#cur").value, next: $("#nxt").value });
      state.me.mustChange = false;
      if (forced) { location.hash = "#/videos"; route(); }
      else { e.target.reset(); $("#err").innerHTML = `<div class="notice">Saved. Other browsers you were signed in on have been signed out.</div>`; }
    } catch (err) { $("#err").innerHTML = `<div class="error">${esc(err.message)}</div>`; }
  };
}

// ---------- routing ----------

function route() {
  stopTimer();
  if (!state.me) return showLogin();
  if (state.me.mustChange) return pageAccount(true);
  const [path, query] = (location.hash.slice(1) || "/videos").split("?");
  const params = new URLSearchParams(query ?? "");
  const parts = path.split("/").filter(Boolean);
  const fail = (e) => { const m = $("main"); if (m && e.message !== "Please sign in") m.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; };
  if (parts[0] === "videos" && parts[1]) return pageVideo(parts[1]).catch(fail);
  if (parts[0] === "render") return pageRender(params).catch(fail);
  if (parts[0] === "team") return pageTeam().catch(fail);
  if (parts[0] === "account") return pageAccount(false);
  return pageVideos().catch(fail);
}

async function start() {
  try {
    const r = await api("GET", "/api/me");
    state.me = r.user;
    state.brands = r.brands;
    const saved = recall("brand");
    state.brand = state.brands.includes(saved) ? saved : state.brands[0];
    store("brand", state.brand);
    paint(state.brand);
    state.catalog = null;
    route();
  } catch (e) {
    if (e.message !== "Please sign in") showLogin(e.message);
  }
}

window.addEventListener("hashchange", () => state.me && route());
start();
