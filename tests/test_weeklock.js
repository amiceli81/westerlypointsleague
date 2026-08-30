const { chromium } = require('playwright');

function pad(n) { return String(n).padStart(2, '0'); }
function toLocalInputValue(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  // Game A: kickoff already in the PAST (a few minutes ago) -- open enough to
  // manipulate directly through state so we can wager on it "before" it
  // kicked off, then let time roll forward past it without waiting.
  const pastKickoff = new Date(Date.now() - 5 * 60 * 1000);
  // Game B: kickoff well in the future, same week/sport as Game A.
  const futureKickoff = new Date(Date.now() + 3 * 60 * 60 * 1000);

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  // We need Game A to be OPEN (not started) at the moment we place a wager on
  // it, then become locked afterward. So: give it a future kickoff first,
  // wager on it, then (as admin) edit its kickoff to the past to simulate
  // time passing. There's no standalone "Add a game" form anymore -- games
  // arrive via odds sync -- so both fixture games are existing seeded games
  // repurposed via Edit. Both are forced onto the SAME sport, since the
  // week-lock rule is scoped to one sport's week.
  const soonKickoff = new Date(Date.now() + 60 * 1000); // 1 minute out

  // Capture two distinct fixture rows BEFORE any edits, identified by their
  // original text. Editing the first game changes its kickoff, which causes
  // sortedGames() to re-sort the admin list -- so a plain nth(1) evaluated
  // AFTER the first edit can end up pointing at the wrong row (or the same
  // row again). Re-locating by original text sidesteps that entirely.
  const adminRows = page.locator('.admin-game-row');
  const fixtureAId = (await adminRows.nth(0).innerText()).split('\n')[0].trim();
  const fixtureBId = (await adminRows.nth(1).innerText()).split('\n')[0].trim();
  console.log('Fixture A original row:', fixtureAId);
  console.log('Fixture B original row:', fixtureBId);
  if (fixtureAId === fixtureBId) throw new Error('FAIL: fixture rows collided, cannot distinguish A from B');

  await page.locator('.admin-game-row', { hasText: fixtureAId }).first().locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.selectOption('form[data-action="save-game"] select[name="sport"]', 'NFL');
  await page.fill('form[data-action="save-game"] input[name="week"]', 'Lock Test Week');
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Away Early');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Home Early');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(soonKickoff));
  await page.fill('form[data-action="save-game"] input[name="spread"]', '3');
  await page.fill('form[data-action="save-game"] input[name="total"]', '44');
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.locator('.admin-game-row', { hasText: fixtureBId }).first().locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.selectOption('form[data-action="save-game"] select[name="sport"]', 'NFL');
  await page.fill('form[data-action="save-game"] input[name="week"]', 'Lock Test Week');
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Away Late');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Home Late');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(futureKickoff));
  await page.fill('form[data-action="save-game"] input[name="spread"]', '3');
  await page.fill('form[data-action="save-game"] input[name="total"]', '44');
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  // Sign up and wager on BOTH games while both are still open.
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'lockuser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Lock Test Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Lock');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'User');
  await page.fill('form[data-action="signup"] input[name="email"]', 'lock@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(250);

  function earlyCard() {
    return page.locator('.game-card', { has: page.locator('.tname', { hasText: 'Away Early' }) })
      .filter({ has: page.locator('.tname', { hasText: 'Home Early' }) });
  }
  function lateCard() {
    return page.locator('.game-card', { has: page.locator('.tname', { hasText: 'Away Late' }) })
      .filter({ has: page.locator('.tname', { hasText: 'Home Late' }) });
  }

  // Wager on the EARLY game.
  let form = earlyCard().locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="home"]').check();
  await form.locator('input[name="ats-points"]').fill('140');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);

  // Wager on the LATE game too (still open, before the early game has started).
  form = lateCard().locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="away"]').check();
  await form.locator('input[name="ats-points"]').fill('130');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);

  // Simulate time passing: as admin, edit the EARLY game's kickoff into the
  // past so it's now started, without actually sleeping through real time.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.click('.admin-game-row:has-text("Away Early") button[data-action="edit-game"]');
  await page.waitForTimeout(150);
  const pastKickoffVal = toLocalInputValue(new Date(Date.now() - 5 * 60 * 1000));
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', pastKickoffVal);
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(200);

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);

  // The LATE game hasn't kicked off yet, but since our EARLIEST wagered game
  // this week (Early) has now started, the late game should show a locked
  // recap instead of an editable form.
  const lateForm = await lateCard().locator('form[data-action="save-picks"]').count();
  const lateRecapText = await lateCard().locator('.recap').innerText().catch(() => null);
  console.log('late game form count (should be 0):', lateForm);
  console.log('late game recap text:', lateRecapText);

  if (lateForm !== 0) throw new Error('FAIL: late game should no longer show an editable pick form once the early wagered game started');
  if (!lateRecapText || !lateRecapText.toLowerCase().includes('locked')) {
    throw new Error('FAIL: late game recap should explain the week is locked, got: ' + lateRecapText);
  }
  if (!lateRecapText.includes('Away Late') && !lateRecapText.includes('140') && !lateRecapText.includes('130')) {
    // just sanity that some ATS content shows the existing pick was preserved
  }

  console.log('ALL WEEK-LOCK TESTS PASSED');
  await browser.close();

  // --- Stale-form race: a page that was rendered just BEFORE the earliest
  // wagered game kicked off can still have another game's editable pick
  // form on screen after that kickoff passes for real, since nothing
  // re-renders the page on its own as wall-clock time moves forward. If the
  // player submits that stale form, the app must reject it with a clear
  // popup rather than silently doing nothing.
  //
  // The admin "edit game" form's kickoff input is a plain datetime-local
  // field (minute precision, no seconds), so it can't express "a couple of
  // seconds from now" -- building a fresh fixture with full-precision ISO
  // kickoffs seeded directly into state (same technique test_rules.js uses
  // for its read-only fixture) sidesteps that entirely.
  const fs = require('fs');
  const html = fs.readFileSync('/tmp/test_dup_full.html', 'utf8');
  const m2 = html.match(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/);
  const data = JSON.parse(m2[2]);
  const raceEarlyId = 'race-early';
  const raceLateId = 'race-late';
  data.games.push({
    id: raceEarlyId, sport: 'NFL', week: 'Race Week', away: 'Away RaceEarly', home: 'Home RaceEarly',
    favorite: 'home', spread: 3, total: 44, kickoff: new Date(Date.now() + 2500).toISOString(),
    status: 'open', finalHome: null, finalAway: null, order: 9001,
  });
  data.games.push({
    id: raceLateId, sport: 'NFL', week: 'Race Week', away: 'Away RaceLate', home: 'Home RaceLate',
    favorite: 'away', spread: 3, total: 44, kickoff: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
    status: 'open', finalHome: null, finalAway: null, order: 9002,
  });
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const raceHtml = html.slice(0, m2.index) + m2[1] + safeJson + m2[3] + html.slice(m2.index + m2[0].length);
  fs.writeFileSync('/tmp/test_race_full.html', raceHtml);

  const browser2 = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page2 = await browser2.newPage();
  page2.on('pageerror', err => console.log('PAGE EXCEPTION (stale-submit check):', err.message));
  await page2.goto('file:///tmp/test_race_full.html');
  await page2.waitForTimeout(300);

  await page2.fill('form[data-action="signup"] input[name="username"]', 'raceuser');
  await page2.fill('form[data-action="signup"] input[name="teamName"]', 'Race Test Team');
  await page2.fill('form[data-action="signup"] input[name="firstName"]', 'Race');
  await page2.fill('form[data-action="signup"] input[name="lastName"]', 'User');
  await page2.fill('form[data-action="signup"] input[name="email"]', 'race@test.com');
  await page2.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page2.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page2.click('form[data-action="signup"] button[type="submit"]');
  await page2.waitForTimeout(150);

  function raceEarlyCard() {
    return page2.locator('.game-card', { has: page2.locator('.tname', { hasText: 'Away RaceEarly' }) });
  }
  function raceLateCard() {
    return page2.locator('.game-card', { has: page2.locator('.tname', { hasText: 'Away RaceLate' }) });
  }

  // Wager on RaceEarly (ATS only) while it's still open -- this becomes
  // raceuser's earliest wagered game of the week.
  let raceForm = raceEarlyCard().locator('form[data-action="save-picks"]');
  await raceForm.locator('input[name="ats-pick"][value="home"]').check();
  await raceForm.locator('input[name="ats-points"]').fill('120');
  await raceForm.locator('button[type="submit"]').click();
  await page2.waitForTimeout(150);

  // Wager ATS only on RaceLate too, leaving its OU market open -- this is the
  // form we'll try to (stale-)submit after RaceEarly's kickoff passes.
  raceForm = raceLateCard().locator('form[data-action="save-picks"]');
  await raceForm.locator('input[name="ats-pick"][value="away"]').check();
  await raceForm.locator('input[name="ats-points"]').fill('115');
  await raceForm.locator('button[type="submit"]').click();
  await page2.waitForTimeout(150);

  // Let real wall-clock time carry RaceEarly's kickoff into the past WITHOUT
  // triggering any re-render (no clicks, no tab switches) -- exactly the
  // stale-DOM scenario this guards against.
  await page2.waitForTimeout(2800);

  const staleOuForm = raceLateCard().locator('form[data-action="save-picks"]');
  if (await staleOuForm.count() !== 1) throw new Error('FAIL: expected the stale RaceLate-game form to still be present in the DOM before submitting it');
  await staleOuForm.locator('input[name="ou-pick"][value="over"]').check();
  await staleOuForm.locator('input[name="ou-points"]').fill('110');
  await staleOuForm.locator('button[type="submit"]').click();
  await page2.waitForTimeout(200);

  const toastText = await page2.locator('#toast-root .toast').last().innerText().catch(() => null);
  console.log('Stale-submit toast text:', toastText);
  if (!toastText || !/first game has kicked off already/i.test(toastText)) {
    throw new Error('FAIL: expected a "first game has kicked off already" popup on stale submit, got: ' + toastText);
  }

  // And the OU wager must NOT have been saved -- re-render (tab switch) and
  // confirm the game now shows as week-locked with no OU pick recorded.
  await page2.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page2.waitForTimeout(100);
  await page2.click('button[data-action="set-tab"][data-tab="week"]');
  await page2.waitForTimeout(150);
  const postRaceRecap = await raceLateCard().locator('.recap').innerText();
  if (/Over 44/.test(postRaceRecap)) throw new Error('FAIL: the rejected stale OU submission should not have been saved, but it was: ' + postRaceRecap);

  console.log('ALL STALE-SUBMIT TESTS PASSED (popup + rejected save)');
  await browser2.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
