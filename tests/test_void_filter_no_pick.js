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

  // --- Check "No pick" radio is gone from a game card's pick form ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);
  await page.locator('.admin-game-row').first().locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Filter Away A');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Filter Home A');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + 3 * 60 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);
  await page.locator('.admin-game-row').nth(1).locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Filter Away B');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Filter Home B');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + 3 * 60 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'filtera');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Filter Team A');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Filter');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'A');
  await page.fill('form[data-action="signup"] input[name="email"]', 'filtera@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  const cardA = page.locator('.game-card', { has: page.locator('.tname', { hasText: 'Filter Away A' }) })
    .filter({ has: page.locator('.tname', { hasText: 'Filter Home A' }) });
  const formA = cardA.locator('form[data-action="save-picks"]');

  // "No pick" radio should be gone.
  const noPickCount = await formA.locator('label.opt', { hasText: 'No pick' }).count();
  if (noPickCount !== 0) throw new Error('FAIL: expected "No pick" radio option to be removed, found ' + noPickCount);
  console.log('PASS: "No pick" radio option is gone');

  // Only 2 radios per market now (away/home), none checked by default.
  const atsRadios = formA.locator('input[name="ats-pick"]');
  if (await atsRadios.count() !== 2) throw new Error('FAIL: expected exactly 2 ats-pick radios, found ' + await atsRadios.count());
  const anyChecked = await formA.locator('input[name="ats-pick"]:checked').count();
  if (anyChecked !== 0) throw new Error('FAIL: expected no ats-pick radio checked by default, found ' + anyChecked);
  console.log('PASS: exactly 2 ATS radios, none checked by default');

  await formA.locator('input[name="ats-pick"][value="home"]').check();
  await formA.locator('input[name="ats-points"]').fill('200');
  await formA.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);

  // --- Second player wagers on game B ---
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'filterb');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Filter Team B');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Filter');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'B');
  await page.fill('form[data-action="signup"] input[name="email"]', 'filterb@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  const cardB = page.locator('.game-card', { has: page.locator('.tname', { hasText: 'Filter Away B' }) })
    .filter({ has: page.locator('.tname', { hasText: 'Filter Home B' }) });
  const formB = cardB.locator('form[data-action="save-picks"]');
  await formB.locator('input[name="ats-pick"][value="away"]').check();
  await formB.locator('input[name="ats-points"]').fill('175');
  await formB.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);

  // --- Go to admin, check the void-picks filter dropdown ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);

  // Void a Pick is collapsed by default -- expand it.
  await page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Void a pick' }) })
    .locator('button[data-action="toggle-void-picks"]').click();
  await page.waitForTimeout(150);

  const select = page.locator('select[data-action="filter-void-player"]');
  if (await select.count() !== 1) throw new Error('FAIL: expected exactly one void-pick player filter select');
  const optionTexts = await select.locator('option').allInnerTexts();
  console.log('Filter options:', optionTexts);
  if (!optionTexts.includes('All players')) throw new Error('FAIL: expected an "All players" option');
  if (!optionTexts.includes('Filter Team A') || !optionTexts.includes('Filter Team B')) {
    throw new Error('FAIL: expected both Filter Team A and Filter Team B in the dropdown, got: ' + JSON.stringify(optionTexts));
  }

  // Before filtering, both rows should show.
  let allRowsText = await page.locator('table.board tbody', { has: page.locator('button[data-action="void-pick"]') }).innerText();
  if (!allRowsText.includes('Filter Team A') || !allRowsText.includes('Filter Team B')) {
    throw new Error('FAIL: expected both players\' wagers visible with no filter, got: ' + allRowsText);
  }

  // Filter to Team A only.
  await select.selectOption({ label: 'Filter Team A' });
  await page.waitForTimeout(150);
  let filteredText = await page.locator('table.board tbody', { has: page.locator('button[data-action="void-pick"]') }).innerText();
  console.log('Filtered (Team A) rows:', filteredText.replace(/\n/g, ' | '));
  if (!filteredText.includes('Filter Team A')) throw new Error('FAIL: expected Team A\'s wager to show when filtered to Team A');
  if (filteredText.includes('Filter Team B')) throw new Error('FAIL: Team B\'s wager leaked through the Team A filter');
  console.log('PASS: filtering to a single player hides the other player\'s rows');

  // Switch back to All players.
  await select.selectOption({ label: 'All players' });
  await page.waitForTimeout(150);
  allRowsText = await page.locator('table.board tbody', { has: page.locator('button[data-action="void-pick"]') }).innerText();
  if (!allRowsText.includes('Filter Team A') || !allRowsText.includes('Filter Team B')) {
    throw new Error('FAIL: expected both players\' wagers visible again after switching back to All players');
  }
  console.log('PASS: switching back to All players restores both rows');

  console.log('ALL VOID-FILTER + NO-PICK-RADIO CHECKS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
