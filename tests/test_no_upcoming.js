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

  // Push EVERY NFL game far into the future (3 weeks out) so none fall in the
  // current Tuesday-Monday window and none are in the past either. Before this
  // fix, currentWeekWindowForSport would fall back to "soonest upcoming week"
  // and show it as NFL's current week. After this fix, NFL should show
  // nothing at all on the This Week tab until its window actually arrives.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  const farFuture = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
  const nflRows = page.locator('.admin-game-row', { hasText: 'NFL' });
  const nflCount = await nflRows.count();
  console.log('NFL rows found:', nflCount);
  for (let i = 0; i < nflCount; i++) {
    // Always operate on index 0 -- editing shifts each edited row out of the
    // "NFL soon" set as its kickoff moves far out, but re-querying keeps us
    // safely targeting whatever NFL row is currently first.
    const row = page.locator('.admin-game-row', { hasText: 'NFL' }).first();
    await row.locator('button[data-action="edit-game"]').click();
    await page.waitForTimeout(120);
    await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(farFuture.getTime() + i * 60000)));
    await page.click('form[data-action="save-game"] button[type="submit"]');
    await page.waitForTimeout(120);
  }

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(200);

  const toolbarText = await page.locator('.toolbar .eyebrow').first().innerText();
  console.log('Toolbar label:', toolbarText);
  if (toolbarText.toUpperCase().includes('NFL')) {
    throw new Error('FAIL: NFL should not appear as a "current week" when all its games are weeks in the future, got label: ' + toolbarText);
  }

  const bodyText = await page.evaluate(() => document.body.innerText);
  // Sanity: NCAAF (untouched, has games in/near the real current week) should
  // still show normally -- this isn't a global break, just NFL's fallback.
  if (!bodyText.includes('NCAAF')) {
    throw new Error('FAIL: expected NCAAF games to still show on the current-week tab');
  }

  console.log('ALL NO-UPCOMING-WEEK TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
