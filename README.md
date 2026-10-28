# PPCC 2026 | Cowork Ate My Agents

Mobile-first, anonymous rating and multiple-choice audience feedback. The numbered circles use the exact
5x7 digit patterns and five accent colors from `cowork-poll.mp4`. The Cowork
mascot and background are exported from the existing local animation artwork.

The static frontend is published to https://danspot.github.io/cowork-survey/.
Supabase's free tier supplies shared storage. An unconfigured deployment
explicitly says the survey is not live; it never pretends to record votes.

## Activate shared voting

1. Create a free project at https://supabase.com/dashboard. Keep the database
   password and all secret/service-role keys private.
2. Run the entire generated `.local\setup.sql` in that project's SQL Editor.
   This creates the restricted schema, four RPC functions, and questions.
3. Copy the project URL and **publishable** key from the project's Connect/API
   settings. A legacy `anon` key also works; admin keys are rejected.
4. Configure the public frontend:

   ```powershell
   npm run configure -- https://PROJECT.supabase.co sb_publishable_YOUR_KEY
   ```

5. Run `npm run prepare-survey` again to include the public configuration in
   the local control page. Commit and push only `web\config.json`. GitHub Actions republishes `web`.
   Test one question and its separate results link before the session.

The publishable key is intentionally public. It authorizes only the restricted
RPCs; it cannot enumerate questions or read/write tables. Tables live in a
non-exposed schema, have RLS enabled, and grant no access to browser roles.
RPCs use a locked search path. Results tokens are hashed in the database.

When updating an existing deployment, rerun `supabase\schema.sql` in the SQL
Editor to migrate the existing tables and RPCs. Existing rating answers remain
intact, and the updated frontend also supports the previous rating-only RPCs.
For changed question definitions, regenerate and run the entire `.local\setup.sql`
instead; it includes both the migration and question provisioning.

Supabase's free plan can pause projects after a week of inactivity. Resume the
project in its dashboard before an event. Pricing: https://supabase.com/pricing.
No paid plan or attendee login is required for this app.

## Private QR sheet and questions

From this directory:

```powershell
npm ci
npm run prepare-survey
```

By default, this reads `..\questions.txt`, with one nonempty question per line:

```text
How useful was this session?
Which tools would you use? | Cowork | Agents | Both | Not sure
```

A plain question uses the original 1-2-3-4-5 rating buttons, with AI-themed
captions beneath each number, from **Least: still buffering** to **Most: full send**.
A question followed by at least two pipe-delimited options uses multi-select checkboxes and a
**Save answer** button. Options are trimmed and must be distinct and nonempty;
`|` is reserved as the separator. Each whole line can contain up to 2,000
characters. Blank lines are ignored, and invalid lines stop generation with
their line number.

The generator creates:

- `..\cowork-survey-qr.html`: private control page, with mascot-centered QRs,
  inline results, per-question refresh buttons, and question/results links.
- `.local\survey.json`: persistent, independent UUIDs for all URLs.
- `.local\setup.sql`: schema plus question provisioning for the SQL Editor.

An alternate question file, site base URL, and output HTML can be supplied as
three positional arguments to `node tools\prepare.mjs`.

**Keep the HTML and `.local` private.** They are not committed or deployed.
Back them up securely; `.local\survey.json` is the only inventory of results
links. Regeneration preserves URLs **by line position**, so replace a
placeholder's text in place. Do not reorder questions after distributing QRs.
Rerun the generated SQL after editing questions; it preserves existing votes
when the type and options are unchanged, updates text, and disables questions
removed from the file. Changing a question's type or its option list (including
order or wording) clears **only that question's** previous responses, so old
answers are never relabeled as different choices. URLs remain unchanged. The setup script
manages this survey's whole private question set; use a separate Supabase
project for unrelated surveys.

The HTML embeds all artwork and QRs and opens directly from disk. The three
question rows, including results, fit on one laptop screen. Results load on
opening the file; **Refresh results** reloads only that question. Counts,
percentages, a rating average or total selections, and the last-updated time appear inline, without an
iframe or tab switch. Failed refreshes keep the last confirmed data visible.
The page embeds only the browser-safe Supabase configuration and calls the
same restricted results RPC as the public site. Supabase permits these
requests from a local file; results require internet access.

The print layout hides results, private links, and controls. Each **Copy QR image** button
copies that question's high-resolution PNG, including the center mascot, for
pasting into slides or messages. Open the file in Microsoft Edge or Chrome,
and allow clipboard access if prompted. Copying works offline.
Share an individual QR, not the presenter HTML or a
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
- Clicking a number immediately saves that answer. Another selection replaces
  the same browser's previous answer, including after a reload or in another
  tab. Postgres keeps one response per question and browser identity, so
  changes and retries update the distribution without increasing the count.
  The clicked number animates unless reduced motion is enabled.
- Multiple-choice respondents select one or more options, then click **Save answer**.
  Changes replace their previous selection set, not just add to it. An empty
  selection cannot be submitted. Reloading restores the confirmed selections.
- Browser identity is a random UUID in local storage, not a name or email.
  The database stores a different hash per question. Clearing storage, using a
  different browser, or deliberately making new identities permits another vote.
  This is lightweight audience feedback, not verified one-person voting or
  bot-resistant election software.
- Rating results show counts, percentages, and the mean. Multiple-choice
  results show respondents, total selections, and counts per option, without
  an average. Each option's percentage uses **respondents**, not total
  selections, as the denominator, so percentages can sum to more than 100%.
  Standalone results refresh every five seconds,
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
layouts, backend failures, answer changes, button animation, private token separation, and
decoding the branded QRs. Browser tests intercept backend calls; they do not
submit fake votes to the production survey. If Chromium is missing, install
it with `npx playwright install chromium`.

GitHub Pages deploys **only `web`**, not the repository root or private outputs.
