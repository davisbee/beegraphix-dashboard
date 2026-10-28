// "Fill from link": reads a product page and returns the product's name, style number and photo.
//
// Uses what stores publish for search engines and link previews: schema.org Product data (JSON-LD),
// then Open Graph tags, then the page title. The photo is copied into R2 as an upload, so the job
// uses it exactly like a photo someone dropped in.
import { HttpError, body, json, now, type Env } from "./common";
import type { Caller } from "./auth";
import { publicUpload, type UploadRow } from "./uploads";

const IMAGE_TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
const MAX_PAGE = 3 * 1024 * 1024;
const MAX_IMAGE = 25 * 1024 * 1024;
// Apparel style numbers: CT104050, ST253, K805, F217, PC54, 18500, DT6000 ...
const STYLE = /\b([A-Z]{1,4}\d{2,6}[A-Z]{0,2}|\d{4,6})\b/;
// In a web address, bare numbers are usually the store's own ids, so only letter-led codes count there.
const URL_STYLE = /\b([A-Z]{1,4}\d{2,6}[A-Z]{0,2})\b/;

const NAMED: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " ", reg: "®", trade: "™", copy: "©", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
const char = (n: number) => (Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ");

/** HTML entities to text. Some stores encode twice ("&amp;#x20;"), so it repeats until nothing changes. */
export function decode(s: string) {
  let out = s;
  for (let i = 0; i < 4; i++) {
    const next = out
      .replace(/&#x([0-9a-f]+);?/gi, (_, h) => char(parseInt(h, 16)))
      .replace(/&#(\d+);?/g, (_, d) => char(Number(d)))
      .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
    if (next === out) break;
    out = next;
  }
  // Anything still entity-shaped is junk the store left behind.
  return out.replace(/&#?\w*;/g, " ").replace(/&;/g, " ").replace(/\s+/g, " ").trim();
}

function meta(html: string, key: string) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`, "i");
  const tag = html.match(re)?.[0];
  const v = tag?.match(/content=["']([^"']*)["']/i)?.[1];
  return v ? decode(v) : "";
}

/** The first schema.org Product on the page, wherever it's nested. */
function jsonLdProduct(html: string): any {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  const find = (o: any, depth = 0): any => {
    if (!o || typeof o !== "object" || depth > 6) return null;
    if (Array.isArray(o)) { for (const x of o) { const f = find(x, depth + 1); if (f) return f; } return null; }
    const t = o["@type"];
    if (t === "Product" || (Array.isArray(t) && t.includes("Product")) || t === "ProductGroup") return o;
    for (const k of ["@graph", "mainEntity", "itemListElement", "item"]) { const f = find(o[k], depth + 1); if (f) return f; }
    return null;
  };
  for (const m of blocks) {
    try { const f = find(JSON.parse(m[1].trim())); if (f) return f; } catch { /* broken JSON-LD: skip */ }
  }
  return null;
}

const firstImage = (img: any): string => (typeof img === "string" ? img : Array.isArray(img) ? firstImage(img[0]) : img?.url ?? img?.contentUrl ?? "");

/** No preview tags: the first picture on the page whose address names the style number (SanMar-style pages). */
function productImg(html: string, style: string) {
  if (!style) return "";
  const key = style.toLowerCase();
  for (const m of html.matchAll(/<img[^>]+(?:data-src|src)=["']([^"']+\.(?:jpe?g|png|webp)[^"']*)["']/gi)) {
    if (decode(m[1]).toLowerCase().includes(key)) return m[1];
  }
  return "";
}

/** PromoPlace store pages share a 200 px thumbnail; the same address serves a large one. */
function biggerPhoto(u: URL) {
  if (/\/ws\.dll\/QPic$/i.test(u.pathname) && u.searchParams.has("PX")) u.searchParams.set("PX", "1000");
  return u;
}

/** Reads what a product page says about itself. Exported for tests. */
export function readProductPage(html: string, pageUrl: string) {
  const p = jsonLdProduct(html);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  let name = decode(String(p?.name ?? ""));
  // Page titles carry the store's name: "Duck Vest | BeeGraphix" -> "Duck Vest"
  if (!name) name = (meta(html, "og:title") || title).split(/\s[|–—]\s|\s-\s(?=[^-]*$)/)[0].trim();
  // SanMar's catalogs (Company Casuals, sanmar.com) put it in their own page data instead.
  const sanmar = html.match(/"productStyleNumber"\s*:\s*"([^"]{2,20})"/)?.[1] ?? html.match(/data-style-number=["']([^"']{2,20})["']/i)?.[1]
    ?? html.match(/class=["'][^"']*product-style-number[^"']*["'][^>]*>\s*([A-Z0-9-]{2,20})/i)?.[1];
  const fromData = [p?.sku, p?.mpn, p?.productGroupID, meta(html, "product:retailer_item_id"), sanmar].map((x) => String(x ?? "").trim()).find((x) => x && x.length <= 20);
  let path = "";
  try { const u = new URL(pageUrl); path = decodeURIComponent(u.pathname + " " + u.search).toUpperCase(); } catch { /* keep empty */ }
  const style = (fromData || name.toUpperCase().match(STYLE)?.[1] || path.replace(/[^A-Z0-9]+/g, " ").match(URL_STYLE)?.[1] || "").toUpperCase();
  // Don't repeat the style number in the name ("Carhartt Duck Vest CT106676").
  if (style) name = name.replace(new RegExp(`[\\s(#-]*${style.replace(/[^A-Z0-9]/gi, "")}\\)?`, "i"), "").trim();
  const image = firstImage(p?.image) || meta(html, "og:image:secure_url") || meta(html, "og:image") || meta(html, "twitter:image")
    || decode(html.match(/<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i)?.[1] ?? "")
    || productImg(html, style);
  let imageUrl = "";
  let imageFallback = "";
  try {
    if (image) {
      const u = new URL(decode(image), pageUrl);
      // Company Casuals glues its own host onto a CDN address: "https://site:443//cdnp.sanmar.com/...".
      const glued = u.pathname.match(/^\/\/([a-z0-9.-]+\.[a-z]{2,})(\/.*)$/i);
      imageFallback = glued ? `https://${glued[1]}${glued[2]}${u.search}` : u.toString();
      imageUrl = biggerPhoto(new URL(imageFallback)).toString();
    }
  } catch { /* bad URL */ }
  return { name: name.slice(0, 120), style: style.replace(/[^A-Z0-9-]/g, "").slice(0, 20), imageUrl, imageFallback };
}

function checkUrl(raw: string) {
  let u: URL;
  try { u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { throw new HttpError(400, "That doesn't look like a web address"); }
  if (!/^https?:$/.test(u.protocol) || /^(\d+\.){3}\d+$|^\[|^localhost$/i.test(u.hostname) || !u.hostname.includes(".")) throw new HttpError(400, "That doesn't look like a store page");
  return u;
}

async function fetchCapped(url: string, accept: string, max: number) {
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 (compatible; BeeGraphixContentFactory/1.0)", accept },
    redirect: "follow",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok || !res.body) return null;
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > max) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return { res, bytes };
}

/** What the file really is: image servers often say "image/jpg" or "application/octet-stream". */
function imageType(b: Uint8Array, header: string) {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  const h = header.split(";")[0].trim().toLowerCase();
  return IMAGE_TYPES[h] ? h : null;
}

/** Copies a photo from the web into R2 as a finished photo upload. Null if it isn't a usable image. */
async function savePhoto(env: Env, c: Caller, brand: string, imageUrl: string, base: string) {
  const img = await fetchCapped(imageUrl, "image/webp,image/jpeg,image/png", MAX_IMAGE);
  if (!img || !img.bytes.length) return null;
  const type = imageType(img.bytes, img.res.headers.get("content-type") ?? "");
  if (!type) return null;
  const id = crypto.randomUUID();
  const key = `uploads/${brand}/${id}.${IMAGE_TYPES[type]}`;
  await env.MEDIA.put(key, img.bytes, { httpMetadata: { contentType: type }, customMetadata: { brand, upload: id, from: imageUrl.slice(0, 500) } });
  await env.DB.prepare(
    "INSERT INTO uploads (id, brand, kind, name, content_type, bytes, r2_key, upload_id, status, created_by, created_at) VALUES (?, ?, 'photo', ?, ?, ?, ?, NULL, 'ready', ?, ?)",
  ).bind(id, brand, `${base}.${IMAGE_TYPES[type]}`, type, img.bytes.length, key, c.label, now()).run();
  return publicUpload((await env.DB.prepare("SELECT * FROM uploads WHERE id = ?").bind(id).first<UploadRow>())!);
}

/** POST /api/lookup/image?brand= {url}: a photo dragged out of another web page. */
export async function lookupImage(req: Request, env: Env, c: Caller, brand: string) {
  const b = await body<{ url?: string }>(req);
  const url = checkUrl(String(b.url ?? "").trim());
  let photo = null;
  try { photo = await savePhoto(env, c, brand, url.toString(), "photo"); } catch { photo = null; }
  if (!photo) throw new HttpError(422, "Couldn't get that photo. Save it to your computer, then drag the file here.");
  return json({ photo });
}

/** POST /api/lookup?brand= {url} -> {name, style, photo} (any of them may be empty). */
export async function lookupProduct(req: Request, env: Env, c: Caller, brand: string) {
  const b = await body<{ url?: string }>(req);
  const url = checkUrl(String(b.url ?? "").trim());
  let page;
  try { page = await fetchCapped(url.toString(), "text/html,application/xhtml+xml", MAX_PAGE); } catch { page = null; }
  if (!page) throw new HttpError(422, "Couldn't open that page. Fill this product in by hand.");
  const info = readProductPage(new TextDecoder().decode(page.bytes), page.res.url || url.toString());

  let photo = null;
  if (info.imageUrl) {
    for (const u of new Set([info.imageUrl, info.imageFallback])) {
      try { photo = await savePhoto(env, c, brand, u, info.style || "product"); } catch (e) { console.error("lookup image", e); }
      if (photo) break;
    }
  }
  if (!info.name && !info.style && !photo) throw new HttpError(422, "Couldn't find product details on that page. Fill this product in by hand.");
  return json({ name: info.name, style: info.style, photo });
}
