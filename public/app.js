// Content Factory dashboard: the screens staff use. Plain JavaScript, no build step.
// Pages: #/videos, #/videos/<id>, #/new, #/render, #/team, #/avatar, #/account. Everything talks to /api/.
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
  if (!res.ok) throw Object.assign(new Error(out?.error || `Something went wrong (${res.status})`), { status: res.status });
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

const LOOK_LABEL = { creator: "Creator-style cut", full: "Polished brand reel" };

function jobTitle(j) {
  const c = state.catalog?.find((x) => x.brand === j.brand && x.campaign === j.payload.campaign);
  const v = c?.variants.find((x) => x.id === j.payload.variant);
  return { title: c?.title ?? j.payload.title ?? j.payload.campaign, variant: v?.label ?? LOOK_LABEL[j.payload.variant] ?? j.payload.variant };
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
    ["new", "New video"],
    ["render", "Render again"],
    ...(state.me.role === "admin" ? [["team", "Team"], ["avatar", "AI avatar"]] : []),
    ["account", "Account"],
  ];
  const brandPick = state.brands.length > 1
    ? `<select id="brandPick" aria-label="Brand">${state.brands.map((b) => `<option value="${b}" ${b === state.brand ? "selected" : ""}>${esc(brandName(b))}</option>`).join("")}</select>`
    : "";
  app.innerHTML = `
    <header class="topbar"><div class="topbar-in">
      <a href="#/videos" class="home" aria-label="Content Factory, Videos"><img class="logo" src="${BRAND_INFO[state.brand].logo}" alt="${esc(brandName(state.brand))}"><span class="appname">Content Factory</span></a>
      <nav class="nav">${nav.map(([id, label]) => `<a href="#/${id}${id === "new" ? "?fresh" : ""}" ${page === id ? 'aria-current="page"' : ""}>${label}${id === "team" && state.resetRequests ? ` <span class="count" title="Waiting on a new password">${state.resetRequests}</span>` : ""}</a>`).join("")}</nav>
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
      <div class="appname">Content Factory</div>
      <form class="card" id="loginForm" novalidate>
      <h1>Sign in</h1>
      <p class="muted small" style="margin:0 0 20px">Plan, build and post your brand's videos.</p>
      <div id="err">${message ? `<div class="error">${esc(message)}</div>` : ""}</div>
      <div class="field"><label for="email">Email</label><input type="email" id="email" autocomplete="username" required></div>
      <div class="field"><label for="password">Password</label><input type="password" id="password" autocomplete="current-password" required></div>
      <button class="btn" type="submit">Sign In</button>
      <p class="small" style="margin:16px 0 0"><a href="#" id="forgot">Forgot your password?</a></p>
    </form></div></div>`;
  $("#email").focus();
  $("#forgot").onclick = (e) => { e.preventDefault(); showForgot($("#email").value); };
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

// "Forgot your password?": emails a reset link, or (before email is set up) asks the admins on the Team page.
function showForgot(email = "") {
  const b = document.body.dataset.brand;
  app.innerHTML = `
    <div class="login"><div class="login-in">
      <img class="logo" src="${BRAND_INFO[b].logo}" alt="${esc(BRAND_INFO[b].name)}">
      <div class="appname">Content Factory</div>
      <form class="card" id="forgotForm" novalidate>
      <h1>Reset your password</h1>
      <p class="muted small" style="margin:0 0 20px">Enter the email you sign in with and we'll help you pick a new password.</p>
      <div id="err"></div>
      <div class="field"><label for="email">Email</label><input type="email" id="email" autocomplete="username" required value="${esc(email)}"></div>
      <button class="btn" type="submit">Ask for a New Password</button>
      <p class="small" style="margin:16px 0 0"><a href="#" id="back">Back to sign in</a></p>
    </form></div></div>`;
  $("#email").focus();
  $("#back").onclick = (e) => { e.preventDefault(); showLogin(); };
  $("#forgotForm").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      const r = await api("POST", "/api/password-help", { email: $("#email").value });
      $("#forgotForm").innerHTML = r.via === "email"
        ? `<h1>Check your email</h1>
        <p class="muted" style="margin:0 0 20px">If that email has an account, we've sent it a link to pick a new password. The link works for an hour. Not there? Check your spam folder.</p>`
        : `<h1>Request sent</h1>
        <p class="muted" style="margin:0 0 20px">If that email has an account, your admin will see your request and send you a new temporary password. You'll pick your own when you sign in with it.</p>`;
      $("#forgotForm").insertAdjacentHTML("beforeend", `
<button class="btn" type="button" id="back2">Back to Sign In</button>`);
      $("#back2").onclick = () => showLogin();
    } catch (err) {
      $("#err").innerHTML = `<div class="error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  };
}

// The page the emailed reset link opens (#/reset?token=…), before anyone is signed in.
function showReset(token) {
  stopTimer();
  paint(recall("brand") || "beegraphix");
  const b = document.body.dataset.brand;
  app.innerHTML = `
    <div class="login"><div class="login-in">
      <img class="logo" src="${BRAND_INFO[b].logo}" alt="${esc(BRAND_INFO[b].name)}">
      <div class="appname">Content Factory</div>
      <form class="card" id="resetForm" novalidate>
      <h1>Pick a new password</h1>
      <p class="muted small" style="margin:0 0 20px">At least 10 characters. You'll be signed out everywhere else.</p>
      <div id="err"></div>
      <div class="field"><label for="next">New password</label><input type="password" id="next" autocomplete="new-password" required></div>
      <div class="field"><label for="again">New password again</label><input type="password" id="again" autocomplete="new-password" required></div>
      <button class="btn" type="submit">Save Password</button>
      <p class="small" style="margin:16px 0 0"><a href="#" id="back">Back to sign in</a></p>
    </form></div></div>`;
  $("#next").focus();
  const toLogin = (msg) => { history.replaceState(null, "", location.pathname); showLogin(msg); };
  $("#back").onclick = (e) => { e.preventDefault(); toLogin(); };
  $("#resetForm").onsubmit = async (e) => {
    e.preventDefault();
    if ($("#next").value !== $("#again").value) { $("#err").innerHTML = `<div class="error">The two passwords don't match</div>`; return; }
    const btn = e.target.querySelector("button");
    btn.disabled = true;
    try {
      await api("POST", "/api/password-reset", { token, next: $("#next").value });
      toLogin();
      $("#err").innerHTML = `<div class="notice">Password saved. Sign in with your new one.</div>`;
    } catch (err) {
      $("#err").innerHTML = `<div class="error">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  };
}

// ---------- videos ----------

async function pageVideos() {
  shell("videos", `${header(brandName(state.brand), "Videos", "Everything your team has asked the desktop to build, newest first.", `<div class="row"><a class="btn outline" href="#/render">Render Again</a><a class="btn" href="#/new?fresh">New Video</a></div>`)}<div id="drafts"></div><div id="list"><div class="card empty">Loading…</div></div>`);
  // Drafts: videos someone saved to finish later (usually waiting on footage).
  const showDrafts = async () => {
    const { drafts } = await api("GET", `/api/drafts?brand=${state.brand}`);
    const box = $("#drafts");
    if (!box) return;
    box.innerHTML = drafts.length ? `<div class="card"><h2>Drafts</h2><p class="muted small" style="margin:0 0 12px">Saved to finish later. Open one to add the clips and build it.</p>
      <div class="drafts">${drafts.map((d) => `<div class="draft"><a href="#/new?draft=${d.id}"><b>${esc(d.title)}</b></a><span class="small muted">${esc(d.format)} · ${esc(d.updatedBy)} · ${esc(ago(d.updatedAt))}</span>
        <span class="row"><a class="btn outline small" href="#/new?draft=${d.id}">Open</a><button class="linkbtn dark" type="button" data-deldraft="${d.id}" data-title="${esc(d.title)}">Delete</button></span></div>`).join("")}</div></div>` : "";
    box.querySelectorAll("[data-deldraft]").forEach((b) => b.onclick = async () => {
      if (!confirm(`Delete the draft “${b.dataset.title}”? This can't be undone.`)) return;
      await api("DELETE", `/api/drafts/${b.dataset.deldraft}`).catch((e) => alert(e.message));
      showDrafts().catch(() => {});
    });
  };
  showDrafts().catch(() => {});
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
            <div class="job-title">${esc(t.title)}${j.kind === "build" ? '<span class="tag">New</span>' : ""}${j.payload.draft ? '<span class="tag">Preview</span>' : ""}</div>${statusPill(j)}
            <div class="job-meta">${esc(t.variant)} · ${esc(j.createdBy ?? "")} · ${esc(ago(j.createdAt))}</div>${bar}
          </a>`;
        }).join("")}</div>`
      : `<div class="card empty"><p>No videos yet.</p><a class="btn" href="#/new?fresh">Make Your First Video</a></div>`;
    stopTimer();
    if (jobs.some((j) => ACTIVE.includes(j.status))) state.timer = setTimeout(() => refresh().catch(() => {}), 5000);
  };
  await refresh();
}

