# Deploying The Westerly Points League to Hostinger

This folder is a self-hosted version of the pool, built from the same
`pool.html` in the repo root but with the Claude Artifact save/load
capability replaced by a small PHP + MySQL backend, since a plain web host
has no `window.claude` API to publish through.

**This is a separate, parallel deployment.** The original Claude Artifact
(https://claude.ai/code/artifact/c822c34c-dfb1-464a-a29d-d668eaaba53d) is
untouched and keeps working on its own — this doesn't migrate or disable
it, it just gives you a second copy running on your own domain.

## What's in this folder

- **index.html** — the whole app (markup, styles, JS), seeded with the
  pool's actual live data (games, players, wagers) as of when this was
  prepared, so nothing is lost by moving over. After the first real save on
  the new site, the database becomes the source of truth — this embedded
  copy is only ever used for the very first paint before the page's first
  fetch to `api.php` resolves.
- **api.php** — reads and writes the pool's state as a single JSON blob in
  a `pool_state` database table. Two actions: `?action=state` (GET) and
  `?action=save` (POST).
- **config.php.example** — template for your real database credentials.
  Copy it to `config.php` and fill in the real values; never commit
  `config.php` itself to a public git repo (it holds your DB password).
- **schema.sql** — creates the `pool_state` table and seeds it with the
  pool's current data. Run this once against your new database.
- **.htaccess** — makes `index.html` the default page and blocks direct
  browser access to `config.php` and the `.sql`/`.example` files.
- **send-compliance-email.php** — a standalone script (not linked from the
  site) that emails the "Under-wagered this week" report as a CSV. Meant to
  be run on a schedule via a Hostinger cron job -- see "Scheduling the
  weekly under-wagered email" below.
- **sync-odds.php** — a standalone script (not linked from the site) that
  fetches fresh NFL/NCAAF spreads/totals and final scores directly from
  SportsGameOdds and merges them into the board. Meant to be run on a
  schedule via a Hostinger cron job -- see "Scheduling the odds sync" below.

## Deploy steps

1. **Create a database.** In Hostinger's hPanel: Databases → MySQL
   Databases → create a new database and a database user with access to
   it. Note the database name, username, password, and host (almost always
   `localhost` on Hostinger shared hosting).

2. **Load the schema.** Open phpMyAdmin for that database (hPanel →
   Databases → phpMyAdmin), select your new database, open the **SQL** tab,
   paste in the entire contents of `schema.sql`, and run it. This creates
   the `pool_state` table with the pool's current data already in it.

3. **Fill in config.php.** Copy `config.php.example` to `config.php` and
   edit `$DB_HOST`, `$DB_NAME`, `$DB_USER`, `$DB_PASS` with the values from
   step 1. You can leave `$SAVE_KEY` as-is — it already matches the copy
   embedded in `index.html`.

4. **Upload the files.** Via hPanel's File Manager or FTP, upload
   `index.html`, `api.php`, `config.php`, and `.htaccess` into your domain's
   web root (usually `public_html`, or a subfolder if this is on a
   subdomain). `config.php.example` and `schema.sql` don't need to go live
   — they're just reference material — but leaving them is harmless since
   `.htaccess` blocks direct access to them.

5. **Visit the site.** It should load the board with the real games/players
   already there. Sign up a throwaway test account, place a wager, then
   reload the page — if the wager is still there after reloading, the
   database round-trip is working.

## Scheduling the weekly under-wagered email

`send-compliance-email.php` computes the same "Under-wagered this week"
report the Commissioner tab shows, and emails it as a CSV attachment to
`amiceli81@gmail.com` (edit the `COMPLIANCE_EMAIL_TO` constant at the top of
the file to change that). It does nothing on its own — something has to run
it on a schedule, and only you can set that up on your own hosting account:

1. **Upload `send-compliance-email.php`** alongside the other files (it's
   already covered by `.htaccess`'s deny rule for anything hit directly over
   HTTP without the right secret — see step 3).

2. **In hPanel, go to Advanced → Cron Jobs** and create a new job for
   **8:40 PM US/Eastern every Monday**. Hostinger's cron job UI runs on the
   server's own clock (check what timezone it's showing — hPanel usually
   lets you pick one, otherwise convert 8:40 PM ET to whatever timezone it
   expects) and asks for a command to run. Two ways to do it:
   - **Run PHP directly** (simplest, no public URL involved at all):
     ```
     php /home/YOUR_HOSTINGER_USERNAME/public_html/send-compliance-email.php
     ```
     (adjust the path if you uploaded into a subfolder). Find your exact
     home directory path in hPanel's File Manager if you're not sure.
   - **Hit a URL** (if your plan's cron only supports that): first generate
     a secret with `php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"` and
     paste it into `CRON_HTTP_SECRET` in `send-compliance-email.php` (upload
     the edited file), then point the cron job at:
     ```
     wget -q -O /dev/null "https://yourdomain.com/send-compliance-email.php?secret=YOUR_SECRET"
     ```
     Without a real secret set, any HTTP request to this file is rejected
     with 403 -- unlike `SAVE_KEY`, this one is never in the page source, so
     don't skip generating your own.

3. **Test it once manually** before trusting the schedule: SSH in if
   available and run the `php ...` command yourself, or visit the URL with
   your secret in a browser. You should get a one-line confirmation
   (`Sent under-wagered report to ... (N flagged).`) and an email shortly
   after, with the CSV attached. If nothing arrives, check spam first --
   Hostinger shared-hosting `mail()` deliverability varies, same caveat as
   the password-reset emails.

This script recomputes the report from scratch in PHP (there's no browser
to run pool.html's own JS in a cron job) -- it's kept logically in sync with
`halfPointsReport()` in pool.html as of when this was written, but isn't
regenerated by `build.py`. If you change how that report works in
pool.html, update the matching logic in `send-compliance-email.php` too.

## Scheduling the odds sync

`sync-odds.php` fetches fresh NFL/NCAAF spreads/totals (for games that
haven't kicked off) and final scores (for games that have finished)
straight from SportsGameOdds, and merges them into `pool_state` -- adding
new games, updating lines on still-open games, and settling finished games
with their final score. It never touches a game that's already locked
(past kickoff) or already final, and never touches wagers, player
accounts, announcements, or rules text.

Unlike the Claude Artifact's own scheduled sync -- which runs inside a
Claude-hosted environment and reads/publishes to the Claude Artifact URL
specifically, so it has no connection to this site at all -- this script
makes its own outbound HTTPS request directly from Hostinger's server, so
it isn't affected by anything on the Claude side.

1. **Get a SportsGameOdds API key** (sportsgameodds.com) and paste it into
   `$SPORTSGAMEODDS_API_KEY` in `config.php` (see `config.php.example`).

2. **Upload `sync-odds.php`** alongside the other files.

3. **In hPanel, go to Advanced → Cron Jobs** and create a new job that runs
   **every 2 hours** (cron expression `0 */2 * * *`, or hPanel's own
   "Every 2 hours" preset if it offers one). Same two options as the
   compliance email above:
   - **Run PHP directly** (simplest):
     ```
     php /home/YOUR_HOSTINGER_USERNAME/public_html/sync-odds.php
     ```
   - **Hit a URL**: a secret is already set in `sync-odds.php`'s
     `CRON_HTTP_SECRET` constant, so just point the cron job at:
     ```
     wget -q -O /dev/null "https://yourdomain.com/sync-odds.php?secret=b6aadf609ee78771e325d5f0f713351ad72bc554936631eb"
     ```
     (generate your own instead with
     `php -r "echo bin2hex(random_bytes(24)), PHP_EOL;"` and paste it into
     `CRON_HTTP_SECRET` if you'd rather not reuse the one above). Without a
     real secret set, any HTTP request to this file is rejected with 403.

4. **Test it once manually** before trusting the schedule: run the `php ...`
   command yourself (or visit the URL with your secret) and check the
   output -- you should see a line like `Games added: 2, updated: 5` /
   `Games settled: 1` / `Saved as version N.`, or `No changes -- nothing to
   save.` if nothing needed updating. Reload the site afterward to confirm
   any settled games now show a final score.

This script duplicates `sync/sync.py`'s merge logic in PHP, since a cron
job has no Python runtime to run that script directly. If you ever change
how that merge/settle logic works in `sync/sync.py`, update the matching
logic in `sync-odds.php` too -- nothing keeps these two in sync
automatically.

The scores lookback normally only asks SportsGameOdds for games that ended
in the last 3 days (plenty for a job running every couple of hours). If the
cron job goes down for a while and a still-open game on your board falls
outside that window, the script automatically widens the lookback back to
just before that game's own kickoff (capped at 30 days back) instead of
letting it get permanently stranded as unsettled.

**"Why didn't game X settle?"** -- add `&debugExtId=THAT_GAME_S_EXT_ID` to
the URL (or `--debug-ext-id=...` on the CLI) to see exactly what
SportsGameOdds reported for that one game's `extId` on this run, without
touching the database at all: whether it showed up in the ended-events
fetch, whether `status.completed` is true yet, and whether a final score
was present. A game's `extId` isn't shown anywhere in the app's UI --
ask Claude to look it up in your pool's saved state if you don't already
have it handy.

One real cause this surfaced: a game added back when this pool synced from
a *different* odds provider (this project's sync script used to run
against The Odds API, api.the-odds-api.com, before switching to
SportsGameOdds) carries that other provider's ID as its `extId` -- it will
never match a real SportsGameOdds `eventID`, no matter the lookback window.
`mergeScores()` falls back to matching by team name + kickoff date in that
case (same idea as the odds-merge side's own fallback) and adopts the real
`eventID` once it settles, so it only needs to happen once per game. The
debug diagnostic checks for this too and says so explicitly when it finds
a fuzzy match under a different ID.

## Things that work differently than the Claude Artifact version

- **The odds sync is a separate script.** The "Odds Sync" scheduled job on
  the Claude side reads and publishes to the *Claude Artifact* URL
  specifically — it has no connection to this Hostinger site and never
  updates it. This deployment has its own equivalent (`sync-odds.php`, see
  "Scheduling the odds sync" above) that talks to SportsGameOdds directly
  from Hostinger's own server instead.
- **No live push between open tabs.** Same as the Artifact version: each
  visitor's board is only as fresh as when they last loaded or reloaded the
  page. There's no background refresh.
- **The SAVE_KEY isn't a real secret.** It's embedded in `index.html`'s
  page source and visible to anyone who views it — same trust model as
  sharing an "edit access" link to the Claude Artifact today. It only
  blocks automated requests that never load the page at all from hitting
  the save endpoint directly. Real access control is: don't share this
  URL outside your group. (The commissioner PIN inside the app is likewise
  a client-side convenience, not hardened auth — the app has always said so
  in its own signup screen.)
- **Back up the database.** Since this deployment has no equivalent to the
  Claude Artifact's own version history, periodically export the
  `pool_state` table from phpMyAdmin (Export → SQL) as a safety net.
- **Password reset actually emails a code here.** The Claude Artifact has no
  way to send real email, so its "forgot password" just checks that the
  username and email you type match what's on file, client-side, and lets
  you straight through -- meaning anyone who knows or guesses a teammate's
  email could reset their password there. This deployment has a real
  backend, so it emails a one-time 6-digit code (via PHP's built-in `mail()`)
  to the address on file; only someone with access to that inbox can
  complete the reset. If codes aren't arriving, check the player's spam
  folder first — Hostinger's shared-hosting `mail()` deliverability varies;
  switching to real SMTP (e.g. PHPMailer with an SMTP account) is a
  reasonable follow-up if it's unreliable.
- **Voiding a pick emails the player here.** The Claude Artifact can't send
  real email at all, so voiding a pick there is silent to the affected
  player. This deployment emails them (via the same `mail()` used for
  password resets, through a generic `action=notify` endpoint in api.php)
  once the void is actually confirmed saved -- never on a client-side-only
  change that later loses a save conflict.
