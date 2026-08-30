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

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);
  await page.locator('.admin-game-row').first().locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Stamp Away');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Stamp Home');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + 3 * 60 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'stampuser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Stamp Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Stamp');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'User');
  await page.fill('form[data-action="signup"] input[name="email"]', 'stamp@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  const card = page.locator('.game-card', { hasText: 'Stamp Away' });
  const form = card.locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"]').first().check();
  await form.locator('input[name="ats-points"]').fill('200');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  // The player's own recap should show when the pick was placed.
  const recapText = await card.locator('.recap').innerText();
  console.log('Recap text after placing a pick:', recapText.replace(/\n/g, ' | '));
  if (!/placed .+\d{1,2}:\d{2}/i.test(recapText)) throw new Error('FAIL: expected a "Placed <date/time>" line in the recap, got: ' + recapText);
  console.log('PASS: the player\'s own recap shows a placed timestamp');

  // Lock the game so it shows in All Picks and Void a Pick with full detail.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.locator('.admin-game-row', { hasText: 'Stamp Away' }).locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() - 60 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  // All Picks tab shows a "Placed" column.
  await page.click('button[data-action="set-tab"][data-tab="picks"]');
  await page.waitForTimeout(150);
  const allPicksHeaders = await page.locator('table.board thead th').allInnerTexts();
  if (!allPicksHeaders.some(h => h.trim().toLowerCase() === 'placed')) throw new Error('FAIL: expected a "Placed" column header in All Picks, got: ' + JSON.stringify(allPicksHeaders));
  const allPicksRow = await page.locator('table.board tbody tr', { hasText: 'Stamp Team' }).innerText();
  if (!/\d{1,2}:\d{2}/.test(allPicksRow)) throw new Error('FAIL: expected a time in the All Picks row, got: ' + allPicksRow);
  console.log('PASS: All Picks shows a "Placed" column with a timestamp');

  // Void a Pick: collapsed by default, and once expanded shows a "Placed" column.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  const voidCard = page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Void a pick' }) });
  const toggleBtn = voidCard.locator('button[data-action="toggle-void-picks"]');
  const initialLabel = await toggleBtn.innerText();
  if (initialLabel !== 'Expand') throw new Error('FAIL: expected Void a Pick to default to collapsed, got button label: ' + initialLabel);
  const hiddenText = await voidCard.locator('.empty').innerText();
  if (!/hidden/i.test(hiddenText)) throw new Error('FAIL: expected a "hidden" placeholder while Void a Pick is collapsed, got: ' + hiddenText);
  console.log('PASS: Void a Pick defaults to collapsed with a placeholder message');

  await toggleBtn.click();
  await page.waitForTimeout(150);
  const expandedHeaders = await voidCard.locator('table.board thead th').allInnerTexts();
  if (!expandedHeaders.some(h => h.trim().toLowerCase() === 'placed')) throw new Error('FAIL: expected a "Placed" column header in Void a Pick once expanded, got: ' + JSON.stringify(expandedHeaders));
  console.log('PASS: Void a Pick shows a "Placed" column once expanded');

  const collapseLabel = await toggleBtn.innerText();
  if (collapseLabel !== 'Collapse') throw new Error('FAIL: expected the toggle button to read "Collapse" once expanded, got: ' + collapseLabel);
  await toggleBtn.click();
  await page.waitForTimeout(150);
  const reCollapsedLabel = await toggleBtn.innerText();
  if (reCollapsedLabel !== 'Expand') throw new Error('FAIL: expected toggling again to re-collapse Void a Pick, got button label: ' + reCollapsedLabel);
  console.log('PASS: Void a Pick can be toggled back to collapsed');

  console.log('ALL PICK-TIMESTAMP / VOID-COLLAPSE CHECKS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
