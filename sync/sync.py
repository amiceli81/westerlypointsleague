#!/usr/bin/env python3
"""
Merge NFL + NCAAF spreads/totals into The Westerly Points League artifact's
state, using the SportsGameOdds API (api.sportsgameodds.com) as the odds
source. This replaced an earlier version of this script built against The
Odds API (api.the-odds-api.com) -- the artifact's internal game/wager data
shape didn't change, only how odds get fetched and parsed.

This machine's network policy blocks direct outbound calls to
api.sportsgameodds.com (and to the published artifact's own read endpoint),
so fetching is NOT done here with urllib. Instead: the calling agent fetches
each sport's events via the WebFetch tool (which reaches the API through a
different network path) and saves the raw JSON response to a local file;
this script only reads those local files and does the pure-data merge.

Fetching (for whoever/whatever runs a sync):
  Odds/lines (upcoming games), one call per sport, using each sport's
  leagueID (NFL, NCAAF) and sportID=FOOTBALL:
    https://api.sportsgameodds.com/v2/events
      ?apiKey=YOUR_KEY&leagueID=NFL&oddsAvailable=true&started=false&limit=100
    https://api.sportsgameodds.com/v2/events
      ?apiKey=YOUR_KEY&leagueID=NCAAF&oddsAvailable=true&started=false&limit=100

  Scores (for settling games that have finished), one call per sport, asking
  for events that have started/ended instead:
    https://api.sportsgameodds.com/v2/events
      ?apiKey=YOUR_KEY&leagueID=NFL&ended=true&startsAfter=<3 days ago>&limit=100
    https://api.sportsgameodds.com/v2/events
      ?apiKey=YOUR_KEY&leagueID=NCAAF&ended=true&startsAfter=<3 days ago>&limit=100

  Each response is the SportsGameOdds envelope {"success":true,"data":[...],
  "nextCursor":...} -- save the raw body as-is to a local file; this script
  unwraps the "data" list itself.

Usage:
  # Update lines/add new games:
  python3 sync.py --nfl-file nfl_events.json --ncaaf-file ncaaf_events.json \
      --current-html current.html --out merged_fragment.html

  # Settle finished games (can be combined with the odds args above in one run):
  python3 sync.py --nfl-scores-file nfl_ended.json --ncaaf-scores-file ncaaf_ended.json \
      --current-html current.html --out merged_fragment.html

Design notes:
- Only ADDS new games or UPDATES lines on games that are still open and not
  past kickoff. Never touches a game that is status=final or whose kickoff
  has passed (even if not yet marked final) -- and never touches wagers.
- Matches games across runs by a stable "extId" (SportsGameOdds' eventID), so
  re-running never creates duplicates.
- NCAAF is filtered to a "top programs" list (Power 4 + Notre Dame + a
  handful of others) so the board isn't flooded with 100+ games a week. Team
  names are matched against SportsGameOdds' teams.<home|away>.names.long
  field; if that API formats a program's name differently than the list
  below expects, that game is simply excluded rather than crashing -- worth
  spot-checking the first real sync's "normalized after filtering" count.
- If a fetched file is an API error body (e.g. bad key, quota exhausted) or
  isn't the expected {"data":[...]} envelope, that sport is skipped for this
  run instead of crashing.
- Also settles games automatically: pass --nfl-scores-file/--ncaaf-scores-file
  with the agent's WebFetch dump of each sport's ended/completed events, and
  any event SportsGameOdds reports status.completed=true gets status="final"
  plus its two final scores written in (read off the final value of its own
  point-spread odds, the only place this API surfaces a plain final score --
  see extract_final_scores()). Wagers on it settle themselves the instant the
  page sees status="final" -- there's no separate grading step. A game with
  no matching extId, already final, or without two parseable scores is left
  alone.
"""
import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone

SPORTS = {
    "NFL": "NFL",
    "NCAAF": "NCAAF",
}
FOOTBALL_SPORT_ID = "FOOTBALL"

# oddID components, per SportsGameOdds' {statID}-{statEntityID}-{periodID}-
# {betTypeID}-{sideID} scheme (docs: sportsgameodds.com/docs/data-types/odds).
ODD_HOME_SPREAD = "points-home-game-sp-home"
ODD_AWAY_SPREAD = "points-away-game-sp-away"
ODD_TOTAL_OVER = "points-all-game-ou-over"
ODD_TOTAL_UNDER = "points-all-game-ou-under"

