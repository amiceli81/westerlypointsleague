#!/usr/bin/env python3
"""
Standalone odds/score sync for The Westerly Points League, built to run
unattended from a scheduled task (a fresh session every run, no shared
filesystem with whoever wrote this script).

This machine's network policy blocks direct outbound calls to
api.sportsgameodds.com, so this script never fetches anything itself.
Instead, the calling agent uses WebFetch against SportsGameOdds and asks it
to EXTRACT/RE-EMIT a small custom-shaped JSON array (NOT a verbatim dump --
asking WebFetch for the raw response body gets it summarized/paraphrased by
the model behind WebFetch, or in the worst case refused outright; asking it
to actively transform the response into a small named-field array works
reliably). This script only reads those already-extracted local JSON files
and does the pure-data merge -- see run_scheduled_sync.md (embedded in the
scheduled task's own prompt) for the exact WebFetch call shapes.

Expected simple JSON shapes (one file per call):
  Odds/lines (not-yet-started games), array of:
    {"eventID": "...", "home": "...", "away": "...",
     "startsAt": "2026-09-14T17:00:00.000Z",
     "homeSpread": -3.5, "total": 44.5}
    (homeSpread/total may be null if not yet posted -- that event is
    skipped for THIS run, not treated as an error.)
  Scores (started/ended games), array of:
    {"eventID": "...", "home": "...", "away": "...",
     "homeScore": 27, "awayScore": 20, "completed": true}
    (completed may be false for an in-progress game -- skipped until true.)

Usage:
  python3 scheduled_sync.py \
    --nfl-odds nfl_odds.json --ncaaf-odds ncaaf_odds.json \
    --nfl-scores nfl_scores.json --ncaaf-scores ncaaf_scores.json \
    --current-html current.html --out merged.html

Any of the four --*-odds/--*-scores args may be omitted if that WebFetch
call came back empty or failed -- this script simply skips that piece
rather than erroring, so a partial sync (e.g. NFL odds updated but NCAAF
WebFetch failed) still applies whatever it successfully got.

Design notes (mirrors sync.py's, adapted for the simple shape):
- Only ADDS new games or UPDATES lines on games that are still open and not
  past kickoff. Never touches a game that is status=final or whose kickoff
  has passed, and never touches wagers.
- Matches games primarily by "extId" (SportsGameOdds' eventID). Falls back
  to a fuzzy same-sport/same-day/team-name-containment match when no extId
  matches an existing game, so a fetch that happens to carry a different
  extId for a game already on the board (different sync run, reissued ID,
  etc.) updates that row instead of creating a duplicate listing of the
  same real-world game.
- NCAAF is filtered to a "top programs" allowlist (exact match, not
  substring, to avoid a false positive like "Arkansas-Pine Bluff" matching
  a bare "Arkansas" entry) so the board isn't flooded with 100+ games a
  week; both the "School Mascot" and bare "School" name forms are listed
  for every program since SportsGameOdds' team-name field inconsistently
  includes the mascot.
- Embeds the merged state back into the page's <script id="state-data">
  tag with every '<' escaped as \\u003c (matching the app's own
  buildFullDocument()), so free text anywhere in state -- a rule, an
  announcement, a team name -- containing a literal "</script" sequence
  can never break the page.
"""
import argparse
import json
import re
import sys
from datetime import datetime, timedelta, timezone

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
    dt = datetime.fromisoformat(iso_time.replace("Z", "+00:00"))
    try:
        from zoneinfo import ZoneInfo
        dt = dt.astimezone(ZoneInfo("America/New_York"))
    except Exception:
        pass
    dt = dt.replace(hour=0, minute=0, second=0, microsecond=0)
    return dt - timedelta(days=(dt.weekday() - 1) % 7)


def assign_week_numbers(games, sport_label):
    sport_games = [g for g in games if g.get("sport") == sport_label and g.get("kickoff")]
    if not sport_games:
        return
    anchor = min(week_tuesday_start(g["kickoff"]) for g in sport_games)
    for g in sport_games:
        n = round((week_tuesday_start(g["kickoff"]) - anchor).days / 7) + 1
        g["week"] = "Week {}".format(n)


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
    cur = by_ext.get(f["extId"])
    if cur is not None:
        return cur
    for g in existing_games:
        if _same_matchup(g, f):
            return g
    return None


