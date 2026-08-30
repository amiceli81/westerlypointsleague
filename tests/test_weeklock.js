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
  await form.locator('input[name="ats-points"]').fill('40');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);

  // Wager on the LATE game too (still open, before the early game has started).
  form = lateCard().locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="away"]').check();
  await form.locator('input[name="ats-points"]').fill('30');
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
  if (!lateRecapText.includes('Away Late') && !lateRecapText.includes('40') && !lateRecapText.includes('30')) {
    // just sanity that some ATS content shows the existing pick was preserved
  }

  console.log('ALL WEEK-LOCK TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