# Both the "School Mascot" form AND the bare school name are listed for each
# program -- a live sync against SportsGameOdds showed its teams.*.names.long
# field is inconsistent about including the mascot (e.g. "Rutgers" and "Wake
# Forest" come back bare, while others may include it), and this filter is an
# exact-match set, not a substring check, specifically so a bare name like
# "Arkansas" can be whitelisted here without also matching an unrelated team
# whose name merely contains that substring (e.g. "Arkansas-Pine Bluff").
NCAAF_TOP_PROGRAMS = {
    "Georgia Bulldogs","Georgia","Texas Longhorns","Texas","Ohio State Buckeyes","Ohio State",
    "Michigan Wolverines","Michigan","Alabama Crimson Tide","Alabama","LSU Tigers","LSU",
    "Oregon Ducks","Oregon","Penn State Nittany Lions","Penn State",
    "Notre Dame Fighting Irish","Notre Dame","Clemson Tigers","Clemson",
    "Florida State Seminoles","Florida State","Miami Hurricanes","Miami","Miami (FL)",
    "Texas A&M Aggies","Texas A&M","Oklahoma Sooners","Oklahoma","Tennessee Volunteers","Tennessee",
    "USC Trojans","USC","Washington Huskies","Washington","Wisconsin Badgers","Wisconsin",
    "Iowa Hawkeyes","Iowa","Utah Utes","Utah",
    "Kansas State Wildcats","Kansas State","Baylor Bears","Baylor","TCU Horned Frogs","TCU",
    "Ole Miss Rebels","Ole Miss","Auburn Tigers","Auburn","South Carolina Gamecocks","South Carolina",
    "Missouri Tigers","Missouri","North Carolina Tar Heels","North Carolina",
    "NC State Wolfpack","NC State","NC State Wolfpack Football","North Carolina State",
    "Virginia Tech Hokies","Virginia Tech","Louisville Cardinals","Louisville",
    "Pittsburgh Panthers","Pittsburgh","Pitt","Michigan State Spartans","Michigan State",
    "Nebraska Cornhuskers","Nebraska","Illinois Fighting Illini","Illinois",
    "Minnesota Golden Gophers","Minnesota","Arizona State Sun Devils","Arizona State",
    "Arizona Wildcats","Arizona","UCLA Bruins","UCLA","Colorado Buffaloes","Colorado",
    "BYU Cougars","BYU","Oklahoma State Cowboys","Oklahoma State",
    "Texas Tech Red Raiders","Texas Tech","West Virginia Mountaineers","West Virginia",
    "Kansas Jayhawks","Kansas","Cincinnati Bearcats","Cincinnati","Houston Cougars","Houston",
    "UCF Knights","UCF","Duke Blue Devils","Duke","Georgia Tech Yellow Jackets","Georgia Tech",
    "Vanderbilt Commodores","Vanderbilt","Kentucky Wildcats","Kentucky",
    "Arkansas Razorbacks","Arkansas","Mississippi State Bulldogs","Mississippi State",
    "Rutgers Scarlet Knights","Rutgers","Maryland Terrapins","Maryland",
    "Indiana Hoosiers","Indiana","Purdue Boilermakers","Purdue","Northwestern Wildcats","Northwestern",
    "Boston College Eagles","Boston College","Wake Forest Demon Deacons","Wake Forest",
    "Syracuse Orange","Syracuse","Stanford Cardinal","Stanford",
    "California Golden Bears","California","Cal","SMU Mustangs","SMU",
}


def week_tuesday_start(iso_time):
    # Football weeks run Tuesday-through-Monday (Thu/Fri/Sat/Sun/Mon games all
    # belong together), bucketed by US Eastern calendar day so a Sunday/Monday
    # night kickoff -- which is already past midnight UTC -- doesn't get
    # shuffled into the following week. Returns just the Tuesday date (used
    # both to number weeks sequentially per sport and, if ever needed, to
    # label a date range).
    dt = datetime.fromisoformat(iso_time.replace("Z", "+00:00"))
    try:
        from zoneinfo import ZoneInfo
        dt = dt.astimezone(ZoneInfo("America/New_York"))
    except Exception:
        pass
    dt = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    return dt - timedelta(days=(dt.weekday() - 1) % 7)


