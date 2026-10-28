// The video formats on the New video screen. Each one is a hook, its own beats, and a payoff.
//
// A beat is one clip the presenter films and one scene in the video:
//   talk     the presenter on camera with a line (or a numbered list) on screen
//   product  a product card with its name, beside a badge ("1", "A") or none
//   compare  two products side by side, then the winner
// The desktop (scripts/lib/build.mjs in the Content Factory) turns the beats into campaign.json scenes.
// The browser gets this table from GET /api/formats, so the screen and the checks never disagree.

export type BeatKind = "talk" | "product" | "compare";

export interface BeatDef {
  id: string;
  kind: BeatKind;
  /** which product the beat shows (product beats) */
  product?: number;
  /** label on the New video screen and the footage box */
  label: string;
  /** what to say, shown under the script box and given to Claude */
  write: string;
  /** on-screen text box label; no on-screen text when missing */
  text?: string;
  /** "list": one step per line, shown as a numbered list */
  textKind?: "line" | "list";
  /** small gold label on screen */
  eyebrow?: string;
  /** shown in place of the rank number on product beats ("" shows nothing) */
  badge?: string;
}

export interface FormatDef {
  id: string;
  name: string;
  blurb: string;
  products: {
    count: number;
    title: string;
    hint: string;
    labels: string[];
    /** label for the name box */
    nameLabel: string;
    linkHint: string;
    /** false hides the style number box (a program has none) */
    style: boolean;
  };
  beats: BeatDef[];
  /** "Pick the winner" for This vs That */
  winner?: boolean;
  /** small gold label on the payoff scene */
  ctaEyebrow: string;
  /** what the whole video is, for Claude */
  brief: string;
  titleExample: string;
}

const PRODUCT_LINK = "Paste the product page, e.g. https://beegraphix.com/…";
const PRODUCT_HINT = "Paste each product's link, or type its style number, and the name and photo fill in by themselves. A clean photo on white works best.";

