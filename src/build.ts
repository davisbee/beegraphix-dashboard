// New video: the spec staff fill in on the New video screen, and "Draft it for me".
//
// A "build" job carries the whole spec. The desktop starts a Top 5 campaign from it (new-campaign.mjs),
// downloads the footage and photos, keys green screen clips, writes captions, then renders it.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { HttpError, body, json, now, type Env } from "./common";
import type { Caller } from "./auth";
import { readyUploads } from "./uploads";

export const GOALS = ["reach", "target", "sell"] as const;
export const LOOKS = ["creator", "full"] as const; // variant ids in the Top 5 template
export const CLIPS = ["hook", "p1", "p2", "p3", "p4", "p5", "cta"] as const;

export interface BuildProduct {
  name: string;
  shortName: string;
  tag: string;
  style: string;
  link: string;
  script: string;
  photo: string | null;
}

export interface BuildSpec {
  template: "top5";
  title: string;
  goal: (typeof GOALS)[number];
  audience: string;
  look: (typeof LOOKS)[number];
  presenter: { mode: "self"; name: string; title: string };
  hook: string;
  hookText: string;
  cta: string;
  link: string;
  products: BuildProduct[];
  footage: Partial<Record<(typeof CLIPS)[number], string>>;
  greenScreen: boolean;
}

const str = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const URLISH = /^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i;
const UUID = /^[0-9a-f-]{36}$/;

function link(v: unknown, what: string) {
  const s = str(v, 500);
  if (s && !URLISH.test(s)) throw new HttpError(400, `${what} doesn't look like a web address`);
  return s;
}

/** Checks everything the person typed and that every upload is theirs and finished. */
export async function validateSpec(env: Env, brand: string, raw: any): Promise<BuildSpec> {
  const r = raw ?? {};
  if ((r.template ?? "top5") !== "top5") throw new HttpError(400, "Top 5 List is the only template so far");
  const title = str(r.title, 120);
  if (title.length < 4) throw new HttpError(400, "Give the video a title");
  if (!GOALS.includes(r.goal)) throw new HttpError(400, "Pick a goal: reach, target or sell");
  if (!LOOKS.includes(r.look)) throw new HttpError(400, "Pick a look");
  if (r.presenter?.mode !== "self") throw new HttpError(400, "Recording yourself is the only presenter option so far");
  const presenter = { mode: "self" as const, name: str(r.presenter?.name, 80), title: str(r.presenter?.title, 80) };
  if (!presenter.name) throw new HttpError(400, "Who's on camera? Add the presenter's name");
  const hook = str(r.hook, 400);
  const cta = str(r.cta, 600);
  if (!hook) throw new HttpError(400, "Write the hook, or use Draft It For Me");
  if (!cta) throw new HttpError(400, "Write the payoff, or use Draft It For Me");
  if (!Array.isArray(r.products) || r.products.length !== 5) throw new HttpError(400, "A Top 5 needs exactly 5 products");
  const products: BuildProduct[] = r.products.map((p: any, i: number) => {
    const name = str(p?.name, 120);
    if (!name) throw new HttpError(400, `Product ${i + 1} needs a name`);
    const script = str(p?.script, 600);
    if (!script) throw new HttpError(400, `Product ${i + 1} needs its line in the script`);
    const style = str(p?.style, 20).toUpperCase().replace(/[^A-Z0-9-]/g, "");
    const photo = p?.photo ? String(p.photo) : null;
    if (photo && !UUID.test(photo)) throw new HttpError(400, `Product ${i + 1}: bad photo`);
    return { name, shortName: str(p?.shortName, 40) || name.slice(0, 40), tag: str(p?.tag, 60), style, link: link(p?.link, `Product ${i + 1}'s link`), script, photo };
  });
  const styles = products.map((p) => p.style).filter(Boolean);
  if (new Set(styles).size !== styles.length) throw new HttpError(400, "Two products have the same style number");
  const footage: BuildSpec["footage"] = {};
  for (const clip of CLIPS) {
    const id = r.footage?.[clip];
    if (!id) continue;
    if (!UUID.test(String(id))) throw new HttpError(400, `Bad footage for ${clip}`);
    footage[clip] = String(id);
  }
  await readyUploads(env, brand, [
    ...Object.entries(footage).map(([clip, id]) => ({ id: id!, kind: "footage" as const, what: `Video for ${clipName(clip)}` })),
    ...products.flatMap((p, i) => (p.photo ? [{ id: p.photo, kind: "photo" as const, what: `Photo for product ${i + 1}` }] : [])),
  ]);
  return {
    template: "top5", title, goal: r.goal, audience: str(r.audience, 200), look: r.look, presenter,
    hook, hookText: str(r.hookText, 60), cta, link: link(r.link, "The link"), products, footage, greenScreen: !!r.greenScreen,
  };
}

const clipName = (clip: string) => (clip === "hook" ? "the hook" : clip === "cta" ? "the payoff" : `product ${clip.slice(1)}`);

