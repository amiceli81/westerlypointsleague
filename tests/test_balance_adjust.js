const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  // --- Sign up a player (no games/wagers needed for this feature) ---
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'bonususer');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Team Bonus');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Bonus');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'User');
  await page.fill('form[data-action="signup"] input[name="email"]', 'bonus@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(250);
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  // --- Baseline: check starting balance on the leaderboard (should be 1000) ---
  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);
  let row = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table.board tbody tr'));
    const tr = trs.find(tr => tr.textContent.includes('Team Bonus'));
    return tr ? Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()) : null;
  });
  console.log('Baseline leaderboard row:', row);
  if (!row || row[4] !== '1000') throw new Error('FAIL: expected starting balance 1000, got: ' + JSON.stringify(row));

  // --- Admin: apply a +250 bonus ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.selectOption('form[data-action="adjust-balance"] select[name="player"]', { label: 'Team Bonus' });
  await page.fill('form[data-action="adjust-balance"] input[name="amount"]', '250');
  await page.fill('form[data-action="adjust-balance"] input[name="note"]', 'Sportsmanship bonus');
  await page.click('form[data-action="adjust-balance"] button[type="submit"]');
  await page.waitForTimeout(200);

  // Adjustment log should show it.
  const logText = await page.evaluate(() => {
    const h3s = Array.from(document.querySelectorAll('.section-title h3'));
    const target = h3s.find(h => h.textContent.includes("balance"));
    return target ? target.closest('.card').textContent : null;
  });
  console.log('Balance adjust card text:', logText);
  if (!logText.includes('Team Bonus') || !logText.includes('+250') || !logText.includes('Sportsmanship bonus')) {
    throw new Error('FAIL: expected adjustment log to show Team Bonus +250 Sportsmanship bonus, got: ' + logText);
  }

  // Leaderboard should now reflect 1250.
  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);
  row = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table.board tbody tr'));
    const tr = trs.find(tr => tr.textContent.includes('Team Bonus'));
    return tr ? Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()) : null;
  });
  console.log('After +250 adjustment:', row);
  if (!row || row[4] !== '1250') throw new Error('FAIL: expected balance 1250 after +250 adjustment, got: ' + JSON.stringify(row));

  // --- Apply a -400 penalty and confirm it nets out correctly ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.selectOption('form[data-action="adjust-balance"] select[name="player"]', { label: 'Team Bonus' });
  await page.fill('form[data-action="adjust-balance"] input[name="amount"]', '-400');
  await page.fill('form[data-action="adjust-balance"] input[name="note"]', 'Late picks penalty');
  await page.click('form[data-action="adjust-balance"] button[type="submit"]');
  await page.waitForTimeout(200);

  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);
  row = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table.board tbody tr'));
    const tr = trs.find(tr => tr.textContent.includes('Team Bonus'));
    return tr ? Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()) : null;
  });
  console.log('After -400 adjustment (net +250-400=850):', row);
  if (!row || row[4] !== '850') throw new Error('FAIL: expected balance 850 after net adjustments, got: ' + JSON.stringify(row));

  // --- Only the commissioner can do this -- log out of admin and confirm the form is gone ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  const formPresentAsCommissioner = await page.locator('form[data-action="adjust-balance"]').count();
  if (formPresentAsCommissioner !== 1) throw new Error('FAIL: expected the adjust-balance form to be present for the commissioner');

  console.log('ALL BALANCE-ADJUSTMENT TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