export const FORMATS: FormatDef[] = [
  {
    id: "top5",
    name: "Top 5 List",
    blurb: "A hook, five products counted down, and a payoff. About a minute.",
    products: { count: 5, title: "The five products", hint: `Ranked, #1 first. ${PRODUCT_HINT}`, labels: ["#1", "#2", "#3", "#4", "#5"], nameLabel: "Product name", linkHint: PRODUCT_LINK, style: true },
    beats: [0, 1, 2, 3, 4].map((i) => ({
      id: `p${i + 1}`, kind: "product" as const, product: i, label: `#${i + 1}`,
      write: `Starts "Number ${["one", "two", "three", "four", "five"][i]}," then why you'd pick it. 2 or 3 short sentences, about 8 seconds.`,
    })),
    ctaEyebrow: "All 5 on one page",
    brief: 'a "Top 5" countdown: the hook, five products ranked 1 to 5, then the payoff',
    titleExample: "Top 5 Quarter Zips for Fall/Winter 2026",
  },
  {
    id: "spotlight",
    name: "Product Spotlight",
    blurb: "One product: the problem, the fix, the proof. 30 to 45 seconds.",
    products: { count: 1, title: "The product", hint: PRODUCT_HINT, labels: ["Product"], nameLabel: "Product name", linkHint: PRODUCT_LINK, style: true },
    beats: [
      { id: "problem", kind: "talk", label: "The problem", eyebrow: "The problem", text: "The problem on screen, 6 words or fewer", write: "The problem your audience has, in their words. 1 or 2 sentences." },
      { id: "fix", kind: "product", product: 0, label: "The fix", eyebrow: "The fix", badge: "", text: "Why it works, 3 to 5 words", write: "This product, and exactly how it fixes that problem. 2 or 3 short sentences." },
      { id: "proof", kind: "talk", label: "Proof or offer", eyebrow: "Why it works", text: "The proof or offer on screen, 6 words or fewer", write: "Proof it works (who wears it, how long it lasts) or the offer. 1 or 2 sentences." },
    ],
    ctaEyebrow: "Get yours",
    brief: "a single product spotlight: the hook, the problem, this product as the fix, proof or the offer, then the payoff",
    titleExample: "The Hoodie Your Crew Will Actually Wear",
  },
  {
    id: "versus",
    name: "This vs That",
    blurb: "Two products head to head, and a winner. About 45 seconds.",
    products: { count: 2, title: "The two products", hint: PRODUCT_HINT, labels: ["A", "B"], nameLabel: "Product name", linkHint: PRODUCT_LINK, style: true },
    beats: [
      { id: "a", kind: "product", product: 0, label: "A", badge: "A", text: "What A is good at, 3 to 5 words", write: "Product A: who it's for and what it does well. 2 sentences." },
      { id: "b", kind: "product", product: 1, label: "B", badge: "B", text: "What B is good at, 3 to 5 words", write: "Product B: who it's for and what it does well. 2 sentences." },
      { id: "verdict", kind: "compare", label: "The verdict", eyebrow: "The verdict", text: "The verdict on screen, e.g. Carhartt wins in the rain", write: "Which one wins and why, and who should still pick the other one. 2 or 3 sentences." },
    ],
    winner: true,
    ctaEyebrow: "See both",
    brief: "a head-to-head comparison: the hook, product A, product B, then the verdict naming the winner, then the payoff",
    titleExample: "Carhartt vs Port Authority: Which Jacket Wins?",
  },
  {
    id: "mistakes",
    name: "3 Mistakes",
    blurb: "Three mistakes buyers make, and the product that fixes each. About 45 seconds.",
    products: { count: 3, title: "The fix for each mistake", hint: `One product per mistake. ${PRODUCT_HINT}`, labels: ["Fix for #1", "Fix for #2", "Fix for #3"], nameLabel: "Product name", linkHint: PRODUCT_LINK, style: true },
    beats: [0, 1, 2].map((i) => ({
      id: `m${i + 1}`, kind: "product" as const, product: i, label: `Mistake ${i + 1}`, eyebrow: `Mistake ${i + 1}`, badge: String(i + 1),
      text: "The mistake on screen, 6 words or fewer",
      write: `Mistake number ${["one", "two", "three"][i]}: what people get wrong, then the fix (this product). 2 or 3 short sentences.`,
    })),
    ctaEyebrow: "Get it right",
    brief: 'a "3 mistakes" video: the hook, three mistakes buyers make (each fixed by one product), then the payoff',
    titleExample: "3 Mistakes When Ordering Crew Shirts",
  },
  {
    id: "story",
    name: "Customer Story",
    blurb: "A real customer: their problem, what you made, the result. About 45 seconds.",
    products: { count: 1, title: "What you made", hint: "A photo of the finished gear works best. Name it for the customer, e.g. Smith Roofing crew hoodies.", labels: ["The gear"], nameLabel: "What you made", linkHint: "Link to the product or the customer's store (optional)", style: true },
    beats: [
      { id: "before", kind: "talk", label: "Before", eyebrow: "Before", text: "Their problem on screen, 6 words or fewer", write: "Who the customer is and the problem they came in with. 1 or 2 sentences." },
      { id: "made", kind: "product", product: 0, label: "What we made", eyebrow: "What we made", badge: "", text: "What you made, 3 to 5 words", write: "What you made for them and why. 2 sentences." },
      { id: "result", kind: "talk", label: "The result", eyebrow: "The result", text: "The result on screen, e.g. 40 hoodies, worn every day", write: "The result: what changed for them. Use real numbers only if the notes give them. 1 or 2 sentences." },
    ],
    ctaEyebrow: "Your crew next",
    brief: "a customer story: the hook, the customer's problem before, what was made for them, the result, then the payoff",
    titleExample: "How Smith Roofing Got Their Crew in Matching Gear",
  },
  {
    id: "program",
    name: "Program Spotlight",
    blurb: "A program like FAN Fundraiser or an online store: what it is, how it works, proof. About 45 seconds.",
    products: { count: 1, title: "The program", hint: "Paste the program page and its photo fills in by itself, or drag in your own.", labels: ["Program"], nameLabel: "Program name", linkHint: "Paste the program page, e.g. https://beegraphix.com/fan-fundraiser", style: false },
    beats: [
      { id: "problem", kind: "talk", label: "The problem", eyebrow: "The problem", text: "The problem on screen, 6 words or fewer", write: "The problem the audience has (e.g. fundraising is a hassle). 1 or 2 sentences." },
      { id: "what", kind: "product", product: 0, label: "What it is", eyebrow: "Meet", badge: "", text: "The big promise, e.g. Keep up to 90% profit", write: "What the program is and the big promise. 2 sentences." },
      { id: "how", kind: "talk", label: "How it works", eyebrow: "How it works", text: "The steps, one per line (3 to 5)", textKind: "list", write: "How it works, in 3 to 5 quick steps. Short sentences." },
      { id: "proof", kind: "talk", label: "Proof", eyebrow: "Real results", text: "The proof on screen, e.g. $3,000 in one season", write: "A real result. Use real numbers only if the notes give them. 1 or 2 sentences." },
    ],
    ctaEyebrow: "Start yours",
    brief: "a program spotlight: the hook (lead with the big number if there is one), the problem, what the program is, how it works in steps, proof, then the payoff",
    titleExample: "Raise More for Your Team With a FAN Fundraiser",
  },
];

export const FORMAT_IDS = FORMATS.map((f) => f.id);
export const formatOf = (id: unknown) => FORMATS.find((f) => f.id === (id ?? "top5"));