def assign_week_numbers(games, sport_label):
    """Number a sport's weeks sequentially ('Week 1', 'Week 2', ...) anchored
    to the EARLIEST kickoff across every game of that sport currently known
    (existing + newly merged) -- not to the calendar or a hardcoded season
    date -- so numbering stays stable across runs regardless of when the
    real season happens to start. Applies to every game of the sport,
    including already-locked/final ones, since it only changes a display
    label, never scores, spreads, or wagers."""
    sport_games = [g for g in games if g.get("sport") == sport_label and g.get("kickoff")]
    if not sport_games:
        return
    anchor = min(week_tuesday_start(g["kickoff"]) for g in sport_games)
    for g in sport_games:
        n = round((week_tuesday_start(g["kickoff"]) - anchor).days / 7) + 1
        g["week"] = "Week {}".format(n)


def _team_name(team_obj):
    # teams.<home|away> looks like {"teamID": "...", "names": {"long":,
    # "medium":, "short":}}. Prefer the fullest name; fall back gracefully.
    if not isinstance(team_obj, dict):
        return None
    names = team_obj.get("names") or {}
    return names.get("long") or names.get("medium") or names.get("short") or team_obj.get("teamID")


def _odd_num(odd_obj, *keys):
    # SportsGameOdds documents ALL odds values (spreads, totals, scores) as
    # STRINGS, not numbers -- so every read here goes through float() rather
    # than assuming a numeric JSON type. Tries each key in order and returns
    # the first that parses; None if the odd is missing or unparseable.
    if not isinstance(odd_obj, dict):
        return None
    for key in keys:
        v = odd_obj.get(key)
        if v is None:
            continue
        try:
            return float(v)
        except (TypeError, ValueError):
            continue
    return None


def normalize_event(event, sport_label):
    teams = event.get("teams") or {}
    home_name = _team_name(teams.get("home"))
    away_name = _team_name(teams.get("away"))
    if not home_name or not away_name:
        return None

    status = event.get("status") or {}
    kickoff = status.get("startsAt")
    if not kickoff:
        return None

    odds = event.get("odds") or {}
    home_spread = _odd_num(odds.get(ODD_HOME_SPREAD), "bookSpread", "fairSpread")
    if home_spread is None:
        # The two sides of a spread market mirror each other, so the away
        # side's line is an equally valid source if the home entry is absent
        # for some reason.
        away_spread = _odd_num(odds.get(ODD_AWAY_SPREAD), "bookSpread", "fairSpread")
        home_spread = -away_spread if away_spread is not None else None
    total_point = _odd_num(odds.get(ODD_TOTAL_OVER), "bookOverUnder", "fairOverUnder")
    if total_point is None:
        total_point = _odd_num(odds.get(ODD_TOTAL_UNDER), "bookOverUnder", "fairOverUnder")
    if home_spread is None or total_point is None:
        return None

    favorite = "home" if home_spread < 0 else "away"
    spread = abs(home_spread)

    return {
        "extId": event.get("eventID"),
        "sport": sport_label,
        "week": None,  # filled in later by assign_week_numbers(), once per sport
        "away": away_name,
        "home": home_name,
        "favorite": favorite,
        "spread": spread,
        "total": total_point,
        "kickoff": kickoff,  # full ISO 8601 UTC, e.g. 2026-09-14T00:20:00.000Z
    }


def extract_final_scores(event):
    # SportsGameOdds has no separate top-level "final score" field on an
    # event -- once a game ends, the realized value of each graded odd is
    # written into that odd's own "score" field (see docs/guides/handling-
    # odds). The two point-spread odds happen to be scoped to exactly one
    # team each (statEntityID home/away), so their "score" values ARE that
    # team's final points. Returns (home_score, away_score) or None if either
    # side's score isn't present/parseable yet.
    odds = event.get("odds") or {}
    home_score = _odd_num(odds.get(ODD_HOME_SPREAD), "score")
    away_score = _odd_num(odds.get(ODD_AWAY_SPREAD), "score")
    if home_score is None or away_score is None:
        return None
    return int(home_score), int(away_score)


