// Store ads: paste an InkSoft store link, the desktop builds a ~20 second video from the store's featured products,
// colors and logo (Content Factory scripts/lib/storead.mjs, templates/store/), for the store owner to share.
//
// Here the link is checked against InkSoft (public storefront API, no key) and a caption is written for the owner
// to paste with the video. The build job carries {template: "storead", storeUri, storeUrl, title, note, caption}
// and renders the campaign's "store" variant.

import { HttpError } from "./common";
import { desktopCan } from "./heygen";
import type { Env } from "./common";

const STORE = /^(?:https?:\/\/)?stores\.inksoft\.com\/([A-Za-z0-9_-]{1,80})(?:[/?#]|$)/i;

export interface StoreAdSpec {
  template: "storead";
  storeUri: string;
  storeUrl: string;
  title: string;
  note: string;
  caption: string;
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The caption the owner posts with the video: plain, in their voice, ending on the link. */
export function storeCaption(name: string, note: string, url: string) {
  const n = note ? (/[.!?]$/.test(note) ? note : `${note}.`) : "";
  return [`The ${name} store is open.`, n, `Shop it here: ${url}`].filter(Boolean).join(" ");
}

export async function validateStoreAd(env: Env, raw: any): Promise<StoreAdSpec> {
  const m = clean(raw?.storeUrl, 300).match(STORE);
  if (!m) throw new HttpError(400, "Paste the store's InkSoft link, like stores.inksoft.com/yourstore");
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
  const note = clean(raw?.note, 80);
  const url = `https://stores.inksoft.com/${uri}`;
  return { template: "storead", storeUri: uri, storeUrl: url, title: `${name} store`, note, caption: storeCaption(name, note, url) };
}
