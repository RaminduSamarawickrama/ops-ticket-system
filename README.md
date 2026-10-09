# Operations Support Portal

A small, self-contained ticket system for an operations team.

- **Anyone** can raise a ticket at `/` without an account. They choose P1/P2/P3, describe the incident, attach screenshots, and get a reference such as `OPS-2026-00001`.
- **The operations team** gets an email for every new ticket. P1 emails are visually prominent.
- **Administrators** sign in at `/admin/login`, then search and filter tickets, view screenshots, and move tickets through Open → Working → Done.
- **Reporters** get a confirmation email when they submit and a resolution email when their ticket is marked Done.

It runs on Vercel as a React (Vite) single-page app plus **one** serverless function (`api/index.ts`), with three free-tier external services.

---

## Architecture

```
Browser ──► Vercel (static React app)
        └─► /api/*  ──► one Vercel Function (Node.js) ──┬─► Neon Postgres      tickets, admins, sessions, history
                                                        ├─► Vercel Blob        screenshots (PRIVATE store)
                                                        └─► Resend             transactional email
```

| Need | Service | Why it is external | Free tier (checked October 2026) |
|---|---|---|---|
| Hosting, API | **Vercel** (Hobby) | — | 1M function invocations, 4 h active CPU, 100 GB transfer per month |
| Database | **Neon Postgres** (Free) | Vercel has no built-in database, and function memory and disk are temporary | 1 GB storage and 100 compute-hours per project; no card required; sleeps after 5 min idle (first request after that is slower) |
| Screenshots | **Vercel Blob**, private store | Function disk is temporary; a private store needs credentials to read | 1 GB storage, 2,000 uploads and 10 GB transfer per month on Hobby. If exceeded, Blob is **blocked** for the rest of the 30 days. You are never charged. |
| Email | **Resend** (Free) | Vercel cannot send email itself | 100 emails/day, 3,000/month, up to 3 verified domains; no card required |

Each new ticket uses 2 emails and each resolution uses 1, so the free Resend tier covers roughly **30–40 tickets a day**.

### ⚠️ Licensing limitation: Vercel Hobby is non-commercial

Vercel's fair-use guidelines restrict the Hobby plan to **non-commercial personal use**. Vercel counts any deployment as commercial if anyone involved is paid, including a paid employee writing the code. If this portal is used inside a business, the strict reading is that it needs **Vercel Pro**.

The code is deliberately portable. The only Vercel-specific parts are `api/index.ts` (a standard `fetch(Request) → Response` handler) and `server/storage.ts` (Vercel Blob). To move to a host whose free tier allows commercial use, swap those two pieces.

### Design decisions

- **One function, internal router** (`server/app.ts`). `vercel.json` rewrites `/api/*` to it. This means one cold start, and the same handler runs locally and in tests.
- **Plain SQL with `pg`.** No ORM. Schema lives in `migrations/*.sql`.
- **Ticket references** come from a per-year counter row that is updated atomically (`INSERT … ON CONFLICT DO UPDATE … RETURNING`) inside the ticket transaction. Concurrent submissions cannot get the same number, and `tickets.reference` is also `UNIQUE`.
- **Double-submit protection.** The form sends a random `submissionId`; a repeat of the same submission returns the existing ticket.
- **Emails never block saving.** The ticket or status change is committed first. Each email is a row in `notifications` with status `PENDING → SENT / FAILED / SKIPPED`.
  - `SENT` means the provider **accepted** the message; it does not prove inbox delivery, and the UI says so.
  - Failed emails are shown on the dashboard and can be retried from the ticket page.
- **No duplicate resolution emails.** Saving the same status is a no-op. Each move to Done increments `resolution_count`, and `notifications` has `UNIQUE (ticket_id, kind, cycle)`. Reopening and resolving again therefore sends exactly one new email. Concurrent "Done" clicks are serialized with `SELECT … FOR UPDATE`.
- **Screenshot uploads.** Vercel Functions accept at most 4.5 MB per request, so the browser shrinks large screenshots (max 2000 px, WebP/JPEG) before upload.
  - Limits: 5 files, 3 MB each, 4 MB total.
  - The server checks file type from the **file bytes** (PNG/JPEG/WebP magic numbers), not from the name or browser-reported type.
  - Storage keys are random UUIDs; the original filename is kept for display only.

