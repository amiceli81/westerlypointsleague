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

  await signup('maxwageruser', 'Max Wager Team');

  const cardA = cardFor(teamA);
  const formA = cardA.locator('form[data-action="save-picks"]');

  // Fresh signup, no wagers/adjustments -- balance is the pool's starting
  // balance (1000 in the fixture), so that's the weekly budget on the first pick.
  const maxAttr = await formA.locator('input[name="ats-points"]').getAttribute('max');
  if (maxAttr !== '1000') throw new Error('FAIL: expected max="1000" on ats-points input (starting balance), got: ' + maxAttr);
  console.log('PASS: pts-input max attribute reflects the full weekly budget (1000) before any wagers');

  const hintText = await formA.locator('.eyebrow').last().innerText();
  if (!/1000 pts left to wager this week/i.test(hintText)) throw new Error('FAIL: expected a "1000 pts left to wager this week" hint, got: ' + hintText);
  console.log('PASS: remaining-budget hint text shown');

  // Over the weekly budget is rejected.
  await formA.locator('input[name="ats-pick"]').first().check();
  await formA.locator('input[name="ats-points"]').fill('1001');
  await formA.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  let toastText = await page.locator('#toast-root .toast').last().innerText().catch(() => null);
  console.log('Over-budget toast text:', toastText);
  if (!toastText || !/only have 1000 points left/i.test(toastText)) {
    throw new Error('FAIL: expected an over-budget rejection popup, got: ' + toastText);
  }
  let stillOpenForm = await cardA.locator('form[data-action="save-picks"]').count();
  if (stillOpenForm !== 1) throw new Error('FAIL: the over-budget wager should not have been saved (form should still be open)');
  console.log('PASS: over-budget wager rejected, form remains open');

  // A PARTIAL wager (700 of the 1000 budget) on teamA is accepted...
  await formA.locator('input[name="ats-pick"]').first().check();
  await formA.locator('input[name="ats-points"]').fill('700');
  await formA.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  const recapText = await cardA.locator('.recap').innerText();
  if (!/700 pts/.test(recapText)) throw new Error('FAIL: a 700-point wager should have been accepted, got: ' + recapText);
  console.log('PASS: a wager within the weekly budget is accepted');

  // ...and it's tracked CUMULATIVELY: teamB (a DIFFERENT game, same week)
  // should now only allow the remaining 300, not another full 1000.
  const cardB = cardFor(teamB);
  const formB = cardB.locator('form[data-action="save-picks"]');
  const maxAttrBAfterA = await formB.locator('input[name="ats-points"]').getAttribute('max');
  if (maxAttrBAfterA !== '300') throw new Error('FAIL: expected max="300" on teamB after a 700-pt wager on teamA this same week, got: ' + maxAttrBAfterA);
  console.log('PASS: the weekly budget is tracked cumulatively across different games in the same week (300 left)');

  // Trying to wager more than the remaining 300 on teamB is rejected.
  await formB.locator('input[name="ats-pick"]').first().check();
  await formB.locator('input[name="ats-points"]').fill('400');
  await formB.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  const toastTextB = await page.locator('#toast-root .toast').last().innerText().catch(() => null);
  if (!toastTextB || !/only have 300 points left/i.test(toastTextB)) {
    throw new Error('FAIL: expected a "300 points left" rejection popup for teamB, got: ' + toastTextB);
  }
  console.log('PASS: a wager exceeding the remaining weekly budget (across games) is rejected');

  // Exactly the remaining 300 is accepted, using up the whole weekly budget.
  await formB.locator('input[name="ats-pick"]').first().check();
  await formB.locator('input[name="ats-points"]').fill('300');
  await formB.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  const recapTextB = await cardB.locator('.recap').innerText();
  if (!/300 pts/.test(recapTextB)) throw new Error('FAIL: a 300-point wager should have been accepted (exactly the remaining budget), got: ' + recapTextB);
  console.log('PASS: a wager for exactly the remaining budget is accepted');

  // --- A separate player, to check a SETTLED LOSS from a prior week lowers
  // the weekly budget itself (isolated from the cumulative-tracking checks
  // above, which used a different player). ---
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);
  await signup('priorlossuser', 'Prior Loss Team');

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
  const maxAttrCPlayer = await cardFor(teamA).locator('form[data-action="save-picks"] input[name="ats-points"]').getAttribute('max');
  // 1000 (start) - 600 (the settled O/U loss from the OTHER week) = 400,
  // and this player hasn't wagered anything in "Max Wager Test Week" yet.
  if (maxAttrCPlayer !== '400') throw new Error('FAIL: expected max="400" on teamA for a player with a 600-pt loss in a prior week, got: ' + maxAttrCPlayer);
  console.log('PASS: a settled loss from a prior week lowers the weekly budget itself (400)');

  console.log('ALL MAX-WAGER CHECKS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
