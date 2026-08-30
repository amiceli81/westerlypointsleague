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

  // --- Expanded by default: rows visible, button says Collapse ---
  const rowCountBefore = await page.locator('.admin-game-row').count();
  console.log('Rows visible by default:', rowCountBefore);
  if (rowCountBefore === 0) throw new Error('FAIL: expected games to be visible by default');
  let btnText = await page.locator('button[data-action="toggle-games-list"]').innerText();
  console.log('Toggle button text (expanded state):', btnText);
  if (!/collapse/i.test(btnText)) throw new Error('FAIL: expected button to say "Collapse" while expanded, got: ' + btnText);

  // --- Click to collapse ---
  await page.click('button[data-action="toggle-games-list"]');
  await page.waitForTimeout(150);
  const rowCountAfterCollapse = await page.locator('.admin-game-row').count();
  console.log('Rows visible after collapsing:', rowCountAfterCollapse);
  if (rowCountAfterCollapse !== 0) throw new Error('FAIL: expected 0 game rows visible once collapsed, got ' + rowCountAfterCollapse);
  const hiddenMsg = await page.locator('.card', { hasText: 'Games on the board' }).innerText();
  if (!hiddenMsg.toLowerCase().includes('hidden')) throw new Error('FAIL: expected a "hidden" summary message when collapsed, got: ' + hiddenMsg);
  btnText = await page.locator('button[data-action="toggle-games-list"]').innerText();
  console.log('Toggle button text (collapsed state):', btnText);
  if (!/expand/i.test(btnText)) throw new Error('FAIL: expected button to say "Expand" while collapsed, got: ' + btnText);

  // --- Collapsed state should SURVIVE an unrelated render (e.g. settling a game elsewhere) ---
  // Expand again, settle a game, and confirm state carries -- then collapse and
  // confirm an unrelated action (switching tabs and back) preserves collapse too.
  await page.click('button[data-action="toggle-games-list"]');
  await page.waitForTimeout(150);
  await page.click('button[data-action="toggle-games-list"]'); // back to collapsed
  await page.waitForTimeout(150);
  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(100);
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(100);
  const rowCountAfterTabSwitch = await page.locator('.admin-game-row').count();
  console.log('Rows visible after tab switch (should stay collapsed):', rowCountAfterTabSwitch);
  if (rowCountAfterTabSwitch !== 0) throw new Error('FAIL: collapsed state did not survive a tab switch / re-render');

  // --- Expand again for sanity ---
  await page.click('button[data-action="toggle-games-list"]');
  await page.waitForTimeout(150);
  const rowCountAfterReExpand = await page.locator('.admin-game-row').count();
  console.log('Rows visible after re-expanding:', rowCountAfterReExpand);
  if (rowCountAfterReExpand === 0) throw new Error('FAIL: expected games to reappear after expanding again');

  console.log('ALL COLLAPSE TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
