#!/usr/bin/env python3
"""
Regenerates deploy-hostinger/index.html from the repo's pool.html.

pool.html is the Claude Artifact version -- it still uses window.claude to
save/load. This script takes its markup/styles/business-logic and swaps in
the fetch()-based save/load layer this Hostinger deployment needs instead,
via a fixed series of text substitutions (documented inline below). It's
mechanical on purpose: run this every time pool.html changes and upload the
resulting index.html to Hostinger, overwriting the old one.

Two things are carried forward from the CURRENT deploy-hostinger/index.html
rather than regenerated, so re-running this is safe and idempotent:
  - SAVE_KEY: must keep matching whatever's already in config.php on the
    live server, or every save starts getting rejected as forbidden.
  - The embedded state-data seed: only ever used for the very first paint
    before the page's first fetch to api.php resolves (the database is the
    real source of truth after that), so there's no reason to touch it --
    doing so would just make diffs noisier and could confuse anyone
    reading the file expecting it to reflect pool.html's own fixture data.

Usage:
  python3 deploy-hostinger/build.py
"""
import json
import os
import re
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
POOL_HTML = os.path.join(REPO_ROOT, 'pool.html')
OUT_HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')


def die(msg):
    print('BUILD FAILED: ' + msg, file=sys.stderr)
    sys.exit(1)


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        die('expected exactly one occurrence of {} ({} found) -- pool.html has '
            'likely changed in a way this script no longer accounts for. '
            'Update build.py\'s substitutions to match.'.format(label, count))
    return text.replace(old, new)


