// Content Factory dashboard: the screens staff use. Plain JavaScript, no build step.
// Pages: #/videos, #/videos/<id>, #/new, #/render, #/team, #/account. Everything talks to /api/.
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
    hook: "", hookText: "", cta: "", link: "", greenScreen: true, draft: false,
    products: [0, 1, 2, 3, 4].map(() => ({ name: "", link: "", style: "", shortName: "", tag: "", script: "", photo: null, photoName: "" })),
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
      <div class="choices two" style="margin-top:10px">
        ${choice("look", "creator", "Creator-style cut", "Feels like a person talking, with a music bed. Best for Reels and TikTok.")}
        ${choice("look", "full", "Polished brand reel", "Full brand graphics on every product.")}
      </div>
    </div>

    <div class="card"><div class="step">3</div><h2>${esc(f.products.title)}</h2><p class="muted small" style="margin:0 0 16px">${esc(f.products.hint)}</p>
      ${prods.map((_, i) => `<div class="product${N === 1 ? " solo" : f.products.labels[i].length > 3 ? " flat" : ""}" data-i="${i}">
        ${N === 1 ? "" : `<div class="pnum">${esc(f.products.labels[i])}</div>`}
        <div class="pgrid">
          <div class="field wide"><label for="pl${i}">Link</label><input type="text" id="pl${i}" data-k="products.${i}.link" data-link="${i}" placeholder="${esc(f.products.linkHint)}"><div class="hint" data-linkstate="${i}"></div></div>
          <div class="field${f.products.style ? "" : " wide"}"><label for="pn${i}">${esc(f.products.nameLabel)}</label><input type="text" id="pn${i}" data-k="products.${i}.name"></div>
          ${f.products.style ? `<div class="field"><label for="ps${i}">Style number</label><input type="text" id="ps${i}" data-k="products.${i}.style" data-stylebox="${i}" placeholder="e.g. 5000 or Gildan 5000"></div>` : ""}
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
      <div class="choices two" style="margin-top:12px">
        ${choice("presenter", "self", "Record yourself", "Film each line on your phone and upload it below.")}
        ${choice("presenter", "heygen", "AI avatar (HeyGen)", "Coming soon.", true)}
      </div>
      <div class="grid2" style="margin-top:18px">
        <div class="field"><label for="prName">Name on screen</label><input type="text" id="prName" data-k="presenter.name"></div>
        <div class="field"><label for="prTitle">Title on screen <span class="muted">(optional)</span></label><input type="text" id="prTitle" data-k="presenter.title" placeholder="e.g. Vice President, BeeGraphix"></div>
      </div>
      <h3 class="sub">Footage</h3>
      <p class="muted small" style="margin:0 0 12px">One clip per line: the hook, each part of the middle, and the payoff. Vertical, look at the lens. Skip any you haven't filmed yet and the video shows a placeholder there.</p>
      <label class="check" style="margin-bottom:14px"><input type="checkbox" data-k="greenScreen"><span>I filmed on the green screen<br><span class="small muted">The desktop cuts out the background and puts you in the brand studio.</span></span></label>
      <div class="slots">${clips.map((c) => slot(`clip-${c}`, clipLabel(c), "video/mp4,video/quicktime,.mov,.mp4,.m4v", "Not uploaded")).join("")}</div>
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
    form.querySelector("input[name=presenter][value=self]").checked = true;
    names();
  };
  const names = () => form.querySelectorAll("[data-pname]").forEach((el) => { el.textContent = v.products[el.dataset.pname].name; });
  form.addEventListener("input", (e) => {
    const el = e.target;
    if (el.dataset.k) set(el.dataset.k, el.type === "checkbox" ? el.checked : el.value);
    else if (el.name === "goal" || el.name === "look") v[el.name] = el.value;
    else if (el.name === "winner") v.winner = Number(el.value);
    else if (el.name === "template") {
      // Products and programs (FAN Fundraiser, stores) don't mix: each keeps its own boxes, so switching never carries a shirt into a program.
      const kindOf = (id) => (state.formats.find((x) => x.id === id)?.products.style === false ? "programs" : "products");
      const was = kindOf(v.template), now = kindOf(el.value);
      if (was !== now) {
        v.shelf = { ...(v.shelf || {}), [was]: v.products };
        v.products = v.shelf[now]?.length === 5 ? v.shelf[now] : blankVideo().products;
      }
      v.template = el.value; save(); return pageNew(); // redraw for the new format
    }
    else return;
    if (el.dataset.k?.endsWith(".name")) names();
    const pm = el.dataset.k?.match(/^products\.(\d)\.(link|name|style)$/);
    if (pm) {
      const p = v.products[+pm[1]];
      if (![p.link, p.name, p.style].some((x) => String(x ?? "").trim()) && (p.photo || p.colors)) {
        Object.assign(p, { photo: null, photoName: "", colors: undefined, color: "", auto: undefined });
        slotUi[`photo${pm[1]}`]?.show();
        showColors(+pm[1]);
      }
    }
    save();
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
      if (clr) clr.onclick = () => { info.put(null, ""); save(); show(); };
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
      } catch (err) { stateEl.innerHTML = `<span class="bad">${esc(err.message)}</span>`; } finally { busy.delete(`color${i}`); }
    };
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
      const { draft } = await api("POST", `/api/draft?brand=${state.brand}`, {
        template: f.id, goal: v.goal, audience: v.audience, topic: v.topic, notes: v.notes, presenter: v.presenter.name, winner: v.winner,
        products: prods.map((p) => ({ name: p.name, link: p.link })),
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
      out.textContent = "Drafted. Read it out loud and change anything that doesn't sound like you.";
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
    const btn = $("#buildBtn");
    btn.disabled = true;
    try {
      const spec = {
        template: f.id, title: v.title, goal: v.goal, audience: v.audience, look: v.look, winner: v.winner,
        presenter: { mode: "self", name: v.presenter.name, title: v.presenter.title },
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
  if (parts[0] === "new") return pageNew(params).catch(fail);
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
