# The Westerly Points League — project files

A points-only (not real money) NFL/NCAAF pick-'em pool, live as a published
Claude Artifact:
https://claude.ai/code/artifact/c822c34c-dfb1-464a-a29d-d668eaaba53d

That link is persistent — it doesn't depend on any particular conversation or
on these files. This folder is a backup of the underlying code: use it to see
how the app works, hand it to someone else, or rebuild it elsewhere.

## Files

- **pool.html** — the entire app (markup, styles, and JavaScript in one
  file). This is a fragment, not a standalone page: it's meant to be
  published through Claude's Artifact tool, which wraps it with a
  `<!doctype html>` shell at publish time. Opening it directly in a browser
  works for reading the code, but live saving (picks, admin changes) only
  works when it's actually served as the published artifact, since that's
  what provides the `window.claude` save API the page calls.

  State (games, wagers, players, announcements, rules text, balance
  adjustments, settings) lives entirely in the `<script id="state-data"
  type="application/json">` tag near the top of the body — that's the whole
  database for the pool, embedded right in the page.

- **sync/sync.py** — merges fresh NFL/NCAAF spreads and totals (and final
  scores, for settling finished games) into the page's state, from the
  SportsGameOdds API (api.sportsgameodds.com). Meant for a one-off/manual
  sync where an agent fetches each sport's raw API response with a
  WebFetch-capable tool and saves it locally first — this script never
  calls the network itself, since this environment's policy blocks direct
  outbound calls to the API. See the module docstring for the exact fetch
  URLs and usage.

- **sync/scheduled_sync.py** — the version of the sync used by the
  recurring automated job (see "Odds sync" below). Functionally the same
  merge logic as sync.py, but consumes a smaller, pre-simplified JSON shape
  per event (rather than the full SportsGameOdds envelope), because asking
  a WebFetch-capable tool to hand back that smaller shape verbatim is far
  more reliable than asking it to return the full raw API response, which
  tends to get paraphrased or summarized. See its module docstring for the
  expected input shape.

- **tests/** — a Playwright regression suite (21 files) covering: duplicate
  pick prevention, the under-wagered compliance report, the email/mailto
  composer, week-level pick locking (including a stale-page race where a
  form rendered just before lock still tries to submit), hiding upcoming
  weeks until their dates arrive, viewing another player's picks once a
  game locks, the collapsible admin games list, commissioner balance
  adjustments, hiding locked games from the This Week tab by default, the
  Rules tab (including its PIN gate), self-service password reset, the
  minimum-wager enforcement and a weekly wager budget (a player's combined
  wagers across every game in a week can't exceed the balance they started
  that week with), voiding a pick (with the actual side/pick hidden from
  the commissioner's view, and a placed-at timestamp on every pick), the
  collapsible (default-collapsed) Void a Pick list, booting a player's
  account (and their wagers), per-player paid/buy-back/pay-type tracking
  (in the Boot a Player card), the void-picks player filter, the This Week
  sport filter, and rejecting a duplicate team
  name at signup.
  Each test drives a full in-memory copy of
  the app in a headless browser — none of them touch the live artifact.
  `tests/build_test_full.py` wraps `pool.html` in a minimal `<html>` shell
  so it can be opened directly by a browser for testing; run it once before
  running the tests, and again after any change to `pool.html`.

  To run the full suite (needs Node + Playwright, and a Chromium binary —
  see `executablePath` near the top of each test file if yours lives
  somewhere other than `/opt/pw-browsers/chromium`):

  ```
  python3 tests/build_test_full.py
  for f in tests/test_*.js; do node "$f"; done
  ```

## Accounts

- **Forgot password?** on the Log in form lets a player reset their own
  password: enter the username and the email on file for it, and if they
  match you go straight to setting a new password. There's no backend on
  this page, so no email is actually sent — it's a same-page check, not a
  mailed reset link. Anyone who knows a player's username and email can
  reset that player's password this way; that's an accepted tradeoff given
  the pool already isn't real account security (see the signup hint text).

## Commissioner basics

- Default PIN is `1234` — change it in the Commissioner tab's Pool Settings.
- Everyone starts at 1000 points; a win adds the wagered points, a loss
  subtracts them, a push is a wash. Balances and win/loss records aggregate
  across every week automatically — there's no per-week reset.
- Every wager needs at least 100 points — a player who tries to submit less
  gets a popup ("You must wager at least 100 points.") and nothing saves.
- Share the artifact with **edit access** (share menu on the page) for
  anyone who should be able to sign up and submit their own picks —
  read-only viewers can watch the board but not wager.
- The **Week visibility** tool (Commissioner tab) lets you Show, Hide, or
  leave on Auto (the default — current week by kickoff date) whichever
  week's games appear on the This Week tab, independent of the calendar.
- The This Week tab has an **All / NFL / NCAAF** filter next to the "Show
  locked games" toggle, for anyone who only wants to see one sport at a time.
- The **Rules** tab is a plain-text box anyone can read; only the
  commissioner can edit and save it.
- The **Void a pick** tool (Commissioner tab) lets you remove any single
  wager outright — a wrong pick, a rule violation, a mix-up, whatever. A
  player filter dropdown narrows the list to one team at a time. Balance
  and win/loss records recompute automatically once it's gone; this can't
  be undone.
- The **Under-wagered this week** report compares each player's wagers
  against half of the balance they had at the *start* of the current week
  — a game that already went final mid-week doesn't retroactively move the
  bar. Click the **Status** column header to flip it between most-short-first
  (the default) and least-short-first.

## Odds sync

Two ways to keep spreads/totals and final scores current:

1. **Manual** — ask Claude to run a one-off sync using `sync/sync.py`
   against fresh SportsGameOdds data.
2. **Automatic, every 4 hours** — a scheduled task reads the live artifact,
   fetches fresh odds/scores, merges them with `sync/scheduled_sync.py`, and
   republishes, without ever touching wagers, player accounts, or a
   game that's already locked or final. It also never force-overwrites: if
   the live pool has newer activity (a pick, signup, admin edit) since its
   last run, it skips publishing that cycle rather than risk clobbering it.

   This requires `*.frame.claudeusercontent.com` to be allowed in this
   Claude environment's network settings (Code → Network access → Custom →
   Allowed domains) so the scheduled job can read the artifact's current
   state before merging — without that, it safely does nothing each time it
   fires. The SportsGameOdds free tier caps out at 2,500 "objects" and 10
   requests/minute per month, worth keeping in mind if you raise the sync
   frequency.