def main():
    if not os.path.isfile(POOL_HTML):
        die('could not find pool.html at ' + POOL_HTML)
    with open(POOL_HTML, encoding='utf-8') as f:
        pool = f.read()

    # --- Split pool.html into: head content (title + style), and the main
    # <script>...</script> block. pool.html is a fragment: title, style,
    # the state-data script tag (git's own fixture data, NOT used below),
    # then the main script. ---
    style_close = '</style>\n'
    if style_close not in pool:
        die('could not find "</style>" in pool.html')
    head_part = pool[:pool.index(style_close) + len(style_close)]  # <title>...<style>...</style>

    script_open_marker = '\n<script>\n'
    state_data_close = '</script>\n' + script_open_marker.strip('\n') if False else None
    # The main script is the LAST <script>...</script> pair in the file (the
    # state-data script tag is JSON, not JS, and comes first).
    script_matches = list(re.finditer(r'<script>\n([\s\S]*?)\n</script>', pool))
    if not script_matches:
        die('could not find the main <script>...</script> block in pool.html')
    script = script_matches[-1].group(1)

    # --- Same substitutions as the original hand-built version: remove
    # window.claude/Artifact-specific code, replace it with fetch()-based
    # save/load against api.php. See deploy-hostinger/README.md for why. ---

    script = replace_once(
        script,
        "(function(){\n"
        '  "use strict";\n'
        "  var TITLE_TEXT = document.title;\n"
        "  var STYLE_TEXT = document.getElementById('app-style').textContent;\n"
        "  var SCRIPT_TEXT = document.currentScript.textContent;\n"
        "  var MIN_WAGER = 100;",
        "(function(){\n"
        '  "use strict";\n'
        "  var MIN_WAGER = 100;\n"
        "  // Authorizes writes to api.php (signups, picks, admin actions). This is\n"
        "  // NOT a secret from anyone who loads this page -- it's embedded in the\n"
        "  // page source and visible to any player. Its only job is to stop\n"
        "  // automated requests that never load the page at all from hitting the\n"
        "  // save endpoint. Real access control for who gets to play is: don't share\n"
        "  // this URL outside your group.\n"
        "  var SAVE_KEY = '__SAVE_KEY__';\n"
        "  var serverVersion = null;",
        'the header/const-declarations block',
    )

    script = replace_once(
        script,
        "  var state = null;\n"
        "  try{ state = JSON.parse(document.getElementById('state-data').textContent); }catch(e){ state = null; }\n"
        "  if(!state || typeof state !== 'object'){\n"
        '    state = {poolName:"The Westerly Points League", startingBalance:1000, commissionerPin:"1234", players:[], games:[], wagers:[]};\n'
        "  }\n"
        "  state.players = state.players || [];\n"
        "  state.games = state.games || [];\n"
        "  state.wagers = state.wagers || [];\n"
        "  state.announcements = state.announcements || [];\n"
        "  state.adjustments = state.adjustments || [];\n"
        "  state.weekVisibility = state.weekVisibility || {};\n"
        "  state.rulesText = state.rulesText || '';",
        "  // Applied both to the copy embedded at deploy time AND to whatever\n"
        "  // api.php?action=state returns, so a fresh server copy gets the same\n"
        "  // defaults/migration as the initial parse below.\n"
        "  function normalizeState(s){\n"
        "    if(!s || typeof s !== 'object'){\n"
        '      s = {poolName:"The Westerly Points League", startingBalance:1000, commissionerPin:"1234", players:[], games:[], wagers:[]};\n'
        "    }\n"
        "    s.players = s.players || [];\n"
        "    s.games = s.games || [];\n"
        "    s.wagers = s.wagers || [];\n"
        "    s.announcements = s.announcements || [];\n"
        "    s.adjustments = s.adjustments || [];\n"
        "    s.weekVisibility = s.weekVisibility || {};\n"
        "    s.rulesText = s.rulesText || '';\n"
        "    // Migrate pre-account rosters (plain name strings) out of s.players --\n"
        "    // those names have no password and can't log in under the new system.\n"
        "    // Their past wagers still display fine (displayName() falls back to the\n"
        "    // raw stored string for anything that isn't a real account).\n"
        "    s.players = s.players.filter(function(p){ return p && typeof p === 'object'; });\n"
        "    return s;\n"
        "  }\n"
        "\n"
        "  var state = null;\n"
        "  try{ state = JSON.parse(document.getElementById('state-data').textContent); }catch(e){ state = null; }\n"
        "  state = normalizeState(state);",
        'the state-parsing/defaults block',
    )

    script = replace_once(
        script,
        "  // Migrate pre-account rosters (plain name strings) out of state.players --\n"
        "  // those names have no password and can't log in under the new system.\n"
        "  // Their past wagers still display fine (displayName() falls back to the\n"
        "  // raw stored string for anything that isn't a real account).\n"
        "  state.players = (state.players || []).filter(function(p){ return p && typeof p === 'object'; });\n"
        "\n"
        "  try{ view.isCommissioner = localStorage.getItem('poolIsCommissioner') === 'yes'; }catch(e){}",
        "  try{ view.isCommissioner = localStorage.getItem('poolIsCommissioner') === 'yes'; }catch(e){}",
        'the now-redundant migration line (moved into normalizeState above)',
    )

    script = replace_once(
        script,
        "  try{ view.isCommissioner = localStorage.getItem('poolIsCommissioner') === 'yes'; }catch(e){}\n"
        "  var currentPlayer = null;\n"
        "  try{ currentPlayer = localStorage.getItem('poolUsername') || null; }catch(e){}\n"
        "  if(currentPlayer && !findPlayer(currentPlayer)){\n"
        "    currentPlayer = null;\n"
        "    try{ localStorage.removeItem('poolUsername'); }catch(e){}\n"
        "  }",
        "  try{ view.isCommissioner = localStorage.getItem('poolIsCommissioner') === 'yes'; }catch(e){}\n"
        "  var currentPlayer = null;\n"
        "  try{ currentPlayer = localStorage.getItem('poolUsername') || null; }catch(e){}\n"
        "  // NOT validated against findPlayer() here -- at this point `state` is\n"
        "  // only the copy embedded in the page at deploy time, which goes stale the\n"
        "  // moment anyone signs up afterward. Validating here would silently log\n"
        "  // out every returning player whose account postdates the last deploy.\n"
        "  // The real validation happens once the fetch in init() below replaces\n"
        "  // `state` with the server's current copy.",
        'the currentPlayer-from-localStorage block',
    )

    script = replace_once(
        script,
        "  var artifactCap = null;\n"
        "  var warnedNoCap = false;\n"
        "  var downloadsCap = null;",
        "  var warnedNoCap = false;\n"
        "  // Players/wagers created locally (signup, placing a pick) that haven't\n"
        "  // been confirmed saved to the server yet. Replayed on top of whatever\n"
        "  // the server returns on the initial load or a save conflict, so a brand\n"
        "  // new account or pick never gets silently wiped out by a fetch that\n"
        "  // resolves (or a version conflict) before it made it to the database.\n"
        "  var pendingAdditions = { players: [], wagers: [] };",
        'the capability-holder variables',
    )

    script = replace_once(
        script,
        "      hashNewPassword(suPassword).then(function(hashed){\n"
        "        state.players.push({\n"
        "          username: suUsername, salt: hashed.salt, passwordHash: hashed.hash,\n"
        "          teamName: suTeamName, firstName: suFirstName, lastName: suLastName, email: suEmail,\n"
        "          createdAt: new Date().toISOString()\n"
        "        });\n"
        "        currentPlayer = suUsername;\n"
        "        try{ localStorage.setItem('poolUsername', suUsername); }catch(err){}\n"
        "        save('Welcome to the pool, ' + suTeamName + '!');\n",
        "      hashNewPassword(suPassword).then(function(hashed){\n"
        "        var newPlayer = {\n"
        "          username: suUsername, salt: hashed.salt, passwordHash: hashed.hash,\n"
        "          teamName: suTeamName, firstName: suFirstName, lastName: suLastName, email: suEmail,\n"
        "          createdAt: new Date().toISOString()\n"
        "        };\n"
        "        state.players.push(newPlayer);\n"
        "        pendingAdditions.players.push(newPlayer);\n"
        "        currentPlayer = suUsername;\n"
        "        try{ localStorage.setItem('poolUsername', suUsername); }catch(err){}\n"
        "        save('Welcome to the pool, ' + suTeamName + '!');\n",
        'the signup handler (track the new player as a pending addition)',
    )

    script = replace_once(
        script,
        "    if(!pick || !points || points <= 0) return;\n"
        "    state.wagers.push({ id: uid(), gameId: gameId, player: currentPlayer, type: type, pick: pick, points: points });\n"
        "  }",
        "    if(!pick || !points || points <= 0) return;\n"
        "    var newWager = { id: uid(), gameId: gameId, player: currentPlayer, type: type, pick: pick, points: points };\n"
        "    state.wagers.push(newWager);\n"
        "    pendingAdditions.wagers.push(newWager);\n"
        "  }",
        'applyPick (track the new wager as a pending addition)',
    )

    script = replace_once(
        script,
        "  function buildFullDocument(){\n"
        "    var json = JSON.stringify(state).replace(/</g, '\\\\u003c');\n"
        "    return '<!doctype html>\\n<html lang=\"en\">\\n<head>\\n<meta charset=\"utf-8\">\\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\\n<title>' + esc(TITLE_TEXT) + '</title>\\n<style id=\"app-style\">' + STYLE_TEXT + '</style>\\n</head>\\n<body>\\n<div id=\"toast-root\"></div>\\n<div id=\"app\">Loading the board…</div>\\n<script id=\"state-data\" type=\"application/json\">' + json + '<\\/script>\\n<script>' + SCRIPT_TEXT + '<\\/script>\\n</body>\\n</html>';\n"
        "  }\n"
        "\n"
        "  var saving = false;\n"
        "  function save(successMsg){\n"
        "    render();\n"
        "    if(view.readOnly){\n"
        '      toast("You\'re viewing read-only — ask the pool owner for edit access to save picks.");\n'
        "      return Promise.resolve(false);\n"
        "    }\n"
        "    if(!artifactCap){\n"
        "      if(!warnedNoCap){ warnedNoCap = true; toast('Live saving isn\\'t available in this view — changes will only last this session.', 4500); }\n"
        "      return Promise.resolve(false);\n"
        "    }\n"
        "    if(saving) return Promise.resolve(false);\n"
        "    saving = true;\n"
        "    return artifactCap.publish(buildFullDocument()).then(function(){\n"
        "      saving = false;\n"
        "      if(successMsg) toast(successMsg);\n"
        "      return true;\n"
        "    }).catch(function(err){\n"
        "      saving = false;\n"
        "      var code = err && err.code;\n"
        "      if(code === 'not_writer' || code === 'not_granted' || code === 'consent_required'){\n"
        "        view.readOnly = true;\n"
        "        render();\n"
        '        toast("You\'re viewing read-only — ask the pool owner for edit access to save picks.");\n'
        "      } else if(code === 'conflict'){\n"
        "        toast('Someone else just saved a change — reloading with the latest board…');\n"
        "      } else if(code === 'not_declared' || code === 'capability_disabled' || code === 'capability_removed'){\n"
        "        artifactCap = null;\n"
        "        if(!warnedNoCap){ warnedNoCap = true; toast('Live saving isn\\'t available in this view — changes will only last this session.', 4500); }\n"
        "      } else {\n"
        "        toast('Could not save that just now — please try again.');\n"
        "      }\n"
        "      return false;\n"
        "    });\n"
        "  }",
        "  // Layers players/wagers created locally but not yet confirmed saved\n"
        "  // (see pendingAdditions) on top of a fresh copy of state fetched from\n"
        "  // the server, so a signup or a pick made just before the initial load\n"
        "  // resolves -- or one that lost a save-conflict race -- doesn't just\n"
        "  // vanish the moment the server's copy replaces the local one.\n"
        "  function applyPendingAdditions(remote){\n"
        "    var remoteUsernames = {};\n"
        "    remote.players.forEach(function(p){ remoteUsernames[p.username] = true; });\n"
        "    pendingAdditions.players.forEach(function(p){\n"
        "      if(!remoteUsernames[p.username]){ remote.players.push(p); remoteUsernames[p.username] = true; }\n"
        "    });\n"
        "    var remoteWagerIds = {};\n"
        "    remote.wagers.forEach(function(w){ remoteWagerIds[w.id] = true; });\n"
        "    pendingAdditions.wagers.forEach(function(w){\n"
        "      if(!remoteWagerIds[w.id]){ remote.wagers.push(w); remoteWagerIds[w.id] = true; }\n"
        "    });\n"
        "    return remote;\n"
        "  }\n"
        "\n"
        "  var saving = false;\n"
        "  function save(successMsg, retriesLeft){\n"
        "    render();\n"
        "    if(retriesLeft === undefined) retriesLeft = 2;\n"
        "    if(serverVersion === null){\n"
        "      if(!warnedNoCap){ warnedNoCap = true; toast('Live saving isn\\'t available right now — changes will only last this session.', 4500); }\n"
        "      return Promise.resolve(false);\n"
        "    }\n"
        "    if(saving) return Promise.resolve(false);\n"
        "    saving = true;\n"
        "    return fetch('api.php?action=save', {\n"
        "      method: 'POST',\n"
        "      headers: { 'Content-Type': 'application/json' },\n"
        "      body: JSON.stringify({ version: serverVersion, key: SAVE_KEY, data: state })\n"
        "    }).then(function(res){\n"
        "      return res.json().then(function(body){ return { status: res.status, body: body }; });\n"
        "    }).then(function(result){\n"
        "      saving = false;\n"
        "      if(result.status === 200){\n"
        "        serverVersion = result.body.version;\n"
        "        pendingAdditions = { players: [], wagers: [] };\n"
        "        if(successMsg) toast(successMsg);\n"
        "        return true;\n"
        "      }\n"
        "      if(result.status === 409){\n"
        "        // Someone else saved since we last loaded -- rebase onto their\n"
        "        // version instead of clobbering it, but replay anything of ours\n"
        "        // that hasn't been confirmed saved yet (a signup, a pick) so it\n"
        "        // isn't silently lost, then retry a bounded number of times in\n"
        "        // case of a fast back-to-back conflict.\n"
        "        state = applyPendingAdditions(normalizeState(result.body.data));\n"
        "        serverVersion = result.body.version;\n"
        "        render();\n"
        "        if(retriesLeft > 0){\n"
        "          return save(successMsg, retriesLeft - 1);\n"
        "        }\n"
        "        toast('Someone else just saved a change — reloading with the latest board…');\n"
        "        return false;\n"
        "      }\n"
        "      toast('Could not save that just now — please try again.');\n"
        "      return false;\n"
        "    }).catch(function(){\n"
        "      saving = false;\n"
        "      toast('Could not save that just now — please try again.');\n"
        "      return false;\n"
        "    });\n"
        "  }",
        'buildFullDocument()/save()',
    )

    script = replace_once(
        script,
        "    } else if(action === 'download-roster-backup'){\n"
        "      if(!view.isCommissioner) return;\n"
        "      if(!downloadsCap){ toast('Downloads aren\\'t available in this view.'); return; }\n"
        "      var backup = {\n"
        "        pool: state.poolName,\n"
        "        exportedAt: new Date().toISOString(),\n"
        "        accounts: rosterUsernames().map(function(u){\n"
        "          var p = findPlayer(u);\n"
        "          return p ? {\n"
        "            username: p.username, teamName: p.teamName, firstName: p.firstName,\n"
        "            lastName: p.lastName, email: p.email, createdAt: p.createdAt\n"
        "          } : { username: u, note: 'wagered under this name but never created an account' };\n"
        "        })\n"
        "      };\n"
        "      var stamp = new Date().toISOString().slice(0, 10);\n"
        "      var safeName = (state.poolName || 'pool').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pool';\n"
        "      downloadsCap.save({ filename: safeName + '-roster-backup-' + stamp + '.json', data: JSON.stringify(backup, null, 2) })\n"
        "        .then(function(){ toast('Roster backup saved.'); })\n"
        "        .catch(function(err){\n"
        "          var code = err && err.code;\n"
        "          if(code === 'declined') return;\n"
        "          toast('Could not save the backup file (' + (code || 'unknown error') + ').');\n"
        "        });",
        "    } else if(action === 'download-roster-backup'){\n"
        "      if(!view.isCommissioner) return;\n"
        "      var backup = {\n"
        "        pool: state.poolName,\n"
        "        exportedAt: new Date().toISOString(),\n"
        "        accounts: rosterUsernames().map(function(u){\n"
        "          var p = findPlayer(u);\n"
        "          return p ? {\n"
        "            username: p.username, teamName: p.teamName, firstName: p.firstName,\n"
        "            lastName: p.lastName, email: p.email, createdAt: p.createdAt\n"
        "          } : { username: u, note: 'wagered under this name but never created an account' };\n"
        "        })\n"
        "      };\n"
        "      var stamp = new Date().toISOString().slice(0, 10);\n"
        "      var safeName = (state.poolName || 'pool').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'pool';\n"
        "      var blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });\n"
        "      var blobUrl = URL.createObjectURL(blob);\n"
        "      var a = document.createElement('a');\n"
        "      a.href = blobUrl;\n"
        "      a.download = safeName + '-roster-backup-' + stamp + '.json';\n"
        "      document.body.appendChild(a);\n"
        "      a.click();\n"
        "      a.remove();\n"
        "      setTimeout(function(){ URL.revokeObjectURL(blobUrl); }, 1000);\n"
        "      toast('Roster backup saved.');",
        'the download-roster-backup action handler',
    )

    script = replace_once(
        script,
        "  function init(){\n"
        "    document.title = state.poolName;\n"
        "    if(window.claude && typeof window.claude.use === 'function'){\n"
        "      window.claude.use('artifact').then(function(cap){\n"
        "        artifactCap = cap;\n"
        "        if(!cap && !warnedNoCap){ warnedNoCap = true; toast('Live saving isn\\'t available in this view — changes will only last this session.', 4500); }\n"
        "      });\n"
        "      window.claude.use('downloads').then(function(cap){ downloadsCap = cap; });\n"
        "    }\n"
        "    render();\n"
        "  }\n"
        "  init();\n"
        "})();",
        "  function init(){\n"
        "    document.title = state.poolName;\n"
        "    // Paint immediately with whatever was embedded in the page at deploy\n"
        "    // time, then fetch the server's current copy -- this is what makes\n"
        "    // picks/signups/admin changes from other visitors show up, since the\n"
        "    // embedded copy is only ever as fresh as the last deploy.\n"
        "    render();\n"
        "    fetch('api.php?action=state').then(function(res){\n"
        "      if(!res.ok) throw new Error('bad status ' + res.status);\n"
        "      return res.json();\n"
        "    }).then(function(body){\n"
        "      // A signup or pick made in the moment between the page painting and\n"
        "      // this fetch resolving would otherwise be silently erased by the\n"
        "      // plain server copy replacing `state` below -- replay it on top\n"
        "      // instead, then get it actually saved now that the real version is\n"
        "      // known (save() bails out with only a 'this session only' warning\n"
        "      // until serverVersion is set, which is exactly this line).\n"
        "      var hadPending = pendingAdditions.players.length > 0 || pendingAdditions.wagers.length > 0;\n"
        "      state = applyPendingAdditions(normalizeState(body.data));\n"
        "      serverVersion = body.version;\n"
        "      // Only now, against the server's actual current player list, is it\n"
        "      // safe to decide whether a saved login is still valid.\n"
        "      if(currentPlayer && !findPlayer(currentPlayer)){\n"
        "        currentPlayer = null;\n"
        "        try{ localStorage.removeItem('poolUsername'); }catch(e){}\n"
        "      }\n"
        "      document.title = state.poolName;\n"
        "      render();\n"
        "      if(hadPending) save();\n"
        "    }).catch(function(){\n"
        "      toast('Could not reach the server — showing a cached copy. Live saving is unavailable until this is fixed.', 6000);\n"
        "    });\n"
        "  }\n"
        "  init();\n"
        "})();",
        'init()',
    )

    # --- Assemble the output, reusing the EXISTING index.html's SAVE_KEY
    # and embedded state-data seed (see module docstring for why). ---
    if not os.path.isfile(OUT_HTML):
        die('deploy-hostinger/index.html does not exist yet -- this script only '
            'REBUILDS it. For a first-ever build, see git history for how it was '
            'originally assembled, or ask for a fresh one to be built.')
    with open(OUT_HTML, encoding='utf-8') as f:
        existing = f.read()

    key_match = re.search(r"var SAVE_KEY = '([^']*)';", existing)
    if not key_match:
        die('could not find an existing SAVE_KEY in deploy-hostinger/index.html')
    save_key = key_match.group(1)

    state_match = re.search(r'(<script id="state-data" type="application/json">)([\s\S]*?)(</script>)', existing)
    if not state_match:
        die('could not find the existing state-data script tag in deploy-hostinger/index.html')
    try:
        json.loads(state_match.group(2))
    except ValueError as e:
        die('existing state-data in deploy-hostinger/index.html is not valid JSON: ' + str(e))

    script = script.replace('__SAVE_KEY__', save_key)

    doc = (
        '<!doctype html>\n<html lang="en">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        + head_part +
        '</head>\n<body>\n'
        '<div id="toast-root"></div>\n<div id="app">Loading the board…</div>\n'
        + state_match.group(1) + state_match.group(2) + state_match.group(3) + '\n'
        '<script>\n' + script + '\n</script>\n'
        '</body>\n</html>\n'
    )

    with open(OUT_HTML, 'w', encoding='utf-8') as f:
        f.write(doc)
    print('Wrote {} ({} bytes). SAVE_KEY carried forward unchanged; upload this '
          'to Hostinger, overwriting the old index.html -- config.php does not '
          'need to change.'.format(OUT_HTML, len(doc)))


if __name__ == '__main__':
    main()
