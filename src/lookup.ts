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

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/\s+/g, " ").trim();

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

/** Reads what a product page says about itself. Exported for tests. */
export function readProductPage(html: string, pageUrl: string) {
  const p = jsonLdProduct(html);
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "");
  let name = decode(String(p?.name ?? ""));
  // Page titles carry the store's name: "Duck Vest | BeeGraphix" -> "Duck Vest"
  if (!name) name = (meta(html, "og:title") || title).split(/\s[|–—]\s|\s-\s(?=[^-]*$)/)[0].trim();
  const fromData = [p?.sku, p?.mpn, p?.productGroupID, meta(html, "product:retailer_item_id")].map((x) => String(x ?? "").trim()).find((x) => x && x.length <= 20);
  let path = "";
  try { const u = new URL(pageUrl); path = decodeURIComponent(u.pathname + " " + u.search).toUpperCase(); } catch { /* keep empty */ }
  const style = (fromData || name.toUpperCase().match(STYLE)?.[1] || path.replace(/[^A-Z0-9]+/g, " ").match(URL_STYLE)?.[1] || "").toUpperCase();
  // Don't repeat the style number in the name ("Carhartt Duck Vest CT106676").
  if (style) name = name.replace(new RegExp(`[\\s(#-]*${style.replace(/[^A-Z0-9]/gi, "")}\\)?`, "i"), "").trim();
  const image = firstImage(p?.image) || meta(html, "og:image:secure_url") || meta(html, "og:image") || meta(html, "twitter:image");
  let imageUrl = "";
  try { if (image) imageUrl = new URL(image, pageUrl).toString(); } catch { /* bad URL */ }
  return { name: name.slice(0, 120), style: style.replace(/[^A-Z0-9-]/g, "").slice(0, 20), imageUrl };
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

/** Copies a photo from the web into R2 as a finished photo upload. Null if it isn't a usable image. */
async function savePhoto(env: Env, c: Caller, brand: string, imageUrl: string, base: string) {
  const img = await fetchCapped(imageUrl, "image/webp,image/jpeg,image/png", MAX_IMAGE);
  const type = (img?.res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!img || !IMAGE_TYPES[type] || !img.bytes.length) return null;
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
    try { photo = await savePhoto(env, c, brand, info.imageUrl, info.style || "product"); } catch (e) { console.error("lookup image", e); }
  }
  if (!info.name && !info.style && !photo) throw new HttpError(422, "Couldn't find product details on that page. Fill this product in by hand.");
  return json({ name: info.name, style: info.style, photo });
}