### Security summary

| Area | What is in place |
|---|---|
| Passwords | bcrypt (cost 12). No public registration; admins are created with a CLI script. |
| Sessions | Random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` in production). Only its SHA-256 hash is stored in the database. Sessions expire after 12 h (configurable). Logout deletes the session. |
| Authorization | Every `/api/admin/*` handler checks the session on the server. Screenshots are streamed through an authenticated route with `Cache-Control: private, no-store`; there are no public blob URLs. |
| CSRF | `SameSite=Lax` cookies, JSON-only bodies for admin actions, and an Origin check on all state-changing requests. |
| Rate limits | Stored in Postgres, keyed by a hash so raw IPs are never stored. 10 submissions/hour per IP; 20 login attempts/15 min per IP; 5 failed logins/15 min per username, which locks that username for 15 minutes. |
| Injection / XSS | Parameterized SQL everywhere, including LIKE-escaped search. React escapes output. User text is HTML-escaped in emails, and line breaks are stripped from email subjects. A strict Content-Security-Policy and other security headers are set in `vercel.json`. |
| Errors | Clients get generic messages; details go to server logs only. |
| Public API | Only `POST /api/tickets` and `GET /api/health`. There is no public way to list or read tickets. |

---

## Local development

Requirements: Node.js 20+ and a Postgres database. That can be a free Neon database, or a local Postgres for development.

```bash
npm install
cp .env.example .env.local      # then edit it
```

For a fully offline setup, use a local Postgres and these values in `.env.local`:

```bash
DATABASE_URL=postgres://postgres@127.0.0.1:5432/ops_dev?sslmode=disable
OPERATIONS_NOTIFICATION_EMAIL=ops@example.com
EMAIL_FROM=Ops Portal <portal@example.com>
EMAIL_DRY_RUN=true        # emails are printed in the terminal
STORAGE_DRIVER=local      # screenshots go to ./.local-storage (dev only; refused in production)
APP_BASE_URL=http://localhost:5173
```

Then:

```bash
npm run db:migrate        # create tables
npm run admin:create      # prompts for a username and password (min 12 characters)
npm run dev               # web on http://localhost:5173, API on :3001 (proxied)
```

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server plus the local API |
| `npm test` | Unit and integration tests (needs Postgres, see below) |
| `npm run typecheck` | TypeScript checks for the app and the server |
| `npm run build` | Type-check and production build into `dist/` |
| `npm run db:migrate` | Apply pending migrations |
| `npm run admin:create` | Create an administrator |
| `npm run admin:reset-password` | Set a new password; signs that admin out everywhere |

### Tests

The integration tests run the real API handler against a real Postgres database, with fake email and in-memory storage. **The test database is wiped on every run.** Point the tests at a throwaway database:

```bash
createdb ops_test
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/ops_test?sslmode=disable npm test
```

They cover:
- validation
- file-type sniffing
- concurrent reference generation
- duplicate submissions
- authorization on every admin endpoint
- login lockout, session expiry and CSRF blocking
- search, filter and sort
- the status lifecycle and resolution emails, including concurrent Done clicks
- email-failure handling and retry
- the missing-configuration warning

---

## Deploying to Vercel

### 1. Create the accounts (all free, no card needed)

1. **Vercel**: https://vercel.com (sign in with GitHub).
2. **Resend**: https://resend.com.
3. **Neon**: you can add it from inside Vercel in step 3, so no separate sign-up is needed.

### 2. Import the project

In Vercel, choose **Add New → Project**, import this GitHub repository, and keep the detected settings. `vercel.json` already sets the build command, output directory and rewrites.

The first deploy works without a database, but the API answers `503` until step 3 is done.

### 3. Database: Neon

1. In the project, open **Storage → Create Database → Neon** (Marketplace) and choose the **Free** plan.
2. Connect it to the project for **Production** and **Preview**. This adds `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`.

You can also create the database at https://neon.tech and paste the **pooled** connection string as `DATABASE_URL`.

Migrations run automatically on every deploy (`npm run vercel-build` runs `scripts/migrate.ts` before building). Migrations only add to the schema and run inside a lock, so this is safe. Preview deployments migrate whichever database their environment points at.

### 4. Screenshots: private Vercel Blob store

1. Open **Storage → Create Database → Blob**, and set **Access: Private**. This matters: a public store would make screenshots readable by URL.
2. Connect it to the project. Vercel adds the store credentials, and the app authenticates automatically.

### 5. Email: Resend

1. In Resend, **add and verify a domain** you control by adding the DNS records it shows.
   - Without a verified domain, Resend's test sender only delivers to your own Resend account address. Reporters would not receive emails.
2. Create an API key with **Sending access**.

### 6. Environment variables

Set these in **Project → Settings → Environment Variables** for Production (and Preview if you test there):

| Variable | Required | Example / notes |
|---|---|---|
| `DATABASE_URL` | yes | Set by the Neon integration (pooled URL) |
| `DATABASE_URL_UNPOOLED` | recommended | Set by the Neon integration; used for migrations |
| `EMAIL_PROVIDER_API_KEY` | yes | Resend API key `re_…` |
| `EMAIL_FROM` | yes | `Operations Support <support@yourdomain.com>` (verified domain) |
| `OPERATIONS_NOTIFICATION_EMAIL` | yes | `operations@yourdomain.com` or a comma-separated list |
| `APP_BASE_URL` | recommended | `https://your-project.vercel.app`. Used for the dashboard link in ops emails; defaults to the production domain. |
| `APP_TIMEZONE` | optional | `Asia/Colombo`. Time zone for timestamps in emails; default `UTC`. |
| `SESSION_TTL_HOURS` | optional | Admin session length; default `12` |
| Blob credentials | yes | Added automatically when you connect the private Blob store |

If the operations email, sender or API key is missing or invalid, tickets are still saved. Admins see a configuration warning on the dashboard, and the affected emails show as "Not sent" with a Retry button. After fixing the variables, **redeploy** so the function picks them up, then press Retry.

Redeploy after adding variables: **Deployments → … → Redeploy**.

### 7. Create the first administrator

Run this from your machine against the production database. Use the Neon connection string from the Vercel or Neon dashboard:

```bash
DATABASE_URL='postgres://…' npm run admin:create
```

Or pull the variables first:

```bash
npx vercel link
npx vercel env pull .env.local
npm run admin:create
```

### 8. Check it

1. Open the site and submit a P3 test ticket. Confirm both emails arrive.
2. Sign in at `/admin/login` and open the ticket.
3. Mark it Done and confirm the resolution email arrives.

Use a Vercel **Preview** deployment (any branch other than `main`) to try changes first.

---

## Project layout

```
api/index.ts            Vercel Function entry (all /api routes)
server/app.ts           Router and request handlers
server/tickets.ts       Ticket creation, listing, status changes
server/notifications.ts Email queueing, sending, retry
server/emailTemplates.ts HTML and text emails
server/auth.ts          Passwords, sessions, admin checks
server/rateLimit.ts     Postgres-backed rate limiting
server/storage.ts       Private Vercel Blob (+ test and local-dev drivers)
server/config.ts        Environment configuration and admin warnings
shared/                 Constants and validation shared by browser and server
migrations/             SQL schema
scripts/                Dev server, migrations, admin CLI
src/                    React app (public form, admin login, dashboard, ticket page)
tests/                  Vitest unit and integration tests
```

## Limits and known trade-offs

- **Screenshots:** at most 5 per ticket, after automatic resizing in the browser. Very large images from browsers without canvas support may be refused.
- **Login lockout:** 5 wrong passwords lock that username for 15 minutes. Someone guessing could keep an admin locked out; use a username that isn't obvious.
- **Email retry is manual** (a button per failed email). There is no background queue, to stay within free tiers and keep the system simple.
- **Incident time zone:** incident date and time are stored exactly as the reporter entered them, without time zone conversion. Submission and resolution timestamps are real UTC instants.
