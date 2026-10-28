export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  WORKER_TOKEN: string;
  SUBMIT_TOKENS: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string; // tests only: a stand-in for the Claude API
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
