# Content Factory Dashboard

A private web dashboard where BeeGraphix and Rugbee staff plan, script and post short videos.
It runs on Cloudflare. The video building itself stays on AI-DESKTOP, in the
[Content Factory](https://github.com/davisbee/beegraphix-content-factory).

```text
 staff browser ──> Cloudflare Worker (this repo) ──> D1 job queue + R2 video storage
                                   ^
                                   │ AI-DESKTOP calls out for work (npm run worker), renders with the
                                   │ job's brand kit, uploads the MP4. Nothing on the office network is opened.
```

## Build stages

1. **Brand kits.** Done in the Content Factory (`brands/beegraphix`, `brands/rugbee`).
2. **Job queue and desktop worker.** This repo is at this stage. It's an API only: jobs are submitted
   by hand with `npm run job` in the Content Factory.
3. The dashboard screens: login, goal, presenter, template, script box, uploads, status, approve and post.
4. HeyGen avatars.
5. Rugbee goes live.

## The job queue API

Every job belongs to one brand. A brand's token only sees its own jobs, and the desktop refuses a job
whose campaign is painted with a different brand kit.

| Who | Call | What it does |
|---|---|---|
| staff (`SUBMIT_TOKENS`) | `POST /api/jobs` `{campaign, variant, draft?, brand?}` | queue a render |
| | `GET /api/jobs`, `GET /api/jobs/:id` | status |
| | `POST /api/jobs/:id/cancel` | cancel while still queued |
| | `GET /api/jobs/:id/video` | the finished MP4 |
| desktop (`WORKER_TOKEN`) | `POST /api/desktop/claim` | take the oldest queued job (204 when none) |
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

## Cloudflare resources

- Worker `content-factory-dashboard`
- D1 database `content-factory` (jobs table, `migrations/`)
- R2 bucket `content-factory-media` (finished videos under `outputs/<brand>/<job>.mp4`)

`npm run deploy` applies new database migrations, then deploys the Worker.

## Working on it

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev          # http://localhost:8787, with a local database and bucket
npm test             # in a second terminal: end-to-end tests against the dev server
npm run typecheck
```
