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
  await page.waitForTimeout(200);

  const teamA = await page.locator('.admin-game-row').nth(0).locator('strong').innerText();
  const teamB = await page.locator('.admin-game-row').nth(1).locator('strong').innerText();

  async function editGame(teamText, week, hoursFromNow) {
    const row = page.locator('.admin-game-row', { hasText: teamText.split('@')[0].trim() });
    await row.locator('button[data-action="edit-game"]').click();
    await page.waitForTimeout(150);
    await page.selectOption('form[data-action="save-game"] select[name="sport"]', 'NFL');
    await page.fill('form[data-action="save-game"] input[name="week"]', week);
    await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + hoursFromNow * 60 * 60 * 1000)));
    await page.click('form[data-action="save-game"] button[type="submit"]');
    await page.waitForTimeout(150);
  }
  await editGame(teamA, 'Picks Week One', 1);
  await editGame(teamB, 'Picks Week Two', 10 * 24);

  await page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Week visibility' }) })
    .locator('tr', { hasText: 'Picks Week Two' })
    .locator('button', { hasText: 'Show' })
    .click();
  await page.waitForTimeout(150);

  function cardFor(teamText) {
    return page.locator('.game-card', { hasText: teamText.split('@')[0].trim() });
  }

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'ppweekuser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'PP Week Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'PP');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Week');
  await page.fill('form[data-action="signup"] input[name="email"]', 'ppweek@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  const formA = cardFor(teamA).locator('form[data-action="save-picks"]');
  await formA.locator('input[name="ats-pick"]').first().check();
  await formA.locator('input[name="ats-points"]').fill('150');
  await formA.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  const formB = cardFor(teamB).locator('form[data-action="save-picks"]');
  await formB.locator('input[name="ats-pick"]').first().check();
  await formB.locator('input[name="ats-points"]').fill('250');
  await formB.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  // Click own name on the leaderboard -- picks from BOTH weeks should show
  // by default (own-picks visibility isn't gated by kickoff, per the earlier
  // "see your own picks before the game starts" change).
  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);
  await page.locator('button[data-action="view-player"]', { hasText: 'PP Week Team' }).click();
  await page.waitForTimeout(150);

  const picksCard = page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'PP Week Team' }) });
  const allText = await picksCard.innerText();
  if (!allText.includes(teamA.split('@')[0].trim()) || !allText.includes(teamB.split('@')[0].trim())) {
    throw new Error('FAIL: expected both weeks\' games to show with no filter applied, got: ' + allText);
  }
  console.log('PASS: with no week selected, picks from every week show');

  const weekSelect = picksCard.locator('select[data-action="filter-player-picks-week"]');
  if (await weekSelect.count() !== 1) throw new Error('FAIL: expected a week filter dropdown on the player-picks card');
  const options = await weekSelect.locator('option').allInnerTexts();
  console.log('Week filter options:', JSON.stringify(options));
  if (!options.some(o => o.includes('Picks Week One')) || !options.some(o => o.includes('Picks Week Two'))) {
    throw new Error('FAIL: expected both weeks in the dropdown, got: ' + JSON.stringify(options));
  }

  // Filter to Week One -- only that game's pick should show.
  await weekSelect.selectOption({ label: 'NFL — Picks Week One' });
  await page.waitForTimeout(150);
  const weekOneText = await picksCard.innerText();
  if (!weekOneText.includes(teamA.split('@')[0].trim())) throw new Error('FAIL: expected Week One\'s game after filtering, got: ' + weekOneText);
  if (weekOneText.includes(teamB.split('@')[0].trim())) throw new Error('FAIL: Week Two\'s game leaked into the Week One filter, got: ' + weekOneText);
  if (!weekOneText.includes('150')) throw new Error('FAIL: expected the 150-pt wager in the Week One filter, got: ' + weekOneText);
  console.log('PASS: filtering to a specific week shows only that week\'s picks');

  // Switch to Week Two.
  await weekSelect.selectOption({ label: 'NFL — Picks Week Two' });
  await page.waitForTimeout(150);
  const weekTwoText = await picksCard.innerText();
  if (!weekTwoText.includes(teamB.split('@')[0].trim()) || weekTwoText.includes(teamA.split('@')[0].trim())) {
    throw new Error('FAIL: expected only Week Two\'s game after switching filters, got: ' + weekTwoText);
  }
  if (!weekTwoText.includes('250')) throw new Error('FAIL: expected the 250-pt wager in the Week Two filter, got: ' + weekTwoText);
  console.log('PASS: switching the week filter updates which week\'s picks show');

  // Back to "All weeks".
  await weekSelect.selectOption({ label: 'All weeks' });
  await page.waitForTimeout(150);
  const backToAllText = await picksCard.innerText();
  if (!backToAllText.includes(teamA.split('@')[0].trim()) || !backToAllText.includes(teamB.split('@')[0].trim())) {
    throw new Error('FAIL: expected both weeks again after switching back to All weeks, got: ' + backToAllText);
  }
  console.log('PASS: switching back to "All weeks" restores the full pick history');

  // Closing and reopening (a different lookup) resets the filter to All weeks.
  await page.click('button[data-action="close-player-picks"]');
  await page.waitForTimeout(150);
  await page.locator('button[data-action="view-player"]', { hasText: 'PP Week Team' }).click();
  await page.waitForTimeout(150);
  const reopenedSelectValue = await page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'PP Week Team' }) })
    .locator('select[data-action="filter-player-picks-week"]').inputValue();
  if (reopenedSelectValue !== '') throw new Error('FAIL: expected the week filter to reset to "All weeks" after reopening, got: ' + reopenedSelectValue);
  console.log('PASS: reopening the picks card resets the week filter');

  console.log('ALL PLAYER-PICKS-WEEK-FILTER TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
