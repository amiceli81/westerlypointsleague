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

  const teamA = await page.locator('.admin-game-row').nth(0).locator('strong').innerText();
  const teamB = await page.locator('.admin-game-row').nth(1).locator('strong').innerText();

  async function editGame(teamText, hoursFromNow) {
    const row = page.locator('.admin-game-row', { hasText: teamText.split('@')[0].trim() });
    await row.locator('button[data-action="edit-game"]').click();
    await page.waitForTimeout(150);
    await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + hoursFromNow * 60 * 60 * 1000)));
    await page.click('form[data-action="save-game"] button[type="submit"]');
    await page.waitForTimeout(150);
  }
  await editGame(teamA, 2);
  await editGame(teamB, 3);

  function cardFor(teamText) {
    return page.locator('.game-card', { hasText: teamText.split('@')[0].trim() });
  }

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'totalwageruser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Total Wager Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Total');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Wager');
  await page.fill('form[data-action="signup"] input[name="email"]', 'totalwager@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  // Wager on game A (both markets) and game B (one market): 150 + 120 + 200 = 470 total.
  const formA = cardFor(teamA).locator('form[data-action="save-picks"]');
  await formA.locator('input[name="ats-pick"]').first().check();
  await formA.locator('input[name="ats-points"]').fill('150');
  await formA.locator('input[name="ou-pick"][value="over"]').check();
  await formA.locator('input[name="ou-points"]').fill('120');
  await formA.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  const formB = cardFor(teamB).locator('form[data-action="save-picks"]');
  await formB.locator('input[name="ats-pick"]').first().check();
  await formB.locator('input[name="ats-points"]').fill('200');
  await formB.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);
  const headers = await page.locator('table.board thead th').allInnerTexts();
  if (!headers.some(h => h.trim().toLowerCase() === 'total wagered')) {
    throw new Error('FAIL: expected a "Total wagered" column header, got: ' + JSON.stringify(headers));
  }
  console.log('PASS: leaderboard has a "Total wagered" column');

  const row = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table.board tbody tr'));
    const tr = trs.find(tr => tr.textContent.includes('Total Wager Team'));
    return tr ? Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()) : null;
  });
  console.log('Leaderboard row:', row);
  // Columns: #, Player, W-L-P, Total wagered, Balance
  if (!row || row[3] !== '470') throw new Error('FAIL: expected total wagered of 470 (150+120+200), got: ' + JSON.stringify(row));
  console.log('PASS: total wagered sums every pending wager this season (470)');

  // Void one of the picks and confirm the total drops accordingly (150 removed -> 320).
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Void a pick' }) })
    .locator('button[data-action="toggle-void-picks"]').click();
  await page.waitForTimeout(150);
  // Void specifically the 150-pt ATS pick on game A (not game B's 200-pt ATS pick).
  const voidRow = page.locator('tr', { hasText: 'Total Wager Team' })
    .filter({ hasText: teamA.split('@')[0].trim() })
    .filter({ hasText: 'ATS' });
  page.once('dialog', dialog => dialog.accept());
  await voidRow.locator('button[data-action="void-pick"]').click();
  await page.waitForTimeout(200);

  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);
  const rowAfterVoid = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table.board tbody tr'));
    const tr = trs.find(tr => tr.textContent.includes('Total Wager Team'));
    return tr ? Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()) : null;
  });
  console.log('Leaderboard row after voiding one ATS pick:', rowAfterVoid);
  if (!rowAfterVoid || rowAfterVoid[3] !== '320') throw new Error('FAIL: expected total wagered of 320 after voiding a 150-pt pick, got: ' + JSON.stringify(rowAfterVoid));
  console.log('PASS: total wagered updates after a pick is voided (320)');

  console.log('ALL LEADERBOARD-TOTAL-WAGERED TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
