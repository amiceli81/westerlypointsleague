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

  // Open one fixture game (future kickoff) so a wager can be placed on it.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);
  await page.locator('.admin-game-row').first().locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Boot Wager Away');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Boot Wager Home');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + 3 * 60 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);

  async function signup(username, teamName) {
    await page.fill('form[data-action="signup"] input[name="username"]', username);
    await page.fill('form[data-action="signup"] input[name="teamName"]', teamName);
    await page.fill('form[data-action="signup"] input[name="firstName"]', 'First');
    await page.fill('form[data-action="signup"] input[name="lastName"]', 'Last');
    await page.fill('form[data-action="signup"] input[name="email"]', username + '@test.com');
    await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
    await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
    await page.click('form[data-action="signup"] button[type="submit"]');
    await page.waitForTimeout(200);
  }

  // Sign up two players -- one to boot, one to leave alone. Both wager on
  // the open fixture game, so we can check the booted player's wager (and
  // ONLY theirs) disappears everywhere afterward.
  await signup('bootme', 'Boot Me Team');
  const cardBoot = page.locator('.game-card', { hasText: 'Boot Wager Away' });
  const formBoot = cardBoot.locator('form[data-action="save-picks"]');
  await formBoot.locator('input[name="ats-pick"]').first().check();
  await formBoot.locator('input[name="ats-points"]').fill('200');
  await formBoot.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  await signup('keepme', 'Keep Me Team');
  const cardKeep = page.locator('.game-card', { hasText: 'Boot Wager Away' });
  const formKeep = cardKeep.locator('form[data-action="save-picks"]');
  await formKeep.locator('input[name="ats-pick"]').first().check();
  await formKeep.locator('input[name="ats-points"]').fill('300');
  await formKeep.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  // Lock the game (move kickoff to the past) so All Picks shows full rows
  // for it, not just the future-picks summary.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.locator('.admin-game-row', { hasText: 'Boot Wager Away' }).locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() - 60 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);

  // Log in as the player about to be booted, so we can check they're kicked
  // out immediately (same tab, same in-memory session).
  await page.click('button[data-action="auth-mode"][data-mode="login"]');
  await page.fill('form[data-action="login"] input[name="username"]', 'bootme');
  await page.fill('form[data-action="login"] input[name="password"]', 'password1');
  await page.click('form[data-action="login"] button[type="submit"]');
  await page.waitForTimeout(200);
  const loggedInAsBootme = await page.locator('.who-chip .name').textContent().catch(() => null);
  if (loggedInAsBootme !== 'Boot Me Team') throw new Error('FAIL: expected to be logged in as Boot Me Team, got: ' + loggedInAsBootme);

  // Go to the Commissioner tab and find the Boot a player card. Already
  // unlocked (sticky) from the game setup at the top of this test.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);

  const bootHeading = await page.locator('.section-title h3', { hasText: 'Boot a player' }).count();
  if (bootHeading !== 1) throw new Error('FAIL: expected a "Boot a player" section in the Commissioner tab');

  const bootCard = page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Boot a player' }) });
  const bootRow = bootCard.locator('tr', { hasText: 'Boot Me Team' });
  if (await bootRow.count() !== 1) throw new Error('FAIL: expected exactly one row for Boot Me Team, found ' + (await bootRow.count()));

  // Dismissing the confirm() dialog should leave the account intact.
  page.once('dialog', dialog => dialog.dismiss());
  await bootRow.locator('button[data-action="boot-player"]').click();
  await page.waitForTimeout(200);
  let stillThere = await bootCard.locator('tr', { hasText: 'Boot Me Team' }).count();
  if (stillThere !== 1) throw new Error('FAIL: dismissing the confirm() dialog should have left the account in place');
  console.log('PASS: dismissed confirm leaves the account intact');

  // Accepting the confirm() dialog removes the account.
  page.once('dialog', dialog => dialog.accept());
  await bootRow.locator('button[data-action="boot-player"]').click();
  await page.waitForTimeout(200);
  let goneRow = await page.locator('tr', { hasText: 'Boot Me Team' }).count();
  if (goneRow !== 0) throw new Error('FAIL: accepting the confirm() dialog should have removed the account row');
  console.log('PASS: accepted confirm removes the account row');

  // The booted player's own logged-in session should be kicked out immediately.
  const chipAfterBoot = await page.locator('.who-chip').count();
  if (chipAfterBoot !== 0) throw new Error('FAIL: expected the booted player to be logged out of their own session immediately');
  console.log('PASS: the booted player is logged out of their own session immediately');

  // They can no longer log back in with the old password.
  await page.click('button[data-action="goto-auth"]').catch(() => {});
  await page.click('button[data-action="auth-mode"][data-mode="login"]').catch(() => {});
  await page.fill('form[data-action="login"] input[name="username"]', 'bootme');
  await page.fill('form[data-action="login"] input[name="password"]', 'password1');
  await page.click('form[data-action="login"] button[type="submit"]');
  await page.waitForTimeout(200);
  const bodyText = await page.evaluate(() => document.body.innerText);
  if (!/no account/i.test(bodyText)) throw new Error('FAIL: expected "no account" after booted player tries to log back in, got page text without it');
  console.log('PASS: the booted player cannot log back in');

  // Booting removed the wager too -- gone from the leaderboard...
  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);
  const leaderboardHasBooted = await page.locator('table.board tbody tr', { hasText: 'Boot Me Team' }).count();
  if (leaderboardHasBooted !== 0) throw new Error('FAIL: expected the booted player to be gone from the leaderboard');
  console.log('PASS: the booted player is gone from the leaderboard');
  const leaderboardHasKept = await page.locator('table.board tbody tr', { hasText: 'Keep Me Team' }).count();
  if (leaderboardHasKept !== 1) throw new Error('FAIL: expected the other player to still be on the leaderboard');

  // ...and gone from All Picks (the game is locked, so this checks the
  // full per-game row, not just the future-picks summary).
  await page.click('button[data-action="set-tab"][data-tab="picks"]');
  await page.waitForTimeout(150);
  const allPicksText = await page.locator('#app').innerText();
  if (allPicksText.includes('Boot Me Team')) throw new Error('FAIL: expected the booted player\'s wager to be gone from All Picks, got: ' + allPicksText);
  console.log('PASS: the booted player\'s wager is gone from All Picks');
  if (!allPicksText.includes('Keep Me Team')) throw new Error('FAIL: expected the other player\'s wager to still be in All Picks');
  console.log('PASS: the other player\'s wager is still in All Picks');

  // The other player is unaffected.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  const keepRowStillThere = await bootCard.locator('tr', { hasText: 'Keep Me Team' }).count();
  if (keepRowStillThere !== 1) throw new Error('FAIL: expected the other player to be unaffected by booting a different one');
  console.log('PASS: the other player is unaffected');

  console.log('ALL BOOT-PLAYER TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