def strip_markdown_fence(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    if text.endswith("```"):
        text = text.rsplit("```", 1)[0]
    return text.strip()


def load_sport_file(sport_label, path):
    """Read a local JSON file the agent saved from a WebFetch call against
    SportsGameOdds. Returns (events, error) -- error is set (and events ==
    []) if the file holds an API error body (bad key, quota exhausted, etc.)
    instead of the expected {"success":true,"data":[...]} envelope. A bare
    list is tolerated too, in case the envelope was already unwrapped."""
    if not path:
        return [], "no file provided"
    try:
        with open(path) as f:
            raw = strip_markdown_fence(f.read())
        data = json.loads(raw)
    except Exception as e:
        return [], "could not read/parse {}: {}".format(path, e)

    if isinstance(data, list):
        return data, None
    if isinstance(data, dict):
        if data.get("success") is False:
            return [], "{} API returned an error: {}".format(sport_label, data.get("error") or data)
        events = data.get("data")
        if isinstance(events, list):
            return events, None
        msg = data.get("error") or data.get("message") or data
        return [], "{} API response did not include a 'data' list: {}".format(sport_label, msg)
    return [], "{} API returned an unrecognized response shape".format(sport_label)


def is_locked(game):
    if game.get("status") == "final":
        return True
    if game.get("kickoff"):
        try:
            kt = datetime.fromisoformat(game["kickoff"].replace("Z", "+00:00"))
            if kt.tzinfo is None:
                kt = kt.replace(tzinfo=timezone.utc)
            return datetime.now(timezone.utc) >= kt
        except Exception:
            return False
    return False


def _norm_name(name):
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _same_matchup(a, b):
    # Two games are the "same" real-world matchup if they're the same sport,
    # kicked off on the same calendar day, and each side's team name is a
    # substring of (or equal to) the other's -- catching the common
    # "School" vs "School Mascot" naming inconsistency SportsGameOdds itself
    # exhibits (see NCAAF_TOP_PROGRAMS comments) as well as mismatches
    # between different sync runs/ID schemes for the same real event.
    if a.get("sport") != b.get("sport"):
        return False
    ak, bk = a.get("kickoff"), b.get("kickoff")
    if not ak or not bk or ak[:10] != bk[:10]:
        return False
    ah, aa = _norm_name(a.get("home")), _norm_name(a.get("away"))
    bh, ba = _norm_name(b.get("home")), _norm_name(b.get("away"))
    home_match = ah and bh and (ah in bh or bh in ah)
    away_match = aa and ba and (aa in ba or ba in aa)
    return bool(home_match and away_match)


def find_existing_match(existing_games, by_ext, f):
    # Exact extId match first (the normal, expected case for every run once
    # a season is on the real API consistently). Falls back to a fuzzy
    # team+date match so a fetch that happens to carry a different extId for
    # a game we already have (e.g. a differently-sourced or re-issued ID)
    # updates that existing row instead of silently creating a duplicate
    # listing of the same real-world game -- this is exactly the bug a
    # mixed-ID-scheme merge produced once already (see docs/CHANGELOG or ask
    # -- two rows for the same UMass @ Rutgers game).
    cur = by_ext.get(f["extId"])
    if cur is not None:
        return cur
    for g in existing_games:
        if _same_matchup(g, f):
            return g
    return None


def merge_games(existing_games, fetched):
    by_ext = {g.get("extId"): g for g in existing_games if g.get("extId")}
    next_order = max([g.get("order", 0) for g in existing_games], default=-1) + 1
    added, updated = 0, 0
    for f in fetched:
        cur = find_existing_match(existing_games, by_ext, f)
        if cur is None:
            f["id"] = "sync-" + f["extId"]
            f["status"] = "open"
            f["finalHome"] = None
            f["finalAway"] = None
            f["order"] = next_order
            next_order += 1
            existing_games.append(f)
            by_ext[f["extId"]] = f
            added += 1
        elif not is_locked(cur):
            # Adopt the fetched event's extId too, in case this update came
            # in via the fuzzy fallback under a different extId than the row
            # already had -- keeps future runs matching by extId directly.
            cur["extId"] = f["extId"]
            by_ext[f["extId"]] = cur
            cur["favorite"] = f["favorite"]
            cur["spread"] = f["spread"]
            cur["total"] = f["total"]
            cur["kickoff"] = f["kickoff"]
            cur["away"] = f["away"]
            cur["home"] = f["home"]
            updated += 1
    for sport in set(g.get("sport") for g in existing_games if g.get("sport")):
        assign_week_numbers(existing_games, sport)
    return existing_games, added, updated


def merge_scores(existing_games, score_events):
    # Settles any OPEN game whose SportsGameOdds event now reports
    # status.completed=true, by writing status="final" and the two final
    # scores (read via extract_final_scores(), see its docstring for why).
    # Never touches a game already marked final, never adds games, and never
    # touches wagers -- those settle themselves automatically in the page
    # the moment gameResult()/wagerResult() see status="final".
    by_ext = {g.get("extId"): g for g in existing_games if g.get("extId")}
    settled = []
    for ev in score_events:
        status = ev.get("status") or {}
        if not status.get("completed"):
            continue
        g = by_ext.get(ev.get("eventID"))
        if not g or g.get("status") == "final":
            continue
        scores = extract_final_scores(ev)
        if not scores:
            continue
        home_score, away_score = scores
        g["status"] = "final"
        g["finalHome"] = home_score
        g["finalAway"] = away_score
        settled.append("{} {} @ {} ({}-{})".format(g.get("sport"), g.get("away"), g.get("home"), away_score, home_score))
    return existing_games, settled


STATE_RE = re.compile(
    r'(<script id="state-data" type="application/json">)(.*?)(</script>)', re.S
)


def rebuild_fragment(current_html, new_state):
    # Only the FIRST match is the real <script id="state-data"> tag; the page's
    # own buildFullDocument() template later in the file contains the same
    # opening-tag text as a JS string literal and must not be touched.
    # Escapes every '<' the same way the app's own buildFullDocument() does
    # (JSON.stringify(state).replace(/</g, '\\u003c')) -- without this, free
    # text a commissioner typed into the Rules tab (or an announcement, team
    # name, etc.) containing a literal "</script" sequence would prematurely
    # close this script tag and corrupt the page.
    json_str = json.dumps(new_state).replace("<", "\\u003c")
    def repl(m):
        return m.group(1) + json_str + m.group(3)
    new_html, n = STATE_RE.subn(repl, current_html, count=1)
    if n != 1:
        raise RuntimeError("Could not find the state-data script tag to replace (found {} matches)".format(n))
    return new_html


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nfl-file", help="local file with the raw WebFetch JSON for leagueID=NFL events (odds/lines)")
    ap.add_argument("--ncaaf-file", help="local file with the raw WebFetch JSON for leagueID=NCAAF events (odds/lines)")
    ap.add_argument("--nfl-scores-file", help="local file with the raw WebFetch JSON for leagueID=NFL ended events (for settlement)")
    ap.add_argument("--ncaaf-scores-file", help="local file with the raw WebFetch JSON for leagueID=NCAAF ended events (for settlement)")
    ap.add_argument("--current-html", help="path to a file containing the artifact's current full HTML/fragment")
    ap.add_argument("--out", default="merged_fragment.html")
    args = ap.parse_args()

    all_events = []
    for label, path in (("NFL", args.nfl_file), ("NCAAF", args.ncaaf_file)):
        if not path:
            continue
        events, err = load_sport_file(label, path)
        if err:
            sys.stderr.write("Skipping {}: {}\n".format(label, err))
            continue
        all_events.extend((label, e) for e in events)

    normalized = []
    for label, e in all_events:
        if label == "NCAAF":
            teams = e.get("teams") or {}
            home_n = _team_name(teams.get("home"))
            away_n = _team_name(teams.get("away"))
            if home_n not in NCAAF_TOP_PROGRAMS and away_n not in NCAAF_TOP_PROGRAMS:
                continue
        n = normalize_event(e, label)
        if n:
            normalized.append(n)

    print("Fetched {} raw events, {} normalized after filtering.".format(len(all_events), len(normalized)))

    score_events = []
    for label, path in (("NFL", args.nfl_scores_file), ("NCAAF", args.ncaaf_scores_file)):
        if not path:
            continue
        events, err = load_sport_file(label + " scores", path)
        if err:
            sys.stderr.write("Skipping {} scores: {}\n".format(label, err))
            continue
        score_events.extend(events)

    if args.current_html:
        with open(args.current_html) as f:
            html = f.read()
        m = re.search(r'<script id="state-data" type="application/json">(.*?)</script>', html, re.S)
        if not m:
            raise RuntimeError("state-data not found in current html")
        state = json.loads(m.group(1))
        state["games"], added, updated = merge_games(state.get("games", []), normalized)
        print("Games added: {}, updated: {}".format(added, updated))
        if score_events:
            state["games"], settled = merge_scores(state["games"], score_events)
            print("Games settled: {}".format(len(settled)))
            for line in settled:
                print("  " + line)
        new_html = rebuild_fragment(html, state)
        with open(args.out, "w") as f:
            f.write(new_html)
        print("Wrote merged document to {}".format(args.out))
    else:
        print(json.dumps(normalized, indent=2)[:2000])


if __name__ == "__main__":
    main()