// ---------- approve and post (posts.ts on the server) ----------

const PAGE_BOXES = [
  ["headline", "Headline", "input"], ["eyebrow", "Small label above it", "input"], ["dek", "Under the headline", "textarea"],
  ["intro", "First lines of the article", "textarea"], ["title", "Title in Google and the browser tab", "input"], ["description", "Description in Google", "textarea"],
];
const CAPTION_BOXES = [
  ["instagram", "Instagram"], ["facebook", "Facebook"], ["linkedin", "LinkedIn"], ["tiktok", "TikTok"], ["youtubeTitle", "YouTube title"], ["youtube", "YouTube description"],
];
const WEEK_BOXES = [["teaser1", "Day 1: first teaser"], ["carousel", "Day 2: carousel"], ["teaser2", "Day 4: second teaser"]];
const IMAGE_BOXES = [
  ["teaser1", "First teaser", "textarea", "2 or 3 short lines, one per row. The last line gets the gold box."],
  ["teaser2", "Second teaser", "textarea", "2 or 3 short lines, one per row."],
  ["closeHeadline", "Last carousel slide", "input", "A few words above the quote button."],
  ["closeSubline", "Under it", "input", ""],
];
// The week of posts, the same as postPlan() in the Content Factory's scripts/lib/publish.mjs. A step without its
// caption is skipped; on Instagram {url} reads "Link in bio." because Instagram doesn't link captions.
const WEEK = [
  { day: 0, name: "Instagram reel", cap: "instagram", video: true },
  { day: 0, name: "Facebook reel", cap: "facebook", video: true },
  { day: 0, name: "TikTok", cap: "tiktok", video: true },
  { day: 0, name: "YouTube Short", cap: "youtube", video: true, title: true },
  { day: 0, name: "LinkedIn", cap: "linkedin", images: ["ad-linkedin"] },
  { day: 1, name: "Instagram and Facebook", cap: "teaser1", images: ["teaser-1-feed"] },
  { day: 2, name: "Instagram, Facebook and LinkedIn", cap: "carousel", images: "carousel" },
  { day: 4, name: "Instagram and Facebook", cap: "teaser2", images: ["teaser-2-feed"] },
  { day: 5, name: "Instagram and Facebook story", cap: null, images: ["ad-story"], story: true },
];

async function showPosting(j) {
  const box = $("#posting");
  if (!box) return;
  const d = await api("GET", `/api/jobs/${j.id}/post`);
  if (!$("#posting")) return;
  if (!d.supported) { box.innerHTML = `<div class="card"><h2>Page and posts</h2><p class="muted small" style="margin:0">${esc(d.why)} For now, download the video.</p></div>`; return; }
  const p = d.post;
  const copy = { page: {}, captions: {}, images: {}, ...p?.copy };
  const task = p?.task;
  const busy = !!task?.busy;
  const live = !!(p?.liveUrl || p?.posted);
  const locked = busy || live;
  const link = d.link;
  const field = (key, label, kind, val, hint = "") => `<div class="field"><label for="pf-${key.replace(".", "-")}">${esc(label)}</label>${kind === "textarea"
    ? `<textarea id="pf-${key.replace(".", "-")}" rows="${key.startsWith("captions.") && !key.endsWith("Title") ? 5 : key.startsWith("images.") ? 3 : 2}" data-pk="${key}" ${locked ? "disabled" : ""}>${esc(val ?? "")}</textarea>`
    : `<input type="text" id="pf-${key.replace(".", "-")}" data-pk="${key}" value="${esc(val ?? "")}" ${locked ? "disabled" : ""}>`}${hint ? `<div class="hint">${hint}</div>` : ""}</div>`;
  const taskLine = !task ? "" : task.busy
    ? `<div class="notice">${task.kind === "page" ? "The desktop is making the images and the preview (2 or 3 minutes)" : "The desktop is posting"}… <span class="muted small">${esc(task.message ?? "")}</span></div>`
    : task.status === "failed" ? `<div class="error">${task.kind === "page" ? "The preview didn't build" : "Posting didn't finish"}: ${esc((task.message ?? "").split("\n")[0])}</div>` : "";
  const posted = (p?.posted ?? []).map((x) => `<li>${esc(x.platform ?? x.key)}${x.scheduleDate ? `: ${esc(when(x.scheduleDate))}` : ""}${x.status ? ` <span class="muted small">(${esc(x.status)})</span>` : ""}</li>`).join("");
  box.innerHTML = `<div class="card" id="postCard"><h2>Page and posts</h2>
    ${live ? `<div class="notice"><b>Posted.</b> ${p.liveUrl ? `The page is live at <a href="${esc(p.liveUrl)}" target="_blank" rel="noopener">${esc(p.liveUrl.replace(/^https:\/\//, ""))}</a>.` : ""}${posted ? ` Scheduled in HighLevel:<ul class="small">${posted}</ul>` : " Check HighLevel's Social Planner for the posts."}<div class="small muted">Approved by ${esc(p.approvedBy ?? "")}, ${esc(when(p.approvedAt))}</div></div>`
      : `<p class="muted small" style="margin:0 0 14px">${d.program
        ? `Posts link to the program's own page: <a href="${esc(link)}" target="_blank" rel="noopener">${esc(link.replace(/^https?:\/\//, ""))}</a>.`
        : "Every video gets its own page on blog.beegraphix.com with the video, the products and a quote form that goes to HighLevel."} Nothing goes public until an admin presses Approve.</p>`}
    ${taskLine}
    ${locked ? "" : `<div class="row" style="margin-bottom:16px"><button class="btn dark" type="button" id="postDraft">${p ? "Write It Again" : "Write It For Me"}</button><span class="small muted" id="postDraftState">${p ? "" : "Claude writes the page and captions from the script. Or fill them in yourself."}</span></div>`}
    <div id="postErr"></div>
    ${`
      ${d.program ? "" : `<h3 class="sub">The page</h3>
        <div class="field"><label for="pf-slug">Page address</label><div class="slugrow"><span class="muted">blog.beegraphix.com/</span><input type="text" id="pf-slug" data-pk="slug" value="${esc(p?.slug ?? d.suggestedSlug ?? "")}" ${locked ? "disabled" : ""}></div></div>
        ${PAGE_BOXES.map(([k, l, kind]) => field(`page.${k}`, l, kind, copy.page[k])).join("")}`}
      <h3 class="sub">Captions</h3><p class="muted small" style="margin:0 0 10px">Leave one empty to skip that post. <b>{url}</b> becomes the link to ${d.program ? "the program page" : "the page"}, tagged so you can see which post a quote came from.</p>
      <p class="small" style="margin:0 0 8px"><b>Day 0, with the video</b></p>
      ${CAPTION_BOXES.map(([k, l]) => field(`captions.${k}`, l, k === "youtubeTitle" ? "input" : "textarea", copy.captions[k])).join("")}
      <p class="small" style="margin:6px 0 8px"><b>Later in the week, with the images</b> <span class="muted">These go to Instagram and Facebook (the carousel to LinkedIn too). The day 5 story has no caption.</span></p>
      ${WEEK_BOXES.map(([k, l]) => field(`captions.${k}`, l, "textarea", copy.captions[k])).join("")}
      <h3 class="sub">Words on the images</h3>
      ${IMAGE_BOXES.map(([k, l, kind, hint]) => field(`images.${k}`, l, kind, copy.images[k], hint)).join("")}
      <div class="field" style="max-width:240px"><label for="pf-start">Post on</label><input type="date" id="pf-start" data-pk="start" value="${esc(p?.start ?? new Date(Date.now() + 86400000).toISOString().slice(0, 10))}" ${locked ? "disabled" : ""}></div>
      <h3 class="sub">What goes out</h3><p class="muted small" style="margin:0 0 10px">Every post for the week as it'll go to HighLevel, at 11:30 each day. The words update as you type; ${p?.stills?.length ? "press <b>Build Preview</b> again after changing the words on the images." : "press <b>Build Preview</b> to make the images."}</p>
      <div id="feed"></div>
      ${d.program ? "" : p?.previewUrl ? `<h3 class="sub">The page</h3><p class="muted small" style="margin:0 0 10px">The preview as a phone sees it. <a href="${esc(p.previewUrl)}" target="_blank" rel="noopener">Open it full size</a>.${live ? "" : " Press Build Preview again after changing the page wording."}</p>
        <div class="phone"><iframe src="${esc(p.previewUrl)}" title="Page preview" loading="lazy"></iframe></div>`
        : `<p class="muted small">Press <b>Build Preview</b> to see the page here too.</p>`}
      ${locked ? "" : `<div class="row"><button class="btn outline" type="button" id="postSave">Save</button><button class="btn outline" type="button" id="postPreview">${d.program ? "Make the Images" : "Build Preview"}</button>${d.canApprove
        ? `<button class="btn" type="button" id="postApprove">Approve and Post</button>` : `<span class="small muted">An admin approves and posts.</span>`}</div>
        <p class="small muted" id="postState" style="margin:10px 0 0"></p>`}`}
  </div>`;

  const err = (e) => { const el = $("#postErr"); if (el) el.innerHTML = `<div class="error">${esc(e.message)}</div>`; };
  const values = () => {
    const out = { copy: { page: { ...copy.page }, captions: { ...copy.captions }, images: { ...copy.images } } };
    box.querySelectorAll("[data-pk]").forEach((el) => {
      const [a, b] = el.dataset.pk.split(".");
      if (b) out.copy[a][b] = el.value; else out[a] = el.value;
    });
    return out;
  };
  // The week as the desktop schedules it (WEEK above), with the video and the images the last preview made.
  const feed = () => {
    const el = $("#feed");
    if (!el) return;
    const v = values(), c = v.copy.captions;
    const url = d.program ? link : `https://blog.beegraphix.com/${v.slug || "…"}`;
    const has = (k) => !!(c[k] ?? "").trim();
    const made = new Set(p?.stills ?? []);
    const carousel = (p?.stills ?? []).filter((n) => n.startsWith("carousel-"));
    const img = (n, cls = "") => made.has(n)
      ? `<img class="${cls}" src="/api/jobs/${j.id}/stills/${n}?v=${encodeURIComponent(p.stillsAt ?? "")}" alt="">`
      : `<div class="noimg ${cls}">Press Build Preview to make this image</div>`;
    const dayOf = (n) => { if (!v.start) return ""; const t = new Date(`${v.start}T11:30:00`); t.setDate(t.getDate() + n); return t.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }); };
    const anyFeed = has("instagram") || has("facebook");
    const steps = WEEK.filter((w) => (w.story ? anyFeed : has(w.cap)));
    if (!steps.length) { el.innerHTML = `<p class="muted small">No captions yet, so nothing would be posted.</p>`; return; }
    const days = [...new Set(steps.map((w) => w.day))];
    el.innerHTML = days.map((n) => `<div class="day"><div class="dayhead"><b>Day ${n}</b> <span class="muted small">${esc(dayOf(n))}</span></div><div class="feed">${steps.filter((w) => w.day === n).map((w) => {
      const media = w.video ? `<video controls playsinline muted preload="metadata" src="/api/jobs/${j.id}/video#t=0.5"></video>`
        : w.images === "carousel" ? `<div class="strip">${(carousel.length ? carousel : ["carousel-1"]).map((x) => img(x)).join("")}</div>`
        : w.images.map((x) => img(x, x === "ad-linkedin" ? "wide" : x === "ad-story" ? "tall" : "")).join("");
      const text = w.cap ? c[w.cap] : "";
      const ig = w.cap && !w.video && w.cap !== "linkedin" && text.includes("{url}");
      return `<div class="post">
        <div class="posthead"><b>${esc(w.name)}</b>${w.images === "carousel" && carousel.length ? `<span class="muted small">${carousel.length} slides, swipe</span>` : ""}</div>
        ${media}
        ${w.title ? `<div class="posttitle">${esc(c.youtubeTitle || jobTitle(j).title)}</div>` : ""}
        ${w.story ? `<div class="postcap muted">Stories go out without a caption.</div>` : `<div class="postcap">${esc(text.replaceAll("{url}", url)).replace(/(https:\/\/[^\s<]+)/g, '<span class="link">$1</span>')}</div>`}
        ${ig ? `<div class="small muted" style="margin-top:6px">On Instagram the link reads "Link in bio."</div>` : ""}
      </div>`;
    }).join("")}</div></div>`).join("");
  };
  feed();
  let typing;
  box.querySelectorAll("[data-pk]").forEach((x) => x.addEventListener("input", () => { clearTimeout(typing); typing = setTimeout(feed, 300); }));
  const saveIt = () => api("PUT", `/api/jobs/${j.id}/post`, values());
  const again = () => showPosting(j).catch(err);
  // fn returns false when the person backed out of a confirm.
  const press = (id, fn) => { const b = $(`#${id}`); if (b) b.onclick = async () => { b.disabled = true; $("#postErr").innerHTML = ""; try { if ((await fn()) === false) b.disabled = false; } catch (e) { err(e); b.disabled = false; } }; };
  press("postDraft", async () => {
    if (p && !confirm("Replace the page copy and captions with a new draft?")) return false;
    $("#postDraftState").textContent = "Claude is writing… (about 20 seconds)";
    await api("POST", `/api/jobs/${j.id}/post/draft`).finally(() => { const el = $("#postDraftState"); if (el) el.textContent = ""; });
    await again();
  });
  press("postSave", async () => { await saveIt(); $("#postState").textContent = "Saved."; return false; });
  press("postPreview", async () => { await saveIt(); await api("POST", `/api/jobs/${j.id}/post/preview`); await again(); });
  press("postApprove", async () => {
    const v = values();
    const what = d.program ? "The posts get scheduled" : `The page goes live at blog.beegraphix.com/${v.slug} and the posts get scheduled`;
    if (!confirm(`Approve and post? ${what} in HighLevel for the week starting ${v.start}.`)) return false;
    await saveIt();
    await api("POST", `/api/jobs/${j.id}/post/approve`, { start: v.start });
    await again();
  });
  if (busy) { stopTimer(); state.timer = setTimeout(() => { if ($("#postCard")) again(); }, 5000); }
}

