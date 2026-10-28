export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  WORKER_TOKEN: string;
  SUBMIT_TOKENS: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string; // tests only: a stand-in for the Claude API
  SS_ACCOUNT?: string; // S&S Activewear account number, for style number lookups
  SS_API_KEY?: string;
  SS_BASE_URL?: string; // tests only: a stand-in for the S&S API
  SANMAR_CUSTOMER?: string; // SanMar Web Services: customer number + sanmar.com login
  SANMAR_USER?: string;
  SANMAR_PASSWORD?: string;
  SANMAR_BASE_URL?: string; // tests only: a stand-in for SanMar
  RESEND_API_KEY?: string; // Resend, for "Forgot your password?" emails. Without it the request goes to the Team page.
  EMAIL_FROM?: string; // sender for those emails; default "Content Factory <noreply@shopbgx.com>"
  RESEND_BASE_URL?: string; // tests only: a stand-in for Resend
  HEYGEN_API_KEY?: string; // HeyGen, for the AI avatar (heygen.ts)
  HEYGEN_BASE_URL?: string; // tests only: a stand-in for HeyGen
}

export const BRANDS = ["beegraphix", "rugbee"] as const;

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export const now = () => new Date().toISOString();

export async function body<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}
