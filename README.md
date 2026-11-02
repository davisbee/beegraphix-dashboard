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
| anyone | `POST /api/login`, `POST /api/logout`, `GET /api/me`, `POST /api/me/password`, `POST /api/password-help`, `POST /api/password-reset` | signing in, and "Forgot your password?": emails a one-time link good for an hour (Resend, `RESEND_API_KEY`); without that key, or if the email fails, the request shows on the Team page with a one-click reset |
| staff (signed in, or `SUBMIT_TOKENS`) | `POST /api/jobs` `{campaign, variant, draft?, brand?}` | queue a render |
| | `GET /api/jobs`, `GET /api/jobs/:id` | status |
| | `POST /api/jobs/:id/cancel` | cancel while still queued |
| | `GET /api/jobs/:id/video` | the finished MP4 (seekable; `?download` saves it) |
| | `POST /api/jobs` `{kind: "build", spec, draft?, brand?}` | New video: the desktop builds a campaign from the spec, then renders it |
| | `POST /api/uploads?brand=` `{kind, name, type, size}`, `PUT /api/uploads/:id/part?n=`, `POST /api/uploads/:id/complete` | footage (MP4/MOV, 4 GB) and photos (JPG/PNG/WebP, 25 MB) from the browser, in 20 MB pieces |
| | `POST /api/lookup?brand=` `{url}`, `POST /api/lookup/image?brand=` `{url}` | fill a product from its page (name, style number, photo from schema.org Product data / Open Graph), or save a photo dragged from another page |
| | `POST /api/lookup/style?brand=` `{style}` | fill a product from its style number via the S&S Activewear API (secrets `SS_ACCOUNT`, `SS_API_KEY`) and SanMar Web Services (`SANMAR_CUSTOMER`, `SANMAR_USER`, `SANMAR_PASSWORD`), asked together; supplier websites block page reading |
| | `GET /api/formats` | the video formats (Top 5, Product Spotlight, This vs That, 3 Mistakes, Customer Story, Program Spotlight) and their beats, from `src/formats.ts` |
| | `GET/POST /api/drafts?brand=`, `GET/PUT/DELETE /api/drafts/:id` | New video drafts saved to finish later (`{title, data}`, data is the form); building one deletes its draft |
| | `GET /api/uploads/:id/file` | a product photo, shown as a thumbnail on the New video screen |
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
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: the web OAuth client in the Google Cloud project
  "BeeGraphix Content Factory", for **Connect YouTube**. Its redirect URL is
  `https://contentfactory.shopbgx.com/api/connections/youtube/callback`.
- `CONNECTIONS_KEY`: 32 random bytes, base64. It encrypts the connected accounts' logins in D1. Make one
  without it ever showing on screen:
  `node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put CONNECTIONS_KEY`.
  Changing it means connecting YouTube again.
- `GHL_TOKEN`, `GHL_LOCATION_ID` (optional): the same HighLevel values as the Content Factory `.env`. With
  them, each Short's YouTube video is found from HighLevel's published post. Without them it's matched to
  the channel's uploads by publish time and title.

## YouTube numbers

An admin connects the channel once under the account menu's **Connections** page (Google, read-only:
`youtube.readonly` and `yt-analytics.readonly`). Every morning at 11:00 UTC the Worker's cron reads every
Short on the channel from the last 30 days (`src/youtube.ts`), including ones posted from the Content
Factory's command line. Each is tied to its video job where it can be (HighLevel's published post, the
tracking link in its description, or publish time and title) and listed in `platform_posts`. The numbers
go in `post_stats`, the same table the other platforms use: a `latest` reading that's replaced each day,
plus the `48h` and `7d` readings the Performance tab scores, taken on the first pull after the Short is
that old. Views, likes and comments
are live from the YouTube Data API. Watch time, average view duration, shares and subscribers gained come
from YouTube Analytics, which runs 2 to 3 days behind. **Pull Now** on the Connections page runs it
straight away. Each video's page shows its numbers, and Performance links to every Short ranked by views.

## Weekly report

Performance's **This Week** page (`#/week`, `src/weekly.ts`) shows the last 7 days for the brand picked: each
platform against its Oct 31 starting point (HighLevel's 7 day posts, new followers and reach, plus average views
read so far), the best and weakest scored posts from the last 2 weeks, clicks and leads on tracked links, what's
coming next week, and findings worth a look. A finding is a template, hook, time, day or platform that scored 120
or more, or 80 or less, with at least 3 final 7 day reads, in a group with at least one other to compare.

Every Monday, right after the YouTube pull, the cron emails the BeeGraphix report through Resend to the people in
`WEEKLY_REPORT_TO` (`wrangler.jsonc` vars). An admin can also send it straight away with **Email It Now**.

## Playbook

Each "worth a look" finding on This Week has **Approve** and **Reject** for admins, with one brand picked. Approving
saves a one-line rule (a suggested line the admin can rewrite) and an optional note to the `playbook` table
(migration 0013, `src/playbook.ts`). **Draft It For Me** adds the brand's approved hook rules, and template rules for
the format being drafted, to its prompt for the same goal. Time, day and platform rules are listed for whoever
schedules posts. A decided finding stops showing on This Week. The **Playbook** page lists every rule with its score
then and now; an admin can **Retire** a rule or **Bring Back** a rejected finding so it can be decided again. The
Monday email lists rules approved that week and any whose score has crossed back over 100.

## Cloudflare resources

- Worker `content-factory-dashboard` (the screens are the static files in `public/`)
- D1 database `content-factory` (people, sessions, jobs and the campaign list; `migrations/`)
- R2 bucket `content-factory-media` (finished videos under `outputs/<brand>/<job>.mp4`)

Deploys are automatic: Cloudflare builds and deploys every push to `main` (Workers Builds, deploy
command `npx wrangler deploy`). Preview builds are off because they would share the live database.

That only ships code. A PR that adds a file to `migrations/` also needs
`npx wrangler d1 migrations apply content-factory --remote` run once, before or right after it merges.
`npm run deploy` still does both by hand.

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