// The whole script as plain text, one part per paragraph, for a phone teleprompter app.
const teleprompter = (parts) => parts.map((x) => String(x ?? "").trim()).filter(Boolean).join("\n\n");
const scriptOfSpec = (sp) => teleprompter([sp.hook, ...(Array.isArray(sp.beats) ? sp.beats.map((b) => b.script) : (sp.products || []).map((p) => p.script)), sp.cta]);
async function copyScript(btn, text) {
  const was = btn.textContent;
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
  catch { prompt("Copy the script:", text); }
  setTimeout(() => { btn.textContent = was; }, 2000);
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
      j.payload.spec ? `<button class="btn outline" type="button" id="copyScript">Copy Script</button>` : "",
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
            <p class="muted" style="margin:4px 0 12px">${esc(t.variant)}${j.payload.draft ? " · quick preview (720p)" : ""}${j.kind === "build" ? " · new video" : ""}</p>
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
          ${j.status === "done" ? `<div id="posting"></div>` : ""}
        </div>
      </div>`;
    if (player === null) {
      // Keep the video element (and its playback position) while the rest refreshes.
      const keep = playing;
      box.innerHTML = html;
      $("#player", box).appendChild(keep);
    } else box.innerHTML = html;
    const cancel = $("#cancel");
    const cs = $("#copyScript");
    if (cs) cs.onclick = () => copyScript(cs, scriptOfSpec(j.payload.spec));
    if (cancel) cancel.onclick = async () => { cancel.disabled = true; await api("POST", `/api/jobs/${j.id}/cancel`).catch((e) => alert(e.message)); refresh(); };
    if ($("#posting")) showPosting(j).catch((e) => { const b = $("#posting"); if (b) b.innerHTML = `<div class="card"><h2>Page and posts</h2><p class="bad">${esc(e.message)}</p></div>`; });
    stopTimer();
    if (ACTIVE.includes(j.status)) state.timer = setTimeout(() => refresh().catch(() => {}), 4000);
  };
  try { await refresh(); } catch (e) { $("#detail").innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}

// ---------- render a video ----------

async function pageRender(params) {
  shell("render", `${header(brandName(state.brand), "Render Again", "Pick a campaign that's already on the desktop, in any version. To make a brand new one, use New video.")}<div id="form"><div class="card empty">Loading…</div></div>`);
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

// ---------- new video ----------

const VIDEO_TYPES = { mov: "video/quicktime", mp4: "video/mp4", m4v: "video/x-m4v" };
const PHOTO_TYPES = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

function blankVideo() {
  return {
    template: "top5", goal: "reach", audience: "", look: "creator", title: "", topic: "", notes: "", beats: {}, winner: 0,
    presenter: { mode: "self", name: state.me.name, title: "" },
    hook: "", hookText: "", cta: "", link: "", greenScreen: true, draft: false, transition: "", voice: "",
    products: [0, 1, 2, 3, 4].map(() => ({ name: "", link: "", style: "", shortName: "", tag: "", script: "", photo: null, photoName: "", price: "" })),
    footage: {}, footageNames: {},
  };
}

// Sends one file to the dashboard in 20 MB pieces, three at a time. Returns the finished upload.
async function sendFile(file, kind, onProgress) {
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  const type = file.type || (kind === "footage" ? VIDEO_TYPES : PHOTO_TYPES)[ext] || "";
  const { upload, partBytes } = await api("POST", `/api/uploads?brand=${state.brand}`, { kind, name: file.name, type, size: file.size });
  const count = Math.ceil(file.size / partBytes);
  const parts = new Array(count);
  let next = 0;
  let sent = 0;
  const worker = async () => {
    while (next < count) {
      const n = ++next;
      const blob = file.slice((n - 1) * partBytes, Math.min(n * partBytes, file.size));
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(`/api/uploads/${upload.id}/part?n=${n}`, { method: "PUT", credentials: "same-origin", headers: { "x-requested-with": "dashboard" }, body: blob });
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || `Upload failed (${res.status})`);
          parts[n - 1] = out;
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
      sent += blob.size;
      onProgress(sent / file.size);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return (await api("POST", `/api/uploads/${upload.id}/complete`, { parts })).upload;
}

// Anything worth keeping in the New video form (a blank one isn't saved as a draft).
const hasWork = (v) => [v.title, v.topic, v.hook, v.cta, ...v.products.flatMap((p) => [p.name, p.link, p.photo, p.script]),
  ...Object.values(v.beats || {}).map((b) => b.script)].some((x) => String(x ?? "").trim()) || Object.keys(v.footage || {}).length > 0;
const draftTitle = (v) => v.title.trim() || v.topic.trim() || v.products.find((p) => p.name.trim())?.name.trim() || "Untitled video";

/** Save the form to Drafts (a new draft, or over the one it came from). */
async function saveDraft(v) {
  const { draftId, dirty, ...data } = v;
  const payload = { title: draftTitle(v), data };
  let r;
  if (draftId) r = await api("PUT", `/api/drafts/${draftId}`, payload).catch((e) => (e.status === 404 ? null : Promise.reject(e)));
  r ??= await api("POST", `/api/drafts?brand=${state.brand}`, payload);
  v.draftId = r.draft.id;
  v.dirty = false;
  return r.draft;
}

async function pageNew(params = new URLSearchParams()) {
  const key = `newVideo:${state.brand}`;
  // The formats (Top 5, Product Spotlight, ...) and their beats come from the server: src/formats.ts.
  if (!state.formats) state.formats = (await api("GET", "/api/formats")).formats;
  let v;
  try { v = { ...blankVideo(), ...JSON.parse(recall(key) || "null") }; } catch { v = blankVideo(); }
  if (!v || !Array.isArray(v.products) || v.products.length !== 5) v = blankVideo();
  // Opening a draft, or starting a new video: whatever was in progress here goes to Drafts first, so nothing is lost.
  let note = "";
  const want = params.get("draft");
  if ((want && want !== v.draftId) || params.has("fresh")) {
    if (hasWork(v) && (v.dirty || !v.draftId)) {
      const d = await saveDraft(v);
      note = `The video you were working on is saved in Drafts as “${d.title}”.`;
    }
    if (want) {
      const { draft } = await api("GET", `/api/drafts/${want}`);
      v = { ...blankVideo(), ...draft.data, draftId: draft.id, dirty: false };
    } else v = blankVideo();
    store(key, JSON.stringify(v));
  }
  if (params.toString()) history.replaceState(null, "", "#/new"); // a reload keeps going instead of opening it again
  const f = state.formats.find((x) => x.id === v.template) ?? state.formats[0];
  v.template = f.id;
  // A program open with shirts still in its boxes (saved before programs kept their own): put the shirts back with the products.
  if (!f.products.style && v.products.some((p) => p.style || p.colors?.length)) {
    v.shelf = { ...(v.shelf || {}), products: v.products };
    v.products = blankVideo().products;
  }
  const N = f.products.count;
  const prods = v.products.slice(0, N); // the state always keeps 5, so switching formats loses nothing
  for (const b of f.beats) v.beats[b.id] = { script: "", text: "", ...(v.beats[b.id] || {}) };
  const clips = ["hook", ...f.beats.map((b) => b.id), "cta"];
  const clipLabel = (c) => (c === "hook" ? "Hook" : c === "cta" ? "Payoff" : f.beats.find((b) => b.id === c).label);
  const save = () => { v.dirty = true; store(key, JSON.stringify(v)); };
  const busy = new Set(); // uploads still going
  // The AI avatar: on only when HeyGen is connected, an admin picked the look, and the desktop is up to date.
  const av = await api("GET", "/api/heygen/available").catch(() => ({ available: false, reason: "Couldn't check" }));
  if (v.presenter.mode === "heygen" && !av.available) v.presenter.mode = "self";
  // Faceless videos and transition choices need the desktop that knows the Showcase template.
  const feats = await api("GET", "/api/features").catch(() => ({ showcase: false }));
  if (v.presenter.mode === "none" && !feats.showcase) v.presenter.mode = "self";
  if (!feats.showcase) v.transition = "";
  if (!feats.voiceover) v.voice = "";

  const choice = (name, value, title, sub, disabled) =>
    `<label class="choice${disabled ? " off" : ""}"><input type="radio" name="${name}" value="${value}" ${disabled ? "disabled" : ""}><span><b>${esc(title)}</b><span class="small muted">${esc(sub)}</span></span></label>`;
  const slot = (id, label, accept, hint) =>
    `<div class="slot" data-slot="${id}"><img class="slot-thumb" alt="" hidden><div class="slot-label">${esc(label)}</div><label class="btn outline small slot-pick">Choose File<input type="file" accept="${accept}" hidden></label><span class="slot-state small muted">${esc(hint)}</span><span class="slot-drop small muted">or drag it here</span></div>`;

  shell("new", `${header(brandName(state.brand), "New Video", "Fill this in top to bottom. The desktop builds the video and it shows up in Videos when it's ready. Your progress saves on this computer as you go.")}
  <div id="nvNote">${note ? `<div class="notice">${esc(note)}</div>` : ""}${v.draftId ? `<div class="notice">You're working on a saved draft. Press <b>Save as Draft</b> to keep your changes for your team.</div>` : ""}</div>
  <form id="nv" novalidate>
    <div class="card"><div class="step">1</div><h2>What's the goal?</h2>
      <div class="choices three" style="margin-top:12px">
        ${choice("goal", "reach", "Reach", "New people watch and share")}
        ${choice("goal", "target", "Target", "Speak to one kind of customer")}
        ${choice("goal", "sell", "Sell", "Send people to buy")}
      </div>
      <div class="field" style="margin-top:18px;margin-bottom:0"><label for="audience">Who's it for?</label><input type="text" id="audience" data-k="audience" placeholder="e.g. Contractors who outfit crews that work outside"></div>
    </div>

    <div class="card"><div class="step">2</div><h2>Format and look</h2>
      <div class="choices three" style="margin-top:12px">${state.formats.map((x) => choice("template", x.id, x.name, x.blurb)).join("")}</div>
      <div class="choices two" style="margin-top:10px" id="lookBox">
        ${choice("look", "creator", "Creator-style cut", "Feels like a person talking, with a music bed. Best for Reels and TikTok.")}
        ${choice("look", "full", "Polished brand reel", "Full brand graphics on every product.")}
      </div>
      <p class="small muted" id="lookFaceless" hidden style="margin:10px 0 0">No presenter: this video uses the <b>Showcase</b> look. Products spin in over the brand studio with bold text and music.</p>
      <div class="field" style="margin:16px 0 0;max-width:340px"><label for="transition">Transitions between scenes</label>
        <select id="transition" data-k="transition" ${feats.showcase ? "" : "disabled"}>
          <option value="">The look's own (gold wipe, or honeycomb for Showcase)</option>
          <option value="gold-wipe">Gold wipe</option><option value="honeycomb">Honeycomb</option><option value="whip">Whip</option><option value="flash">Flash</option><option value="cut">Hard cut</option>
        </select>${feats.showcase ? "" : `<span class="small muted">Needs a desktop update.</span>`}</div>
    </div>

    <div class="card"><div class="step">3</div><h2>${esc(f.products.title)}</h2><p class="muted small" style="margin:0 0 16px">${esc(f.products.hint)}</p>
      ${prods.map((_, i) => `<div class="product${N === 1 ? " solo" : f.products.labels[i].length > 3 ? " flat" : ""}" data-i="${i}">
        ${N === 1 ? "" : `<div class="pnum">${esc(f.products.labels[i])}</div>`}
        <div class="pgrid">
          <div class="field wide"><label for="pl${i}">Link</label><input type="text" id="pl${i}" data-k="products.${i}.link" data-link="${i}" placeholder="${esc(f.products.linkHint)}"><div class="hint" data-linkstate="${i}"></div></div>
          <div class="field${f.products.style ? "" : " wide"}"><label for="pn${i}">${esc(f.products.nameLabel)}</label><input type="text" id="pn${i}" data-k="products.${i}.name"></div>
          ${f.products.style ? `<div class="field"><label for="ps${i}">Style number</label><input type="text" id="ps${i}" data-k="products.${i}.style" data-stylebox="${i}" placeholder="e.g. 5000 or Gildan 5000"></div>` : ""}
          ${f.products.price ? `<div class="field"><label for="pp${i}">Price on screen</label><input type="text" id="pp${i}" data-k="products.${i}.price" maxlength="24" placeholder="e.g. $28 each"></div>` : ""}
          <div class="wide">${slot(`photo${i}`, "Photo", "image/jpeg,image/png,image/webp", "No photo yet")}<div class="colors" data-colors="${i}" hidden></div></div>
        </div></div>`).join("")}
      ${f.winner ? `<h3 class="sub">Who wins?</h3><div class="choices two">${choice("winner", "0", "A", "Product A wins")}${choice("winner", "1", "B", "Product B wins")}</div>` : ""}
    </div>

    <div class="card"><div class="step">4</div><h2>Script</h2><p class="muted small" style="margin:0 0 16px">Write it yourself, or tell Claude what the video is about and press Draft It For Me. Then make it sound like you.</p>
      <div class="field"><label for="topic">What's it about?</label><input type="text" id="topic" data-k="topic" placeholder="e.g. Winter gear your crew will actually wear"></div>
      <div class="field"><label for="notes">Anything to work in? <span class="muted">(optional)</span></label><textarea id="notes" rows="2" data-k="notes" placeholder="e.g. Mention we embroider in-house. #5 is the one I'd hand out to everybody."></textarea></div>
      <div class="row" style="margin-bottom:20px"><button class="btn dark" type="button" id="draftBtn">Draft It For Me</button><span class="small muted" id="draftState"></span></div>
      <div class="scriptpart"><div class="eyebrow">Hook</div>
        <div class="field"><label for="hook">Opening line, under 4 seconds</label><textarea id="hook" rows="2" data-k="hook"></textarea></div>
        <div class="field"><label for="hookText">On-screen hook, 6 words or fewer</label><input type="text" id="hookText" data-k="hookText" maxlength="60"></div>
      </div>
      <div class="scriptpart"><div class="eyebrow">Middle</div>
        ${f.beats.map((b) => {
          const i = b.product;
          const scriptKey = b.kind === "product" ? `products.${i}.script` : `beats.${b.id}.script`;
          const textBox = !b.text ? "" : b.textKind === "list"
            ? `<textarea rows="4" aria-label="${esc(b.label)} on screen" data-k="beats.${b.id}.text" placeholder="${esc(b.text)}"></textarea>`
            : `<input type="text" aria-label="${esc(b.label)} on screen" data-k="beats.${b.id}.text" maxlength="80" placeholder="${esc(b.text)}">`;
          return `<div class="field"><label for="sc-${b.id}">${esc(b.label)}${i !== undefined ? ` <span class="muted" data-pname="${i}"></span>` : ""}</label><textarea id="sc-${b.id}" rows="3" data-k="${scriptKey}" placeholder="${esc(b.write)}"></textarea>
          ${b.kind === "product" ? `<div class="grid2 tight">${b.text ? textBox : `<input type="text" aria-label="${esc(b.label)} on-screen tag" data-k="products.${i}.tag" placeholder="Why pick it, 3 to 5 words">`}<input type="text" aria-label="${esc(b.label)} short name on screen" data-k="products.${i}.shortName" placeholder="Name on screen (short)"></div>` : textBox}</div>`;
        }).join("")}
      </div>
      <div class="scriptpart"><div class="eyebrow">Payoff</div>
        <div class="field"><label for="cta">Closing line: where to go and what to do</label><textarea id="cta" rows="3" data-k="cta"></textarea></div>
        <div class="field" style="margin-bottom:0"><label for="link">Where should viewers go? <span class="muted">(optional)</span></label><input type="text" id="link" data-k="link" placeholder="e.g. blog.beegraphix.com/winter"></div>
      </div>
    </div>

    <div class="card"><div class="step">5</div><h2>Presenter</h2>
      <div class="choices three" style="margin-top:12px">
        ${choice("presenter", "self", "Record yourself", "Film each line on your phone and upload it below.")}
        ${choice("presenter", "none", "No presenter (faceless)", feats.showcase ? "Products, bold text and music. Nothing to film." : "Not available yet: needs a desktop update.", !feats.showcase)}
        ${choice("presenter", "heygen", "AI avatar (HeyGen)", av.available ? `${av.look.name} says each line. Uses HeyGen credits, and the video is labeled AI.` : `Not available yet: ${av.reason}.`, !av.available)}
      </div>
      <div class="grid2" style="margin-top:18px" id="nameBox">
        <div class="field"><label for="prName">Name on screen</label><input type="text" id="prName" data-k="presenter.name"></div>
        <div class="field"><label for="prTitle">Title on screen <span class="muted">(optional)</span></label><input type="text" id="prTitle" data-k="presenter.title" placeholder="e.g. Vice President, BeeGraphix"></div>
      </div>
      <div id="voiceBox" hidden><h3 class="sub">Voice</h3>
        <p class="muted small" style="margin:0 0 12px">Music only, or an ElevenLabs voice reads the script. Each scene runs as long as its line.</p>
        <div class="row" style="align-items:flex-end;gap:10px">
          <div class="field" style="margin:0;min-width:280px"><label for="voicePick">Who reads it</label>
            <select id="voicePick" data-k="voice" ${feats.voiceover ? "" : "disabled"}><option value="">Music only, no voice</option></select></div>
          <button class="btn outline small" type="button" id="voicePlay" hidden>Play Sample</button>
        </div>
        <p class="small muted" id="voiceNote" style="margin:8px 0 0">${feats.voiceover ? "" : "Voiceovers need a desktop update."}</p>
        <audio id="voiceAudio" hidden></audio></div>
      <div id="avatarBox" hidden><h3 class="sub">AI avatar</h3>
        <p class="muted small" style="margin:0">HeyGen makes one clip per line when you press Build. Nothing to film or upload. The video shows an "AI avatar" label the whole time.</p>
        <p class="small" id="avatarCost" style="margin:10px 0 0"></p></div>
      <div id="footageBox">
      <h3 class="sub">Footage</h3>
      <p class="muted small" style="margin:0 0 12px">One clip per line: the hook, each part of the middle, and the payoff. Vertical, look at the lens. Skip any you haven't filmed yet and the video shows a placeholder there.</p>
      <div class="row" style="margin:0 0 14px"><button class="btn outline small" type="button" id="copyScriptNv">Copy Script for Teleprompter</button></div>
      <label class="check" style="margin-bottom:14px"><input type="checkbox" data-k="greenScreen"><span>I filmed on the green screen<br><span class="small muted">The desktop cuts out the background and puts you in the brand studio.</span></span></label>
      <div class="slots">${clips.map((c) => slot(`clip-${c}`, clipLabel(c), "video/mp4,video/quicktime,.mov,.mp4,.m4v", "Not uploaded")).join("")}</div>
      </div>
    </div>

    <div class="card"><div class="step">6</div><h2>Build it</h2>
      <div class="field"><label for="title">Video title</label><input type="text" id="title" data-k="title" placeholder="e.g. ${esc(f.titleExample)}"></div>
      <label class="check" style="margin-bottom:18px"><input type="checkbox" data-k="draft"><span>Quick preview first<br><span class="small muted">720p and faster. Check the cut, then use Render Again for the full version.</span></span></label>
      <div id="err"></div>
      <div class="row"><button class="btn" type="submit" id="buildBtn">Build My Video</button><button class="btn outline" type="button" id="saveDraftBtn">Save as Draft</button><button class="btn outline" type="button" id="clearBtn">Start Over</button></div>
      <p class="small muted" id="saveState" style="margin:10px 0 0">No footage yet? Save it as a draft. It shows up in Videos, and anyone on your team can open it, add the clips and build it.</p>
    </div>
  </form>`);

  const form = $("#nv");
  $("#copyScriptNv").onclick = (e) => {
    const text = teleprompter([v.hook, ...f.beats.map((b) => (b.kind === "product" ? prods[b.product]?.script : v.beats[b.id]?.script)), v.cta]);
    if (!text) return alert("Write the script first, or use Draft It For Me.");
    copyScript(e.currentTarget, text);
  };
  const get = (path) => path.split(".").reduce((o, k) => o?.[k], v);
  const set = (path, val) => {
    const ks = path.split(".");
    const last = ks.pop();
    ks.reduce((o, k) => o[k], v)[last] = val;
  };
  const fill = () => {
    form.querySelectorAll("[data-k]").forEach((el) => {
      const val = get(el.dataset.k);
      if (el.type === "checkbox") el.checked = !!val;
      else el.value = val ?? "";
    });
    (form.querySelector(`input[name=goal][value="${v.goal}"]`) ?? form.querySelector("input[name=goal]")).checked = true;
    (form.querySelector(`input[name=look][value="${v.look}"]`) ?? form.querySelector("input[name=look]")).checked = true;
    form.querySelector(`input[name=template][value="${f.id}"]`).checked = true;
    if (f.winner) form.querySelector(`input[name=winner][value="${v.winner === 1 ? 1 : 0}"]`).checked = true;
    form.querySelector(`input[name=presenter][value=${["heygen", "none"].includes(v.presenter.mode) ? v.presenter.mode : "self"}]`).checked = true;
    names();
    showPresenter();
  };
  // Rough HeyGen cost: about 150 spoken words a minute, at Avatar IV's per-minute price.
  const avatarEstimate = () => {
    const lines = [v.hook, ...f.beats.map((b) => (b.kind === "product" ? prods[b.product]?.script : v.beats[b.id]?.script)), v.cta];
    const words = lines.join(" ").split(/\s+/).filter(Boolean).length;
    const secs = Math.round((words / 150) * 60 + lines.length * 0.5);
    return { secs, usd: (secs / 60) * (av.usdPerMinute || 0) };
  };
  // ElevenLabs voices for faceless videos, loaded the first time "No presenter" is picked.
  let voices = null;
  const loadVoices = async () => {
    if (voices || !feats.voiceover) return;
    voices = [];
    try {
      const r = await api("GET", "/api/voices");
      if (!r.ready) { $("#voiceNote").textContent = "ElevenLabs isn't connected yet. An admin adds ELEVENLABS_API_KEY in Cloudflare."; $("#voicePick").disabled = true; return; }
      voices = r.voices;
    } catch (e) { $("#voiceNote").textContent = e.message; return; }
    const sel = $("#voicePick");
    sel.insertAdjacentHTML("beforeend", voices.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}${[x.gender, x.accent].filter(Boolean).length ? ` (${esc([x.gender, x.accent].filter(Boolean).join(", "))})` : ""}${x.category && x.category !== "premade" ? " · your library" : ""}</option>`).join(""));
    if (v.voice && !voices.some((x) => x.id === v.voice)) v.voice = "";
    sel.value = v.voice || "";
    showVoice();
  };
  const showVoice = () => {
    const x = (voices || []).find((y) => y.id === v.voice);
    $("#voicePlay").hidden = !x?.preview;
  };
  $("#voicePlay").onclick = () => {
    const x = (voices || []).find((y) => y.id === v.voice);
    if (!x?.preview) return;
    const a = $("#voiceAudio");
    a.src = `/api/voices/preview?u=${encodeURIComponent(x.preview)}`;
    a.play().catch(() => alert("Couldn't play that sample."));
  };
  const showPresenter = () => {
    const ai = v.presenter.mode === "heygen", none = v.presenter.mode === "none";
    $("#avatarBox").hidden = !ai;
    $("#footageBox").hidden = ai || none;
    $("#nameBox").hidden = none;
    $("#lookBox").hidden = none;
    $("#lookFaceless").hidden = !none;
    $("#voiceBox").hidden = !none;
    if (none) loadVoices();
    if (!ai) return;
    const e = avatarEstimate();
    $("#avatarCost").innerHTML = e.secs > 3 ? `About <b>${e.secs} seconds</b> of avatar, roughly <b>$${e.usd.toFixed(2)}</b> in HeyGen credits.` : "Write the script to see the HeyGen cost.";
  };
  const names = () => form.querySelectorAll("[data-pname]").forEach((el) => { el.textContent = v.products[el.dataset.pname].name; });
  form.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.k) set(el.dataset.k, el.type === "checkbox" ? el.checked : el.value);
    else if (el.name === "goal" || el.name === "look") v[el.name] = el.value;
    else if (el.name === "winner") v.winner = Number(el.value);
    else if (el.name === "presenter") { v.presenter.mode = el.value; save(); showPresenter(); return; }
    else if (el.name === "template") {
      // Each format keeps its own products: switching never carries a Top 5 shirt into a Product Spotlight (or a program).
      v.shelf = { ...(v.shelf || {}), [v.template]: v.products };
      v.products = v.shelf[el.value]?.length === 5 ? v.shelf[el.value] : blankVideo().products;
      v.template = el.value; save(); return pageNew(); // redraw for the new format
    }
    else return;
    if (el.dataset.k?.endsWith(".name")) names();
    const pm = el.dataset.k?.match(/^products\.(\d)\.(link|name|style)$/);
    if (pm) {
      const p = v.products[+pm[1]];
      if (![p.link, p.name, p.style].some((x) => String(x ?? "").trim()) && (p.photo || p.colors)) {
        Object.assign(p, { photo: null, photoName: "", colors: undefined, color: "", auto: undefined });
        for (const k of lookedUp) if (k.startsWith(`${pm[1]}:`)) lookedUp.delete(k); // so typing it again looks it up again
        slotUi[`photo${pm[1]}`]?.show();
        showColors(+pm[1]);
      }
    }
    save();
    if (v.presenter.mode === "heygen" && /script|hook|cta/.test(el.dataset.k ?? "")) showPresenter();
    if (el.dataset.k === "voice") showVoice();
  });
  fill();

  // File slots: product photos and the seven footage clips.
  const slotInfo = (id) => (id.startsWith("photo")
    ? { kind: "photo", get: () => [v.products[+id.slice(5)].photo, v.products[+id.slice(5)].photoName], put: (u, n) => { v.products[+id.slice(5)].photo = u; v.products[+id.slice(5)].photoName = n; } }
    : { kind: "footage", get: () => [v.footage[id.slice(5)], v.footageNames[id.slice(5)]], put: (u, n) => { const c = id.slice(5); if (u) { v.footage[c] = u; v.footageNames[c] = n; } else { delete v.footage[c]; delete v.footageNames[c]; } } });
  const slotUi = {};
  form.querySelectorAll("[data-slot]").forEach((el) => {
    const id = el.dataset.slot;
    const info = slotInfo(id);
    const stateEl = $(".slot-state", el);
    const thumb = $(".slot-thumb", el);
    const show = () => {
      const [up, name] = info.get();
      el.classList.toggle("done", !!up);
      stateEl.innerHTML = up ? `✓ ${esc(name)} <button type="button" class="linkbtn dark" data-clear>Remove</button>` : esc(info.kind === "photo" ? "No photo yet" : "Not uploaded");
      const clr = $("[data-clear]", stateEl);
      if (clr) clr.onclick = () => {
        info.put(null, "");
        if (info.kind === "photo") { v.products[+id.slice(5)].color = ""; showColors(+id.slice(5)); } // the color was that photo
        save(); show();
      };
      if (info.kind === "photo") {
        thumb.hidden = !up;
        if (up) thumb.src = `/api/uploads/${up}/file`;
      }
    };
    const take = async (file) => {
      if (!file) return;
      busy.add(id);
      el.classList.remove("done");
      stateEl.textContent = `Uploading ${file.name}… 0%`;
      try {
        const up = await sendFile(file, info.kind, (p) => { stateEl.textContent = `Uploading ${file.name}… ${Math.round(p * 100)}%`; });
        info.put(up.id, file.name);
        save();
        show();
      } catch (err) {
        stateEl.innerHTML = `<span class="bad">${esc(err.message)}</span>`;
      } finally { busy.delete(id); }
    };
    slotUi[id] = { show };
    show();
    $("input[type=file]", el).onchange = (e) => { const file = e.target.files[0]; e.target.value = ""; take(file); };
    // Drag a file from the desktop (or a photo from another browser tab) onto the box.
    el.addEventListener("dragover", (e) => { e.preventDefault(); el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", async (e) => {
      e.preventDefault();
      el.classList.remove("over");
      const file = e.dataTransfer.files[0];
      if (file) return take(file);
      const url = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
      if (url && info.kind === "photo") {
        // A photo dragged out of a web page arrives as its address; fetch it on our side and save it.
        stateEl.textContent = "Getting that photo…";
        try {
          const r = await api("POST", `/api/lookup/image?brand=${state.brand}`, { url: url.split("\n")[0].trim() });
          info.put(r.photo.id, r.photo.name);
          save();
          show();
        } catch (err) { stateEl.innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
      }
    });
  });
  // A file dropped anywhere else would make the browser leave the page and lose uploads in progress.
  ["dragover", "drop"].forEach((t) => form.addEventListener(t, (e) => e.preventDefault()));

  // Paste a product link, or type a style number: fill in whatever is still blank (name, style number, photo).
  // A field still holding what an earlier lookup put there (or leftover page code) can be refilled.
  const open = (cur, prev) => !String(cur ?? "").trim() || cur === prev || /&#?x?\w+;/.test(cur);
  const lookedUp = new Set();
  const fillFrom = async (i, key, how, path, payload, where) => {
    const p = v.products[i];
    const auto = p.auto || {};
    const out = form.querySelector(`[data-linkstate="${i}"]`);
    if (lookedUp.has(key)) return;
    lookedUp.add(key);
    out.textContent = how;
    busy.add(`link${i}`);
    try {
      const r = await api("POST", `${path}?brand=${state.brand}`, payload);
      const got = [];
      if (r.name && open(p.name, auto.name)) { p.name = r.name; got.push("name"); }
      if (r.style && open(p.style, auto.style)) { p.style = r.style; got.push("style number"); }
      else if (r.style && p.style.replace(/[^a-z0-9]/gi, "").toUpperCase() === r.style.replace(/[^A-Z0-9]/g, "")) p.style = r.style;
      if (r.photo && (!p.photo || p.photo === auto.photo)) { p.photo = r.photo.id; p.photoName = r.photo.name; got.push("photo"); }
      p.auto = { name: r.name ? p.name : auto.name, style: r.style ? p.style : auto.style, photo: r.photo ? p.photo : auto.photo };
      save();
      fill();
      slotUi[`photo${i}`].show();
      if (r.colors?.length) { p.colors = r.colors; p.color = ""; save(); showColors(i); }
      out.textContent = got.length ? `Filled in the ${got.join(", ").replace(/, ([^,]*)$/, " and $1")} from ${r.from || where}. Check them.` : `Nothing new from ${r.from || where}; what's here stays.`;
    } catch (err) {
      out.innerHTML = `<span class="bad">${esc(err.message)}</span>`;
      lookedUp.delete(key);
    } finally { busy.delete(`link${i}`); }
  };
  // Color choices from a style lookup: picking one swaps the photo to that color.
  const showColors = (i) => {
    const p = v.products[i];
    const box = form.querySelector(`[data-colors="${i}"]`);
    box.hidden = !f.products.style || !p.colors?.length;
    if (box.hidden) return;
    box.innerHTML = `<label class="small muted" for="pc${i}">Color in the video</label><select id="pc${i}" data-colorpick><option value="">Pick a color (${p.colors.length})</option>${p.colors.map((c, n) =>
      `<option value="${n}"${c.name === p.color ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select><span class="small muted" data-colorstate></span>`;
    const pick = $("[data-colorpick]", box);
    const stateEl = $("[data-colorstate]", box);
    const back = () => { const n = p.colors.findIndex((c) => c.name === p.color); pick.value = n < 0 ? "" : String(n); }; // after a failed pick
    pick.onchange = async () => {
      if (pick.value === "") return;
      const c = p.colors[+pick.value];
      stateEl.textContent = `Getting ${c.name}…`;
      busy.add(`color${i}`);
      try {
        const r = await api("POST", `/api/lookup/image?brand=${state.brand}`, { url: c.image });
        p.photo = r.photo.id;
        p.photoName = `${p.style || "photo"} ${c.name}`;
        p.color = c.name;
        p.auto = { ...(p.auto || {}), photo: p.photo };
        save();
        slotUi[`photo${i}`].show();
        stateEl.textContent = "";
      } catch (err) { stateEl.innerHTML = `<span class="bad">${esc(err.message)}</span>`; back(); } finally { busy.delete(`color${i}`); }
    };
    // A color with no photo (saved by an earlier version): get its photo again rather than show a color that isn't there.
    if (p.color && !p.photo) {
      const n = p.colors.findIndex((c) => c.name === p.color);
      p.color = "";
      if (n >= 0) { pick.value = String(n); pick.onchange(); } else back();
    }
  };
  prods.forEach((_, i) => showColors(i));
  const lookup = (i) => {
    const p = v.products[i];
    const auto = p.auto || {};
    const link = p.link.trim();
    if (!link || (!open(p.name, auto.name) && !open(p.style, auto.style) && p.photo && p.photo !== auto.photo)) return;
    return fillFrom(i, `${i}:${link}`, "Reading that page…", "/api/lookup", { url: link }, "the page");
  };
  const lookupStyle = (i) => {
    const p = v.products[i];
    const auto = p.auto || {};
    const style = p.style.trim();
    // Only when someone typed it (not a style an earlier lookup filled in) and something is still missing.
    if (!style || style === auto.style || (!open(p.name, auto.name) && p.photo && p.photo !== auto.photo)) return;
    return fillFrom(i, `${i}:style:${style}`, "Looking up that style…", "/api/lookup/style", { style }, "the supplier");
  };
  form.querySelectorAll("[data-link]").forEach((el) => {
    const i = +el.dataset.link;
    el.addEventListener("change", () => lookup(i));
    el.addEventListener("paste", () => setTimeout(() => { set(el.dataset.k, el.value); save(); lookup(i); }, 0));
    // Clean up names an earlier version filled in with leftover page code.
    if (/&#?x?\w+;/.test(v.products[i].name) && v.products[i].link.trim()) lookup(i);
  });
  form.querySelectorAll("[data-stylebox]").forEach((el) => el.addEventListener("change", () => lookupStyle(+el.dataset.stylebox)));

  $("#draftBtn").onclick = async () => {
    const btn = $("#draftBtn");
    const out = $("#draftState");
    if (prods.some((p) => !p.name.trim())) { out.innerHTML = `<span class="bad">${N === 1 ? `Name the ${esc(f.products.nameLabel.toLowerCase())} first` : `Name all ${N} products first`} (step 3).</span>`; return; }
    const written = [v.hook, v.cta, ...prods.map((p) => p.script), ...f.beats.map((b) => v.beats[b.id].script)].some((x) => x.trim());
    if (written && !confirm("Replace what's in the script now with a new draft?")) return;
    btn.disabled = true;
    out.textContent = "Claude is writing… (about 20 seconds)";
    try {
      const { draft, unread = [] } = await api("POST", `/api/draft?brand=${state.brand}`, {
        template: f.id, goal: v.goal, audience: v.audience, topic: v.topic, notes: v.notes, presenter: v.presenter.name, winner: v.winner,
        products: prods.map((p) => ({ name: p.name, link: p.link, price: p.price })),
      });
      v.hook = draft.hook;
      v.hookText = draft.hookText;
      v.cta = draft.cta;
      if (!v.title.trim()) v.title = draft.title;
      draft.products.forEach((d, i) => Object.assign(v.products[i], { shortName: d.shortName, tag: d.tag }));
      for (const d of draft.beats) {
        const b = f.beats.find((x) => x.id === d.id);
        if (b.kind === "product") v.products[b.product].script = d.script;
        else v.beats[b.id].script = d.script;
        if (b.text) v.beats[b.id].text = d.text;
      }
      save();
      fill();
      out.textContent = "Drafted. Read it out loud and change anything that doesn't sound like you."
        + (unread.length ? ` Couldn't open the page for ${unread.join(", ")}, so that part is written from the name and your notes only.` : "");
    } catch (err) {
      out.innerHTML = `<span class="bad">${esc(err.message)}</span>`;
    }
    btn.disabled = false;
  };

  $("#clearBtn").onclick = () => {
    if (!confirm(v.draftId ? "Clear this form? The saved draft stays in Videos." : "Clear this form and start over?")) return;
    store(key, "");
    pageNew();
  };

  $("#saveDraftBtn").onclick = async () => {
    const out = $("#saveState");
    if (busy.size) { out.innerHTML = `<span class="bad">Wait for the uploads to finish first.</span>`; return; }
    const btn = $("#saveDraftBtn");
    btn.disabled = true;
    try {
      const d = await saveDraft(v);
      store(key, JSON.stringify(v));
      out.innerHTML = `Saved as “${esc(d.title)}”. It's in <a href="#/videos">Videos</a> under Drafts.`;
    } catch (err) { out.innerHTML = `<span class="bad">${esc(err.message)}</span>`; }
    btn.disabled = false;
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $("#err");
    if (busy.size) { err.innerHTML = `<div class="error">Wait for the uploads to finish first.</div>`; return; }
    if (v.presenter.mode === "heygen" && !confirm(`The AI avatar uses about $${avatarEstimate().usd.toFixed(2)} of HeyGen credits. Build it?`)) return;
    const btn = $("#buildBtn");
    btn.disabled = true;
    try {
      const spec = {
        template: f.id, title: v.title, goal: v.goal, audience: v.audience, look: v.presenter.mode === "none" ? "showcase" : v.look, winner: v.winner,
        presenter: { mode: ["heygen", "none"].includes(v.presenter.mode) ? v.presenter.mode : "self", name: v.presenter.name, title: v.presenter.title },
        ...(v.transition ? { transition: v.transition } : {}),
        ...(v.presenter.mode === "none" && v.voice ? { voice: v.voice } : {}),
        hook: v.hook, hookText: v.hookText, cta: v.cta, link: v.link, greenScreen: v.greenScreen,
        products: prods.map(({ photoName, auto, colors, color, ...p }) => p),
        beats: Object.fromEntries(f.beats.map((b) => [b.id, v.beats[b.id]])),
        footage: Object.fromEntries(clips.filter((c) => v.footage[c]).map((c) => [c, v.footage[c]])),
      };
      const j = await api("POST", "/api/jobs", { kind: "build", brand: state.brand, draft: v.draft, spec });
      if (v.draftId) await api("DELETE", `/api/drafts/${v.draftId}`).catch(() => {}); // built, so it's not a draft anymore
      store(key, "");
      location.hash = `#/videos/${j.id}`;
    } catch (ex) {
      err.innerHTML = `<div class="error">${esc(ex.message)}</div>`;
      btn.disabled = false;
    }
  };
}

