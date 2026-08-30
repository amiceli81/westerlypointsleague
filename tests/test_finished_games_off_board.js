const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));
  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  const boardCard = page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Games on the board' }) });
  const totalBefore = await page.locator('.admin-game-row').count();
  if (totalBefore < 1) throw new Error('FAIL: expected fixture games on the board');

  // Settle the first game -- it should drop off the board immediately.
  const teamA = await page.locator('.admin-game-row').nth(0).locator('strong').innerText();
  const row = page.locator('.admin-game-row', { hasText: teamA.split('@')[0].trim() });
  await row.locator('form[data-action="settle-game"] input[name="finalAway"]').fill('10');
  await row.locator('form[data-action="settle-game"] input[name="finalHome"]').fill('20');
  await row.locator('form[data-action="settle-game"] button[type="submit"]').click();
  await page.waitForTimeout(200);

  const totalAfter = await page.locator('.admin-game-row').count();
  if (totalAfter !== totalBefore - 1) {
    throw new Error('FAIL: expected the settled game to drop off the board (before=' + totalBefore + ', after=' + totalAfter + ')');
  }
  const stillThere = await page.locator('.admin-game-row', { hasText: teamA.split('@')[0].trim() }).count();
  if (stillThere !== 0) throw new Error('FAIL: settled game still shown on the board by default');
  console.log('PASS: finished game drops off the board automatically');

  const toggle = boardCard.locator('label.toggle', { hasText: 'Show finished games' });
  if (await toggle.count() !== 1) throw new Error('FAIL: expected a "Show finished games" toggle on the board card');
  if (!(await toggle.innerText()).includes('(1)')) throw new Error('FAIL: expected the toggle to count the 1 finished game');

  await toggle.locator('input[type="checkbox"]').check();
  await page.waitForTimeout(150);
  const shownAfterToggle = await page.locator('.admin-game-row', { hasText: teamA.split('@')[0].trim() }).count();
  if (shownAfterToggle !== 1) throw new Error('FAIL: expected the finished game back after checking "Show finished games"');
  const reopenBtn = page.locator('.admin-game-row', { hasText: teamA.split('@')[0].trim() }).locator('button[data-action="reopen-game"]');
  if (await reopenBtn.count() !== 1) throw new Error('FAIL: expected a Reopen button on the finished game once shown');
  console.log('PASS: "Show finished games" toggle brings finished games back, still reopenable');

  await toggle.locator('input[type="checkbox"]').uncheck();
  await page.waitForTimeout(150);
  const hiddenAgain = await page.locator('.admin-game-row', { hasText: teamA.split('@')[0].trim() }).count();
  if (hiddenAgain !== 0) throw new Error('FAIL: expected the finished game hidden again after unchecking the toggle');
  console.log('PASS: unchecking the toggle hides the finished game again');

  console.log('ALL FINISHED-GAMES-OFF-BOARD TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
