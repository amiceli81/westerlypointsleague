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

  const kickoff = new Date(Date.now() + 2 * 60 * 60 * 1000); // 2 hours from now, definitely in "this week"

  // --- Admin: log in, then repurpose an existing seeded game (no standalone
  // "Add a game" form anymore -- games arrive via odds sync) ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.locator('.admin-game-row button[data-action="edit-game"]').first().click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="week"]', 'Compliance Test Week');
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Away Compliance');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Home Compliance');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(kickoff));
  await page.fill('form[data-action="save-game"] input[name="spread"]', '3');
  await page.fill('form[data-action="save-game"] input[name="total"]', '44');
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  // --- Sign up two players ---
  async function signup(username, teamName) {
    await page.click('button[data-action="set-tab"][data-tab="week"]');
    await page.waitForTimeout(150);
    await page.fill('form[data-action="signup"] input[name="username"]', username);
    await page.fill('form[data-action="signup"] input[name="teamName"]', teamName);
    await page.fill('form[data-action="signup"] input[name="firstName"]', 'Test');
    await page.fill('form[data-action="signup"] input[name="lastName"]', 'Player');
    await page.fill('form[data-action="signup"] input[name="email"]', username + '@test.com');
    await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
    await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
    await page.click('form[data-action="signup"] button[type="submit"]');
    await page.waitForTimeout(250);
  }

  function ourCard() {
    return page.locator('.game-card', { has: page.locator('.tname', { hasText: 'Away Compliance' }) })
      .filter({ has: page.locator('.tname', { hasText: 'Home Compliance' }) });
  }

  // Player A: wagers well over half of 1000 (500) -- 600 on ATS home.
  await signup('playera', 'Team Alpha');
  let form = ourCard().locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="home"]').check();
  await form.locator('input[name="ats-points"]').fill('600');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  // Player B: wagers only 100 (well under half of 1000).
  await signup('playerb', 'Team Bravo');
  form = ourCard().locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="away"]').check();
  await form.locator('input[name="ats-points"]').fill('100');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  // Player C: signs up but wagers nothing at all this week.
  await signup('playerc', 'Team Charlie');
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  // --- Check the compliance report as commissioner ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(200);

  const cardText = await page.evaluate(() => {
    const h3s = Array.from(document.querySelectorAll('.section-title h3'));
    const target = h3s.find(h => h.textContent.includes('Under-wagered'));
    return target ? target.closest('.card').textContent : null;
  });
  console.log('Compliance card text:\n', cardText);

  if (!cardText) throw new Error('FAIL: compliance card not found on admin tab');
  if (cardText.includes('Team Alpha')) throw new Error('FAIL: Team Alpha (600 wagered, over half) should NOT be flagged');
  if (!cardText.includes('Team Bravo')) throw new Error('FAIL: Team Bravo (100 wagered, under half) SHOULD be flagged');
  if (!cardText.includes('Team Charlie')) throw new Error('FAIL: Team Charlie (0 wagered) SHOULD be flagged');

  const rows = await page.evaluate(() => {
    const h3s = Array.from(document.querySelectorAll('.section-title h3'));
    const target = h3s.find(h => h.textContent.includes('Under-wagered'));
    const card = target.closest('.card');
    return Array.from(card.querySelectorAll('table.board tbody tr')).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
    );
  });
  console.log('Rows:', JSON.stringify(rows));

  const bravoRow = rows.find(r => r[0] === 'Team Bravo');
  const charlieRow = rows.find(r => r[0] === 'Team Charlie');
  if (!bravoRow || bravoRow[1] !== '1000' || bravoRow[2] !== '500' || bravoRow[3] !== '100') {
    throw new Error('FAIL: Team Bravo row incorrect: ' + JSON.stringify(bravoRow));
  }
  if (!charlieRow || charlieRow[1] !== '1000' || charlieRow[2] !== '500' || charlieRow[3] !== '0') {
    throw new Error('FAIL: Team Charlie row incorrect: ' + JSON.stringify(charlieRow));
  }

  // --- Status column should be sortable, defaulting to most-short-first ---
  function complianceTeamOrder() {
    return page.evaluate(() => {
      const h3s = Array.from(document.querySelectorAll('.section-title h3'));
      const target = h3s.find(h => h.textContent.includes('Under-wagered'));
      const card = target.closest('.card');
      return Array.from(card.querySelectorAll('table.board tbody tr')).map(tr => tr.querySelector('td').textContent.trim());
    });
  }

  let order = await complianceTeamOrder();
  console.log('Default compliance order (should be most-short-first, Charlie then Bravo):', order);
  if (order.indexOf('Team Charlie') === -1 || order.indexOf('Team Bravo') === -1 || order.indexOf('Team Charlie') > order.indexOf('Team Bravo')) {
    throw new Error('FAIL: expected Team Charlie (short 500) before Team Bravo (short 400) by default, got: ' + JSON.stringify(order));
  }

  const sortButton = page.locator('button[data-action="toggle-compliance-sort"]');
  if (await sortButton.count() !== 1) throw new Error('FAIL: expected a sortable Status column header');
  let arrowText = await sortButton.innerText();
  if (!arrowText.includes('▼')) throw new Error('FAIL: expected the default sort arrow to point down (descending), got: ' + arrowText);

  await sortButton.click();
  await page.waitForTimeout(150);
  arrowText = await sortButton.innerText();
  if (!arrowText.includes('▲')) throw new Error('FAIL: expected the arrow to flip to ascending after one click, got: ' + arrowText);
  order = await complianceTeamOrder();
  console.log('Ascending compliance order (should be least-short-first, Bravo then Charlie):', order);
  if (order.indexOf('Team Bravo') === -1 || order.indexOf('Team Charlie') === -1 || order.indexOf('Team Bravo') > order.indexOf('Team Charlie')) {
    throw new Error('FAIL: expected Team Bravo (short 400) before Team Charlie (short 500) after sorting ascending, got: ' + JSON.stringify(order));
  }
  console.log('PASS: clicking the Status header flips to ascending order');

  await sortButton.click();
  await page.waitForTimeout(150);
  arrowText = await sortButton.innerText();
  if (!arrowText.includes('▼')) throw new Error('FAIL: expected the arrow to flip back to descending after a second click, got: ' + arrowText);
  order = await complianceTeamOrder();
  if (order.indexOf('Team Charlie') > order.indexOf('Team Bravo')) {
    throw new Error('FAIL: expected descending order (Charlie before Bravo) after clicking again, got: ' + JSON.stringify(order));
  }
  console.log('PASS: clicking again flips back to descending order');

  console.log('ALL COMPLIANCE TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
