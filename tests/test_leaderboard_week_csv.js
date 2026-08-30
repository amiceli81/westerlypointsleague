const { chromium } = require('playwright');
function pad(n) { return String(n).padStart(2, '0'); }
function toLocalInputValue(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

  // Simulate the downloads capability, capturing whatever the page tries to save.
  await page.addInitScript(() => {
    window.claude = {
      use: function(name) {
        if (name === 'downloads') {
          return Promise.resolve({
            save: function(req) { window.__lastDownload = req; return Promise.resolve({ status: 'saved' }); }
          });
        }
        return Promise.resolve(null);
      }
    };
  });

  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(200);

  // Two distinct weeks: an OLD one (settled, kickoff in the past) and a NEW
  // one (open, kickoff in the future) -- both NFL to keep this simple.
  const teamOld = await page.locator('.admin-game-row').nth(0).locator('strong').innerText();
  const teamNew = await page.locator('.admin-game-row').nth(1).locator('strong').innerText();

  async function editGame(teamText, week, hoursFromNow) {
    const row = page.locator('.admin-game-row', { hasText: teamText.split('@')[0].trim() });
    await row.locator('button[data-action="edit-game"]').click();
    await page.waitForTimeout(150);
    await page.selectOption('form[data-action="save-game"] select[name="sport"]', 'NFL');
    await page.fill('form[data-action="save-game"] input[name="week"]', week);
    await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + hoursFromNow * 60 * 60 * 1000)));
    // Fix the line deterministically: home favored by 3 -- a 30-0 final
    // makes the ATS-home pick a guaranteed win, regardless of whatever the
    // fixture's original random line was.
    await page.selectOption('form[data-action="save-game"] select[name="favorite"]', 'home');
    await page.fill('form[data-action="save-game"] input[name="spread"]', '3');
    await page.fill('form[data-action="save-game"] input[name="total"]', '44');
    await page.click('form[data-action="save-game"] button[type="submit"]');
    await page.waitForTimeout(150);
  }
  // Old week vs. new week need to fall in DIFFERENT Tuesday-Monday windows,
  // not just be a few hours apart -- otherwise they're the same "week" by
  // the app's own date-based grouping. 10 days out guarantees the next window.
  await editGame(teamOld, 'Old Leaderboard Week', 1);
  await editGame(teamNew, 'New Leaderboard Week', 10 * 24);

  // The new week's kickoff is well out from "now", so it won't show on the
  // This Week tab under the auto current-week-by-date rule -- force it
  // visible via the Week visibility tool so a pick can be placed on it.
  await page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Week visibility' }) })
    .locator('tr', { hasText: 'New Leaderboard Week' })
    .locator('button', { hasText: 'Show' })
    .click();
  await page.waitForTimeout(150);

  function cardFor(teamText) {
    return page.locator('.game-card', { hasText: teamText.split('@')[0].trim() });
  }

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'lbweekuser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'LB Week Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'LB');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Week');
  await page.fill('form[data-action="signup"] input[name="email"]', 'lbweek@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  // Wager 200 pts on the old-week game, then settle it as a WIN (favorite
  // home covers big) so its balance visibly differs from the season total.
  const formOld = cardFor(teamOld).locator('form[data-action="save-picks"]');
  await formOld.locator('input[name="ats-pick"][value="home"]').check();
  await formOld.locator('input[name="ats-points"]').fill('200');
  await formOld.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  const rowOld = page.locator('.admin-game-row', { hasText: teamOld.split('@')[0].trim() });
  await rowOld.locator('form[data-action="settle-game"] input[name="finalAway"]').fill('0');
  await rowOld.locator('form[data-action="settle-game"] input[name="finalHome"]').fill('30');
  await rowOld.locator('form[data-action="settle-game"] button[type="submit"]').click();
  await page.waitForTimeout(150);

  // Now wager 100 more pts on the NEW (still-open, future) week's game.
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  const formNew = cardFor(teamNew).locator('form[data-action="save-picks"]');
  await formNew.locator('input[name="ats-pick"]').first().check();
  await formNew.locator('input[name="ats-points"]').fill('100');
  await formNew.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);

  // Current (all weeks): total wagered 300 (200+100), balance 1000+200 (win) = 1200.
  const rowCurrent = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table.board tbody tr'));
    const tr = trs.find(tr => tr.textContent.includes('LB Week Team'));
    return tr ? Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()) : null;
  });
  console.log('Current leaderboard row:', rowCurrent);
  if (!rowCurrent || rowCurrent[3] !== '300' || rowCurrent[4] !== '1200') {
    throw new Error('FAIL: expected current standings totalWagered=300, balance=1200, got: ' + JSON.stringify(rowCurrent));
  }
  console.log('PASS: current (all-weeks) standings reflect both weeks');

  // Filter to the OLD week: should show only that week's wager (200) and
  // the balance as it stood at the end of that week (1200, since the win
  // happened in that week and nothing from the new week counts yet).
  const select = page.locator('select[data-action="filter-leaderboard-week"]');
  if (await select.count() !== 1) throw new Error('FAIL: expected a leaderboard week filter select');
  await select.selectOption({ label: 'NFL — Old Leaderboard Week' });
  await page.waitForTimeout(150);

  const rowOldWeek = await page.evaluate(() => {
    const trs = Array.from(document.querySelectorAll('table.board tbody tr'));
    const tr = trs.find(tr => tr.textContent.includes('LB Week Team'));
    return tr ? Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()) : null;
  });
  console.log('Old-week-filtered leaderboard row:', rowOldWeek);
  if (!rowOldWeek || rowOldWeek[3] !== '200' || rowOldWeek[4] !== '1200') {
    throw new Error('FAIL: expected old-week standings totalWagered=200, balance=1200, got: ' + JSON.stringify(rowOldWeek));
  }
  console.log('PASS: filtering to an earlier week shows a standings snapshot as of that point (excludes the later week\'s wager)');

  // --- Export as CSV while filtered to the old week ---
  const exportBtn = page.locator('button[data-action="download-leaderboard-csv"]');
  if (await exportBtn.count() !== 1) throw new Error('FAIL: expected an "Export as CSV" button');
  await exportBtn.click();
  await page.waitForTimeout(200);

  const download = await page.evaluate(() => window.__lastDownload);
  if (!download) throw new Error('FAIL: downloads.save() was never called for the CSV export');
  console.log('CSV filename:', download.filename);
  if (!/\.csv$/i.test(download.filename)) throw new Error('FAIL: expected a .csv filename, got: ' + download.filename);
  if (!/old-leaderboard-week/i.test(download.filename)) throw new Error('FAIL: expected the filename to reflect the selected week, got: ' + download.filename);

  console.log('CSV contents:\n' + download.data);
  const lines = download.data.trim().split(/\r\n/);
  if (!/^Rank,Player,Wins,Losses,Pushes,Total Wagered,Balance$/.test(lines[0])) {
    throw new Error('FAIL: unexpected CSV header: ' + lines[0]);
  }
  const dataRow = lines.find(l => l.includes('LB Week Team'));
  if (!dataRow) throw new Error('FAIL: expected LB Week Team in the CSV, got: ' + download.data);
  if (!dataRow.endsWith(',200,1200')) throw new Error('FAIL: expected the CSV row to match the old-week snapshot (200,1200), got: ' + dataRow);
  console.log('PASS: CSV export matches the currently-filtered (old week) standings');

  console.log('ALL LEADERBOARD-WEEK-FILTER-AND-CSV TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
