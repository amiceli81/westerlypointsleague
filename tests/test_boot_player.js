const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));
  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

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

  // Sign up two players -- one to boot, one to leave alone.
  await signup('bootme', 'Boot Me Team');
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);
  await signup('keepme', 'Keep Me Team');
  await page.click('button[data-action="log-out"]');
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

  // Go to the Commissioner tab and find the Boot a player card.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
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

  // The other player is unaffected.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  const keepRowStillThere = await bootCard.locator('tr', { hasText: 'Keep Me Team' }).count();
  if (keepRowStillThere !== 1) throw new Error('FAIL: expected the other player to be unaffected by booting a different one');
  console.log('PASS: the other player is unaffected');

  console.log('ALL BOOT-PLAYER TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
