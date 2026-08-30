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

## Things that work differently than the Claude Artifact version

- **No automatic odds sync.** The "Odds Sync (every 24h)" scheduled job
  reads and publishes to the *Claude Artifact* URL specifically — it has no
  connection to this Hostinger site and won't update it. Spreads/totals and
  final scores on this deployment will need a different update mechanism
  (for example, a cron job on Hostinger that calls SportsGameOdds directly
  and POSTs the merged result to `api.php?action=save` — ask if you'd like
  this built as a follow-up).
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