// ---------- team ----------

async function pageTeam() {
  if (state.me.role !== "admin") { location.hash = "#/videos"; return; }
  const canAll = state.me.brand === "*";
  shell("team", `${header(canAll ? "All brands" : brandName(state.me.brand), "Team", "Who can sign in. New people get a temporary password and pick their own the first time they sign in.")}
    <div id="shown"></div>
    <div id="asks"></div>
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
    // People who pressed "Forgot your password?" on the sign-in page.
    const asks = users.filter((u) => u.resetRequestedAt && !u.disabled);
    state.resetRequests = asks.length;
    $(".nav .count")?.remove();
    if (asks.length) $('.nav a[href="#/team"]')?.insertAdjacentHTML("beforeend", ` <span class="count">${asks.length}</span>`);
    $("#asks").innerHTML = asks.length ? `<div class="card"><h2>Asking for a new password</h2>
      <p class="muted small" style="margin:0 0 12px">They pressed “Forgot your password?” on the sign-in page. Reset it, then send them the temporary password yourself.</p>
      <div class="drafts">${asks.map((u) => `<div class="draft" data-id="${u.id}"><b>${esc(u.name)}</b><span class="small muted">${esc(u.email)} · asked ${esc(ago(u.resetRequestedAt))}</span>
        <span class="row"><button class="btn small" type="button" data-act="reset">Reset Password</button></span></div>`).join("")}</div></div>` : "";
    $("#people").innerHTML = `<table><thead><tr><th>Name</th><th>Email</th>${canAll ? "<th>Brand</th>" : ""}<th>Role</th><th>Last sign in</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr class="${u.disabled ? "off" : ""}" data-id="${u.id}">
        <td>${esc(u.name)}${u.id === state.me.id ? ' <span class="tag">You</span>' : ""}${u.disabled ? ' <span class="tag">Turned off</span>' : ""}${u.resetRequestedAt && !u.disabled ? ' <span class="tag">Wants a new password</span>' : ""}</td>
        <td>${esc(u.email)}</td>${canAll ? `<td>${esc(brandName(u.brand))}</td>` : ""}
        <td>${u.role === "admin" ? "Admin" : "Staff"}</td>
        <td class="small">${u.lastLoginAt ? esc(ago(u.lastLoginAt)) : u.mustChange ? "Not yet" : ""}</td>
        <td><div class="row" style="justify-content:flex-end;gap:6px">${u.id === state.me.id ? "" : `
          <button class="btn outline small" data-act="reset">Reset Password</button>
          <button class="btn outline small" data-act="role">${u.role === "admin" ? "Make Staff" : "Make Admin"}</button>
          <button class="btn outline small" data-act="toggle">${u.disabled ? "Turn On" : "Turn Off"}</button>`}</div></td>
      </tr>`).join("")}</tbody></table>`;
    document.querySelectorAll("#people button[data-act], #asks button[data-act]").forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.closest("[data-id]").dataset.id;
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

// ---------- AI avatar (admins): pick the HeyGen look, make a test clip ----------

const lookImg = (l) => (l.preview ? `<img src="/api/heygen/preview?u=${encodeURIComponent(l.preview)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'noimg'}))">` : '<div class="noimg"></div>');

async function pageAvatar() {
  if (state.me.role !== "admin") { location.hash = "#/videos"; return; }
  shell("avatar", `${header("Setup", "AI avatar", "Pick the HeyGen look that AI-avatar videos use, then make one short test clip to check it.")}
    <div id="keyNote"></div>
    <div class="card"><h2>Your look</h2><div id="chosen"><p class="muted">Loading…</p></div></div>
    <div class="card"><h2>Pick a look</h2><p class="muted small" style="margin:0 0 16px">Your own avatars from HeyGen. Stock avatars aren't shown.</p>
      <div id="looks"><button class="btn outline" type="button" id="loadLooks">Show My Looks</button></div></div>
    <div class="card"><h2>Test clip</h2>
      <p class="muted small" style="margin:0 0 16px">One sentence, about 8 seconds. It uses HeyGen credits. "Clear background" is what the factory wants; if HeyGen says your look can't do it, try green.</p>
      <div class="row"><button class="btn" type="button" data-test="clear">Make Test Clip</button><button class="btn outline" type="button" data-test="green">Try Green Background</button></div>
      <div id="testOut" style="margin-top:16px"></div></div>`);

  let info = await api("GET", "/api/heygen");
  if (!info.ready) $("#keyNote").innerHTML = `<div class="notice"><b>HeyGen isn't connected yet.</b> Add <code>HEYGEN_API_KEY</code> as a secret on the content-factory-dashboard Worker in Cloudflare.</div>`;

  const showChosen = () => {
    const l = info.choice;
    $("#chosen").innerHTML = l
      ? `<div class="looks"><div class="look on">${lookImg(l)}<div class="meta"><b>${esc(l.name)}</b>${l.type ? `<span class="small muted">${esc(l.type)}</span>` : ""}</div></div></div>`
      : `<p class="muted">None picked yet.</p>`;
    document.querySelectorAll("[data-test]").forEach((b) => { b.disabled = !l || !info.ready; });
  };

  const showTest = () => {
    const t = info.test;
    const out = $("#testOut");
    stopTimer();
    if (!t) { out.innerHTML = ""; return; }
    const kind = t.mode === "green" ? "green background" : "clear background";
    if (t.saved) {
      out.innerHTML = `<p class="small" style="margin:0 0 10px"><b>Done</b> (${kind}). The squares show through anywhere the background is clear. Browsers can play this kind of clip out of sync; the finished video is fine.</p>
        <div class="checker"><video controls playsinline src="/api/heygen/test/video?v=${encodeURIComponent(t.saved)}"></video></div>`;
      return;
    }
    if (t.status === "failed") { out.innerHTML = `<div class="notice"><b>The test clip failed</b> (${kind}).<br>${esc(t.message || "HeyGen didn't say why.")}</div>`; return; }
    out.innerHTML = `<p class="small muted" style="margin:0">HeyGen is making the ${kind} clip (${esc(t.status)}). This usually takes a few minutes. You can leave this page.</p>`;
    state.timer = setTimeout(async () => {
      try { info.test = (await api("GET", "/api/heygen/test/refresh")).test; showTest(); }
      catch (e) { out.innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
    }, 10000);
  };

  showChosen();
  showTest();

  const loadLooks = async () => {
    $("#looks").innerHTML = `<p class="muted">Loading…</p>`;
    try {
      const { looks } = await api("GET", "/api/heygen/looks");
      if (!looks.length) { $("#looks").innerHTML = `<p class="muted">HeyGen didn't return any looks of your own.</p>`; return; }
      $("#looks").innerHTML = `<div class="looks">${looks.map((l, i) => `<div class="look ${info.choice?.id === l.id ? "on" : ""}">${lookImg(l)}
        <div class="meta"><b>${esc(l.name)}</b>${l.type ? `<span class="small muted">${esc(l.type)}</span>` : ""}
        <button class="btn small" type="button" data-pick="${i}">${info.choice?.id === l.id ? "In Use" : "Use This"}</button></div></div>`).join("")}</div>`;
      document.querySelectorAll("[data-pick]").forEach((b) => {
        b.onclick = async () => {
          const l = looks[Number(b.dataset.pick)];
          try { info.choice = (await api("PUT", "/api/heygen/choice", l)).choice; info.test = null; showChosen(); showTest(); loadLooks(); }
          catch (e) { alert(e.message); }
        };
      });
    } catch (e) { $("#looks").innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
  };
  $("#loadLooks").onclick = loadLooks;

  document.querySelectorAll("[data-test]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Make a test clip? It uses HeyGen credits.")) return;
      b.disabled = true;
      try { info.test = (await api("POST", "/api/heygen/test", { mode: b.dataset.test })).test; showTest(); }
      catch (e) { $("#testOut").innerHTML = `<div class="notice">${esc(e.message)}</div>`; }
      finally { b.disabled = false; }
    };
  });
}

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
  if (parts[0] === "new") return pageNew(params).catch(fail);
  if (parts[0] === "team") return pageTeam().catch(fail);
  if (parts[0] === "avatar") return pageAvatar().catch(fail);
  if (parts[0] === "account") return pageAccount(false);
  return pageVideos().catch(fail);
}

async function start() {
  const reset = location.hash.match(/^#\/reset\?token=([0-9a-f]{64})$/);
  if (reset) return showReset(reset[1]);
  try {
    const r = await api("GET", "/api/me");
    state.me = r.user;
    state.brands = r.brands;
    state.resetRequests = r.resetRequests ?? 0;
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