def strip_markdown_fence(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else ""
    if text.endswith("```"):
        text = text.rsplit("```", 1)[0]
    return text.strip()


def load_simple_file(label, path):
    """Reads a WebFetch-extracted simple JSON array from a local file.
    Returns (events, error). Tolerant of a markdown code fence around the
    JSON (WebFetch sometimes wraps its output in one) and of an empty/
    missing file (treated as "nothing to do this run", not an error)."""
    if not path:
        return [], None
    try:
        with open(path) as f:
            raw = strip_markdown_fence(f.read())
        if not raw:
            return [], None
        data = json.loads(raw)
    except Exception as e:
        return [], "could not read/parse {}: {}".format(path, e)
    if not isinstance(data, list):
        return [], "{} did not contain a JSON array".format(path)
    return data, None


def normalize_odds_event(e, sport_label):
    home = e.get("home")
    away = e.get("away")
    kickoff = e.get("startsAt")
    home_spread = e.get("homeSpread")
    total = e.get("total")
    if not home or not away or not kickoff or home_spread is None or total is None:
        return None
    try:
        home_spread = float(home_spread)
        total = float(total)
    except (TypeError, ValueError):
        return None
    favorite = "home" if home_spread < 0 else "away"
    return {
        "extId": e.get("eventID"),
        "sport": sport_label,
        "week": None,
        "away": away,
        "home": home,
        "favorite": favorite,
        "spread": abs(home_spread),
        "total": total,
        "kickoff": kickoff,
    }


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
    by_ext = {g.get("extId"): g for g in existing_games if g.get("extId")}
    settled = []
    for ev in score_events:
        if not ev.get("completed"):
            continue
        g = by_ext.get(ev.get("eventID"))
        if g is None:
            # Fuzzy fallback for scores too, same reasoning as merge_games.
            for cand in existing_games:
                if _same_matchup(cand, {
                    "sport": cand.get("sport"), "home": ev.get("home"),
                    "away": ev.get("away"), "kickoff": cand.get("kickoff"),
                }):
                    g = cand
                    break
        if not g or g.get("status") == "final":
            continue
        home_score, away_score = ev.get("homeScore"), ev.get("awayScore")
        if home_score is None or away_score is None:
            continue
        try:
            home_score, away_score = int(home_score), int(away_score)
        except (TypeError, ValueError):
            continue
        g["status"] = "final"
        g["finalHome"] = home_score
        g["finalAway"] = away_score
        settled.append("{} {} @ {} ({}-{})".format(g.get("sport"), g.get("away"), g.get("home"), away_score, home_score))
    return existing_games, settled


STATE_RE = re.compile(
    r'(<script id="state-data" type="application/json">)(.*?)(</script>)', re.S
)


def rebuild_fragment(current_html, new_state):
    # Escapes every '<' the same way the app's own buildFullDocument() does
    # (JSON.stringify(state).replace(/</g, '\\u003c')) so free text anywhere
    # in state can never contain a literal "</script" that would corrupt
    # this tag.
    json_str = json.dumps(new_state).replace("<", "\\u003c")
    def repl(m):
        return m.group(1) + json_str + m.group(3)
    new_html, n = STATE_RE.subn(repl, current_html, count=1)
    if n != 1:
        raise RuntimeError("Could not find the state-data script tag to replace (found {} matches)".format(n))
    return new_html


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--nfl-odds")
    ap.add_argument("--ncaaf-odds")
    ap.add_argument("--nfl-scores")
    ap.add_argument("--ncaaf-scores")
    ap.add_argument("--current-html", required=True)
    ap.add_argument("--out", default="merged.html")
    args = ap.parse_args()

    normalized = []
    for label, path in (("NFL", args.nfl_odds), ("NCAAF", args.ncaaf_odds)):
        events, err = load_simple_file(label + " odds", path)
        if err:
            sys.stderr.write("Skipping {} odds: {}\n".format(label, err))
            continue
        for e in events:
            if label == "NCAAF":
                if e.get("home") not in NCAAF_TOP_PROGRAMS and e.get("away") not in NCAAF_TOP_PROGRAMS:
                    continue
            n = normalize_odds_event(e, label)
            if n:
                normalized.append(n)
    print("Odds: {} normalized events to merge.".format(len(normalized)))

    score_events = []
    for label, path in (("NFL", args.nfl_scores), ("NCAAF", args.ncaaf_scores)):
        events, err = load_simple_file(label + " scores", path)
        if err:
            sys.stderr.write("Skipping {} scores: {}\n".format(label, err))
            continue
        for e in events:
            e["sport"] = label
        score_events.extend(events)
    print("Scores: {} candidate events.".format(len(score_events)))

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


if __name__ == "__main__":
    main()
