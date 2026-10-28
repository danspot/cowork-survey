# Cowork Quick Pulse

Mobile-first, anonymous 1-5 audience feedback. The numbered circles use the exact
5x7 digit patterns and five accent colors from `cowork-poll.mp4`. The Cowork
mascot and background are exported from the existing local animation artwork.

The static frontend is published to https://danspot.github.io/cowork-survey/.
Supabase's free tier supplies shared storage. An unconfigured deployment
explicitly says the survey is not live; it never pretends to record votes.

## Activate shared voting

1. Create a free project at https://supabase.com/dashboard. Keep the database
   password and all secret/service-role keys private.
2. Run the entire generated `.local\setup.sql` in that project's SQL Editor.
   This creates the restricted schema, three RPC functions, and questions.
3. Copy the project URL and **publishable** key from the project's Connect/API
   settings. A legacy `anon` key also works; admin keys are rejected.
4. Configure the public frontend:

   ```powershell
   npm run configure -- https://PROJECT.supabase.co sb_publishable_YOUR_KEY
   ```

5. Commit and push only `web\config.json`. GitHub Actions republishes `web`.
   Test one question and its separate results link before the session.

The publishable key is intentionally public. It authorizes only the restricted
RPCs; it cannot enumerate questions or read/write tables. Tables live in a
non-exposed schema, have RLS enabled, and grant no access to browser roles.
RPCs use a locked search path. Results tokens are hashed in the database.

Supabase's free plan can pause projects after a week of inactivity. Resume the
project in its dashboard before an event. Pricing: https://supabase.com/pricing.
No paid plan or attendee login is required for this app.

## Private QR sheet and questions

From this directory:

```powershell
npm ci
npm run prepare-survey
```

By default, this reads `..\questions.txt`, with one nonempty question per line,
and creates:

- `..\cowork-survey-qr.html`: self-contained private presenter sheet, with
  mascot-centered QRs, question links, and separate private results links.
- `.local\survey.json`: persistent, independent UUIDs for all URLs.
- `.local\setup.sql`: schema plus question provisioning for the SQL Editor.

An alternate question file, site base URL, and output HTML can be supplied as
three positional arguments to `node tools\prepare.mjs`.

**Keep the HTML and `.local` private.** They are not committed or deployed.
Back them up securely; `.local\survey.json` is the only inventory of results
links. Regeneration preserves URLs **by line position**, so replace a
placeholder's text in place. Do not reorder questions after distributing QRs.
Rerun the generated SQL after editing questions; it preserves existing votes,
updates text, and disables questions removed from the file. The setup script
manages this survey's whole private question set; use a separate Supabase
project for unrelated surveys.

The HTML embeds all artwork and QRs and opens directly from disk. Its print
layout hides private links. Share an individual QR, not the presenter HTML or a
screenshot containing results links. Internet access is needed to vote or read
live results. The QR codes use high error correction, a four-module quiet zone,
and a small white-backed Cowork mascot at their center.

## Access and vote behavior

- Question URLs are `/#/q/<UUID>`; results URLs are `/#/r/<different-UUID>`.
  The root page lists neither. Hash fragments are not sent in Pages requests,
  and the app sends no referrer information.
- A QR is a way to distribute an unlisted link, not authentication. Anyone with
  a question link can answer; anyone with a results link can see that question's
  aggregate counts. Results links must stay private.
- Clicking a number immediately saves a final answer. Postgres enforces one
  immutable answer per question and browser identity, including concurrent or
  retried requests. Refreshing or opening another tab cannot change that answer.
- Browser identity is a random UUID in local storage, not a name or email.
  The database stores a different hash per question. Clearing storage, using a
  different browser, or deliberately making new identities permits another vote.
  This is lightweight audience feedback, not verified one-person voting or
  bot-resistant election software.
- Results show counts, percentages, and the mean, refresh every five seconds,
  pause in background tabs, and retain the last confirmed data on network errors.
- No analytics or external scripts/fonts are loaded. The hosting and database
  providers can still process normal connection/request metadata.

## Local development

```powershell
npm start
npm test
```

Open http://127.0.0.1:4173. The app must be served over HTTP(S), not opened as a
local HTML file. The separate presenter QR sheet does work from disk.

Tests cover actual PostgreSQL behavior using PGlite, browser flows, mobile
layouts, backend failures, immutable votes, private token separation, and
decoding the branded QRs. Browser tests intercept backend calls; they do not
submit fake votes to the production survey. If Chromium is missing, install
it with `npx playwright install chromium`.

GitHub Pages deploys **only `web`**, not the repository root or private outputs.
