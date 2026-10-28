# Content Factory Dashboard

A private web dashboard where BeeGraphix and Rugbee staff plan, script and post short videos.
It runs on Cloudflare. The video building itself stays on AI-DESKTOP, in the
[Content Factory](https://github.com/davisbee/beegraphix-content-factory).

```text
 staff browser ──> Cloudflare Worker (this repo) ──> D1 (people, sessions, jobs) + R2 video storage
                                   ^
                                   │ AI-DESKTOP calls out for work (npm run worker), renders with the
                                   │ job's brand kit, uploads the MP4. Nothing on the office network is opened.
```

## Build stages

1. **Brand kits.** Done in the Content Factory (`brands/beegraphix`, `brands/rugbee`).
2. **Job queue and desktop worker.** Done. Jobs can also be submitted by hand with `npm run job` in the
   Content Factory.
3. **The dashboard screens.** In: sign in, the Team page, the Videos list and video page, rendering any
   campaign that's on the desktop again, and the New video screen (goal, template and look, five
   products with photos, a Hook / Middle / Payoff script with "Draft it for me", presenter footage).
   Still to come: approve and post.
4. HeyGen avatars.
5. Rugbee goes live.

## Signing in

Each person has an email and password and belongs to one brand (`beegraphix`, `rugbee`, or `*` for
every brand). Admins add people on the **Team** page; a new person gets a temporary password and picks
their own the first time they sign in. Five wrong passwords lock a login for 15 minutes; an admin's
password reset clears it.

The very first admin is added with the `*` token from `SUBMIT_TOKENS`:

```sh
DASHBOARD_URL=https://content-factory-dashboard.<account>.workers.dev DASHBOARD_ADMIN_TOKEN=<the * token> \
  npm run add-user -- --email you@example.com --name "Your Name" --brand "*" --admin
```

How it's kept safe: passwords are PBKDF2-SHA256 with a salt per person; the browser only holds a random
session cookie (HttpOnly, Secure, SameSite=Lax) and D1 stores its SHA-256; every change request must
come from the dashboard itself (custom header and Origin check); the pages send a strict
Content-Security-Policy (`public/_headers`).

## The job queue API

Every job belongs to one brand. A brand's token only sees its own jobs, and the desktop refuses a job
whose campaign is painted with a different brand kit.

| Who | Call | What it does |
|---|---|---|
| anyone | `POST /api/login`, `POST /api/logout`, `GET /api/me`, `POST /api/me/password` | signing in |
| staff (signed in, or `SUBMIT_TOKENS`) | `POST /api/jobs` `{campaign, variant, draft?, brand?}` | queue a render |
| | `GET /api/jobs`, `GET /api/jobs/:id` | status |
| | `POST /api/jobs/:id/cancel` | cancel while still queued |
| | `GET /api/jobs/:id/video` | the finished MP4 (seekable; `?download` saves it) |
| | `POST /api/jobs` `{kind: "build", spec, draft?, brand?}` | New video: the desktop builds a campaign from the spec, then renders it |
| | `POST /api/uploads?brand=` `{kind, name, type, size}`, `PUT /api/uploads/:id/part?n=`, `POST /api/uploads/:id/complete` | footage (MP4/MOV, 4 GB) and photos (JPG/PNG/WebP, 25 MB) from the browser, in 20 MB pieces |
| | `POST /api/draft?brand=` | "Draft it for me": Claude writes the hook, five product lines and payoff (30 an hour per person) |
| | `GET /api/catalog` | campaigns and versions on the desktop |
| admins | `GET/POST /api/users`, `POST /api/users/:id`, `POST /api/users/:id/reset` | Team page |
| desktop (`WORKER_TOKEN`) | `POST /api/desktop/claim` | take the oldest queued job (204 when none) |
| | `PUT /api/desktop/catalog` | the campaigns on the PC (sent at start and every 10 minutes) |
| | `GET /api/desktop/uploads/:id` | download footage or a photo for a build job |
| | `POST /api/desktop/jobs/:id/heartbeat` | rendering/uploading progress |
| | `POST /api/desktop/jobs/:id/fail` | report an error |
| | `POST …/upload/start`, `PUT …/upload/part?n=`, `POST …/upload/complete` | send the video to R2 in parts |

If the desktop goes quiet for 15 minutes mid-job, the job goes back in line. After 3 tries it's marked failed.

## Secrets

These are set in Cloudflare (`npx wrangler secret put <NAME>` or the dashboard's Settings > Variables
and Secrets), never in git:

- `WORKER_TOKEN`: random string, at least 24 characters. The same value goes in the Content Factory
  `.env` as `DASHBOARD_WORKER_TOKEN`.
- `SUBMIT_TOKENS`: JSON mapping each staff token to a brand, e.g.
  `{"<token>": "beegraphix", "<token>": "rugbee", "<token>": "*"}`. `*` sees every brand.
- `ANTHROPIC_API_KEY` (optional): the Claude API key for "Draft it for me". Without it the button says
  it isn't switched on yet and staff write the script themselves.

## Cloudflare resources

- Worker `content-factory-dashboard` (the screens are the static files in `public/`)
- D1 database `content-factory` (people, sessions, jobs and the campaign list; `migrations/`)
- R2 bucket `content-factory-media` (finished videos under `outputs/<brand>/<job>.mp4`)

`npm run deploy` applies new database migrations, then deploys the Worker.

## Working on it

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev          # http://localhost:8787, with a local database and bucket
# a local admin to sign in with:
DASHBOARD_URL=http://localhost:8787 DASHBOARD_ADMIN_TOKEN=local-admin-token-0123456789abcdef \
  npm run add-user -- --email me@example.com --name Me --brand "*" --admin
npm test             # in a second terminal: end-to-end tests against the dev server
npm run typecheck
```