/** A campaign folder name for the desktop: readable, and unique to this job. */
export function campaignId(title: string, jobId: string) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "") || "video";
  return `${base}-${jobId.slice(0, 6)}`;
}

// ---------- Draft it for me ----------

const DRAFTS_PER_HOUR = 30;
const MODEL = "claude-opus-5-5";

const BRAND_NOTES: Record<string, string> = {
  beegraphix: "BeeGraphix decorates custom company apparel (embroidery and screen printing) in Fredericktown, PA. Viewers are business owners and managers buying gear for their crew. Every video ends by sending people to pick favorites and get custom pricing with their logo.",
  rugbee: "Rugbee is a division of BeeGraphix (rugbee.co). Keep claims to what the person tells you about the products.",
};
const GOAL_NOTES: Record<string, string> = {
  reach: "Goal: reach. Get new people to watch to the end and share. Lead with a surprising or contrarian hook. Keep the selling light.",
  target: "Goal: target. Speak directly to the audience named below, in their words, about the problem they have.",
  sell: "Goal: sell. Make the case for buying. The payoff is a clear call to action to the link.",
};

const DraftSchema = z.object({
  title: z.string().describe("Video title, e.g. 'Top 5 Quarter Zips for Fall/Winter 2026'"),
  hook: z.string().describe("Opening line spoken to camera. Under 4 seconds out loud, about 12 to 20 words."),
  hookText: z.string().describe("The hook as short on-screen text, 6 words or fewer."),
  products: z.array(z.object({
    shortName: z.string().describe("Product name as it fits on screen, 4 words or fewer."),
    tag: z.string().describe("3 to 5 word reason to pick it, shown on screen."),
    script: z.string().describe("Spoken line, starting 'Number one,' / 'Number two,' etc. 2 or 3 short sentences, about 8 seconds out loud."),
  })).describe("Exactly 5, in the same order as the products given."),
  cta: z.string().describe("Payoff spoken to camera: where to go and what to do next. About 10 seconds out loud."),
});

/** POST /api/draft: Claude writes the hook, the five product lines and the payoff in the presenter's voice. */
export async function draftScript(req: Request, env: Env, c: Caller, brand: string) {
  if (!env.ANTHROPIC_API_KEY) throw new HttpError(503, "Draft It For Me isn't switched on yet. Write the script yourself for now.");
  const b = await body<{ goal?: string; audience?: string; topic?: string; notes?: string; presenter?: string; products?: Array<{ name?: string; link?: string }> }>(req);
  const products = (Array.isArray(b.products) ? b.products : []).map((p) => ({ name: str(p?.name, 120), link: str(p?.link, 300) }));
  if (products.length !== 5 || products.some((p) => !p.name)) throw new HttpError(400, "Name all 5 products first");
  const goal = GOALS.includes(b.goal as any) ? b.goal! : "reach";

  const since = new Date(Date.now() - 3600_000).toISOString();
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_calls WHERE who = ? AND at > ?").bind(c.label, since).first<{ n: number }>();
  if ((used?.n ?? 0) >= DRAFTS_PER_HOUR) throw new HttpError(429, "That's a lot of drafts this hour. Try again in a bit.");
  await env.DB.prepare("INSERT INTO ai_calls (who, at) VALUES (?, ?)").bind(c.label, now()).run();

  const prompt = [
    `Write the script for a vertical "Top 5" social video (Reels, TikTok, Shorts), about 60 seconds, spoken to camera by ${str(b.presenter, 80) || "the presenter"}.`,
    BRAND_NOTES[brand] ?? "",
    GOAL_NOTES[goal],
    b.audience ? `Audience: ${str(b.audience, 200)}` : "",
    b.topic ? `What the video is about: ${str(b.topic, 300)}` : "",
    "The five products, ranked 1 to 5:",
    ...products.map((p, i) => `${i + 1}. ${p.name}${p.link ? ` (${p.link})` : ""}`),
    b.notes ? `Notes from the presenter: ${str(b.notes, 1200)}` : "",
    "Write like a real person talking, not an ad: plain words, contractions, first person. No em dashes, no hashtags, no emoji.",
    "Only say things about a product that follow from its name or the notes. Don't invent prices, specs or materials.",
  ].filter(Boolean).join("\n");

  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 2, timeout: 60_000 });
  try {
    const res = await client.beta.messages.parse({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(DraftSchema) },
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") throw new HttpError(422, "Claude wouldn't write that one. Try different wording.");
    const out = res.parsed_output;
    if (!out || out.products.length !== 5) throw new HttpError(502, "The draft came back incomplete. Try again.");
    return json({ draft: out });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e instanceof Anthropic.RateLimitError) throw new HttpError(429, "Claude is busy. Try again in a minute.");
    if (e instanceof Anthropic.AuthenticationError) throw new HttpError(503, "The Claude key isn't working. Ask Davis to check it.");
    if (e instanceof Anthropic.APIError) { console.error("draft", e.status, e.message); throw new HttpError(502, "Claude didn't answer. Try again."); }
    throw e;
  }
}
