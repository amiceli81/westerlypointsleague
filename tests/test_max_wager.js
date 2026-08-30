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

  // Three fixture games, edited to open at distinct future kickoffs. Team
  // names for all three rows are captured BEFORE any edits, since editing
  // one row's kickoff re-sorts the whole admin games list -- a positional
  // (nth) lookup done between edits would silently land on the wrong row.
  const teamA = await page.locator('.admin-game-row').nth(0).locator('strong').innerText();
  const teamB = await page.locator('.admin-game-row').nth(1).locator('strong').innerText();
  const teamC = await page.locator('.admin-game-row').nth(2).locator('strong').innerText();

  async function editGame(teamText, week, hoursFromNow) {
    const row = page.locator('.admin-game-row', { hasText: teamText.split('@')[0].trim() });
    await row.locator('button[data-action="edit-game"]').click();
    await page.waitForTimeout(150);
    await page.fill('form[data-action="save-game"] input[name="week"]', week);
    await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + hoursFromNow * 60 * 60 * 1000)));
    await page.click('form[data-action="save-game"] button[type="submit"]');
    await page.waitForTimeout(150);
  }

  await editGame(teamA, 'Max Wager Test Week', 3);
  await editGame(teamB, 'Max Wager Test Week', 4);
  await editGame(teamC, 'Prior Settled Week', 1);

  function cardFor(teamText) {
    return page.locator('.game-card', { hasText: teamText.split('@')[0].trim() });
  }

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);

  await page.fill('form[data-action="signup"] input[name="username"]', 'maxwageruser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Max Wager Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Max');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Wager');
  await page.fill('form[data-action="signup"] input[name="email"]', 'maxwager@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  const cardA = cardFor(teamA);
  const formA = cardA.locator('form[data-action="save-picks"]');

  // Fresh signup, no wagers/adjustments -- balance is the pool's starting
  // balance (1000 in the fixture), so that's the max wager on any one pick.
  const maxAttr = await formA.locator('input[name="ats-points"]').getAttribute('max');
  if (maxAttr !== '1000') throw new Error('FAIL: expected max="1000" on ats-points input (starting balance), got: ' + maxAttr);
  console.log('PASS: pts-input max attribute reflects starting balance (1000)');

  const hintText = await formA.locator('.eyebrow').last().innerText();
  if (!/max wager: 1000 pts/i.test(hintText)) throw new Error('FAIL: expected a "Max wager: 1000 pts" hint, got: ' + hintText);
  console.log('PASS: max-wager hint text shown');

  // Over the max is rejected.
  await formA.locator('input[name="ats-pick"]').first().check();
  await formA.locator('input[name="ats-points"]').fill('1001');
  await formA.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  let toastText = await page.locator('#toast-root .toast').last().innerText().catch(() => null);
  console.log('Over-max toast text:', toastText);
  if (!toastText || !/can't wager more than 1000 points/i.test(toastText)) {
    throw new Error('FAIL: expected an over-max rejection popup, got: ' + toastText);
  }
  let stillOpenForm = await cardA.locator('form[data-action="save-picks"]').count();
  if (stillOpenForm !== 1) throw new Error('FAIL: the over-max wager should not have been saved (form should still be open)');
  console.log('PASS: over-max wager rejected, form remains open');

  // Exactly the max is accepted.
  await formA.locator('input[name="ats-pick"]').first().check();
  await formA.locator('input[name="ats-points"]').fill('1000');
  await formA.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  const recapText = await cardA.locator('.recap').innerText();
  if (!/1000 pts/.test(recapText)) throw new Error('FAIL: a 1000-point wager should have been accepted, got: ' + recapText);
  console.log('PASS: exactly-the-starting-balance wager accepted');

  // Place an O/U wager on the "prior week" game, then settle it as a loss --
  // a result from a DIFFERENT week should feed into this week's max-wager
  // cap, unlike the pending (still-unsettled) 1000-pt wager just placed above.
  const cardC = cardFor(teamC);
  const formC = cardC.locator('form[data-action="save-picks"]');
  await formC.locator('input[name="ou-pick"][value="over"]').check();
  await formC.locator('input[name="ou-points"]').fill('600');
  await formC.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  const rowC = page.locator('.admin-game-row', { hasText: teamC.split('@')[0].trim() });
  // 0-0 guarantees "over" loses (total 0 is under any real total line).
  await rowC.locator('form[data-action="settle-game"] input[name="finalAway"]').fill('0');
  await rowC.locator('form[data-action="settle-game"] input[name="finalHome"]').fill('0');
  await rowC.locator('form[data-action="settle-game"] button[type="submit"]').click();
  await page.waitForTimeout(150);

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  const cardB = cardFor(teamB);
  const formB = cardB.locator('form[data-action="save-picks"]');
  const maxAttrB = await formB.locator('input[name="ats-points"]').getAttribute('max');
  // 1000 (start) - 600 (the settled O/U loss from the OTHER week) = 400.
  // The pending 1000-pt ATS wager on teamA this SAME week doesn't count
  // (still unsettled), so this isolates the prior-week loss's effect.
  if (maxAttrB !== '400') throw new Error('FAIL: expected max="400" on teamB after a 600-pt loss in a prior week, got: ' + maxAttrB);
  console.log('PASS: max wager reflects a settled loss from a prior week (400)');

  console.log('ALL MAX-WAGER CHECKS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
