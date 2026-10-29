// Store ads: paste an InkSoft store link or a Chipply pop-up store link, the desktop builds a ~20 second video from
// the store's products, colors and logo (Content Factory scripts/lib/storead.mjs and chipply.mjs, templates/store/),
// for the store owner to share.
//
// Here the link is checked (InkSoft's public storefront API; Chipply's own store API, which turns some networks away,
// so a Chipply link the dashboard can't read still goes through and the desktop reads it) and a caption is written
// for the owner to paste with the video. The build job carries {template: "storead", storeUri, storeUrl, title, note, caption}
// and renders the campaign's "store" variant.

import { HttpError } from "./common";
import { desktopCan } from "./heygen";
import type { Env } from "./common";

const STORE = /^(?:https?:\/\/)?stores\.inksoft\.com\/([A-Za-z0-9_-]{1,80})(?:[/?#]|$)/i;
const CHIPPLY = /^(?:https?:\/\/)?([a-z0-9-]{1,60})\.chipply\.com\/([A-Za-z0-9_-]{1,80})(?:[/?#]|$)/i;

export interface StoreAdSpec {
  template: "storead";
  storeUri: string;
  storeUrl: string;
  title: string;
  note: string;
  caption: string;
  /** When the sale ends, typed on the Store Ad page (ISO with the Eastern offset). Wins over a store's own countdown. */
  endsAt?: string;
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The caption the owner posts with the video: plain, in their voice, ending on the link. */
export function storeCaption(name: string, note: string, url: string, endsAt?: string | null) {
  const n = note ? (/[.!?]$/.test(note) ? note : `${note}.`) : "";
  const ends = endsAt ? endsLine(endsAt) : "";
  return [name ? `The ${name} store is open.` : "Our store is open.", n, ends, `Shop it here: ${url}`].filter(Boolean).join(" ");
}

/** "Orders close Mon, Nov 2 at 1:30 PM." in Eastern time, or "" for a bad date. */
export function endsLine(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const tz = "America/New_York";
  const day = d.toLocaleDateString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric" });
  const time = d.toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).replace(":00", "");
  return `Orders close ${day} at ${time}.`;
}

/**
 * "2026-11-02" + "13:30" typed on the page, as an instant in Eastern time: "2026-11-02T13:30:00-05:00".
 * Null when either is missing or not a real date and time.
 */
export function easternIso(date: unknown, time: unknown) {
  const d = String(date ?? "").trim(), t = String(time ?? "").trim() || "23:59";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) return null;
  for (const off of ["-04:00", "-05:00"]) {
    const at = new Date(`${d}T${t}:00${off}`);
    if (Number.isNaN(at.getTime())) return null;
    const back = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at).replace(", ", "T");
    if (back === `${d}T${t}`) return `${d}T${t}:00${off}`;
  }
  return null;
}

/** A store's own countdown only counts while it's still ahead: pop-up stores often keep an old one from a past sale. */
const future = (iso: string | null | undefined) => (iso && Date.parse(iso) > Date.now() ? iso : null);

/** A Chipply pop-up store: its name and close date when Chipply answers us, else just the link. */
async function chipplyStore(env: Env, origin: string, slug: string) {
  const base = env.CHIPPLY_BASE_URL || origin;
  const link = `${origin}/${slug}`;
  try {
    const opts = { headers: { accept: "application/json" }, redirect: "manual" as const };
    const who: any = await fetch(`${base}/api/store/resolvestorefromurl?url=${encodeURIComponent(link)}`, opts).then((r) => (r.ok ? r.json() : null));
    if (!who?.storeId) return { name: "", endsAt: null as string | null, read: false };
    const b: any = await fetch(`${base}/api/Event/Branding?eventId=${who.storeId}`, opts).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const endsAt = b?.dto?.shouldIncludeCountdown && b?.dto?.countdownCloseDate ? String(b.dto.countdownCloseDate) : null;
    return { name: clean(who.storeName, 120), endsAt, read: true };
  } catch {
    return { name: "", endsAt: null, read: false };
  }
}

export async function validateStoreAd(env: Env, raw: any): Promise<StoreAdSpec> {
  const link = clean(raw?.storeUrl, 300);
  const note = clean(raw?.note, 80);
  // A close date typed on the page wins over the store's own countdown.
  let typedEnd: string | null = null;
  if (raw?.endsDate || raw?.endsTime) {
    typedEnd = easternIso(raw.endsDate, raw.endsTime);
    if (!typedEnd) throw new HttpError(400, "Pick the date (and time) the sale ends");
    if (Date.parse(typedEnd) <= Date.now()) throw new HttpError(400, "That close date has already passed");
  }
  const ends = typedEnd ? { endsAt: typedEnd } : {};
  const pop = link.match(CHIPPLY);
  if (pop) {
    if (!(await desktopCan(env, "storead-chipply"))) throw new HttpError(400, "Pop-up store ads need a desktop update first");
    const origin = `https://${pop[1].toLowerCase()}.chipply.com`;
    const slug = pop[2];
    const url = `${origin}/${slug}`;
    const s = await chipplyStore(env, origin, slug);
    // Chipply sometimes turns the dashboard away; the desktop reads the store itself, so the job goes ahead.
    const name = s.name;
    return { template: "storead", storeUri: slug.toLowerCase(), storeUrl: url, title: name ? `${name} store` : `Pop-up store: ${slug}`, note, caption: storeCaption(name, note, url, typedEnd ?? future(s.endsAt)), ...ends };
  }
  const m = link.match(STORE);
  if (!m) throw new HttpError(400, "Paste the store's InkSoft or Chipply link, like stores.inksoft.com/yourstore or yourshop.chipply.com/yourstore");
  if (!(await desktopCan(env, "storead"))) throw new HttpError(400, "Store ads need a desktop update first");
  const uri = m[1];
  let name = "";
  try {
    const res = await fetch(`${env.INKSOFT_BASE_URL || "https://stores.inksoft.com"}/${uri}/Api2/GetStoreData?Format=JSON`);
    const out: any = res.ok ? await res.json() : null;
    name = clean(out?.Data?.Name, 120);
  } catch {
    name = "";
  }
  if (!name) throw new HttpError(400, `InkSoft has no store at "${uri}". Check the link.`);
  const url = `https://stores.inksoft.com/${uri}`;
  return { template: "storead", storeUri: uri, storeUrl: url, title: `${name} store`, note, caption: storeCaption(name, note, url, typedEnd), ...ends };
}
