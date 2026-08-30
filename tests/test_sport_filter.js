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

  // Force two fixture rows into a guaranteed-open NFL game and a
  // guaranteed-open NCAAF game (both with a near-future kickoff so they're
  // "current week" and not locked), since the default fixture's own
  // "current week" auto-detection doesn't reliably surface both sports at
  // once on its own.
  const futureKickoff = new Date(Date.now() + 3 * 60 * 60 * 1000);
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.locator('.admin-game-row').nth(0).locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.selectOption('form[data-action="save-game"] select[name="sport"]', 'NFL');
  await page.fill('form[data-action="save-game"] input[name="week"]', 'Filter Test Week');
  await page.fill('form[data-action="save-game"] input[name="away"]', 'SportFilter NFL Away');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'SportFilter NFL Home');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(futureKickoff));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.locator('.admin-game-row').nth(1).locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.selectOption('form[data-action="save-game"] select[name="sport"]', 'NCAAF');
  await page.fill('form[data-action="save-game"] input[name="week"]', 'Filter Test Week');
  await page.fill('form[data-action="save-game"] input[name="away"]', 'SportFilter NCAAF Away');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'SportFilter NCAAF Home');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(futureKickoff));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);

  const buttons = page.locator('.sport-filter button');
  const labels = await buttons.allInnerTexts();
  console.log('Sport filter buttons:', labels);
  if (JSON.stringify(labels) !== JSON.stringify(['All', 'NFL', 'NCAAF'])) {
    throw new Error('FAIL: expected All/NFL/NCAAF buttons, got: ' + JSON.stringify(labels));
  }

  const allActive = await page.locator('.sport-filter button.active').innerText();
  if (allActive !== 'All') throw new Error('FAIL: expected "All" to be active by default, got: ' + allActive);
  console.log('PASS: "All" active by default');

  function groupHeadings() {
    return page.locator('.week-head h2').allInnerTexts();
  }

  let headings = await groupHeadings();
  console.log('Before filter -- group headings:', headings);
  if (!headings.some(h => h.indexOf('NFL — Filter Test Week') === 0)) {
    throw new Error('FAIL: expected the NFL Filter Test Week group visible with no filter, got: ' + JSON.stringify(headings));
  }
  if (!headings.some(h => h.indexOf('NCAAF — Filter Test Week') === 0)) {
    throw new Error('FAIL: expected the NCAAF Filter Test Week group visible with no filter, got: ' + JSON.stringify(headings));
  }

  // Click NFL filter.
  await page.click('.sport-filter button[data-sport="NFL"]');
  await page.waitForTimeout(150);
  let active = await page.locator('.sport-filter button.active').innerText();
  if (active !== 'NFL') throw new Error('FAIL: expected NFL to be active after clicking it, got: ' + active);
  headings = await groupHeadings();
  console.log('After NFL filter -- group headings:', headings);
  if (headings.some(h => h.indexOf('NCAAF') === 0)) throw new Error('FAIL: an NCAAF group leaked through the NFL filter: ' + JSON.stringify(headings));
  if (!headings.some(h => h.indexOf('NFL — Filter Test Week') === 0)) throw new Error('FAIL: expected the NFL group under the NFL filter, got: ' + JSON.stringify(headings));
  console.log('PASS: NFL filter hides NCAAF groups');

  // Click NCAAF filter.
  await page.click('.sport-filter button[data-sport="NCAAF"]');
  await page.waitForTimeout(150);
  active = await page.locator('.sport-filter button.active').innerText();
  if (active !== 'NCAAF') throw new Error('FAIL: expected NCAAF to be active after clicking it, got: ' + active);
  headings = await groupHeadings();
  console.log('After NCAAF filter -- group headings:', headings);
  if (headings.some(h => h.indexOf('NFL') === 0)) throw new Error('FAIL: an NFL group leaked through the NCAAF filter: ' + JSON.stringify(headings));
  if (!headings.some(h => h.indexOf('NCAAF — Filter Test Week') === 0)) throw new Error('FAIL: expected the NCAAF group under the NCAAF filter, got: ' + JSON.stringify(headings));
  console.log('PASS: NCAAF filter hides NFL groups');

  // Switch back to All.
  await page.click('.sport-filter button[data-sport=""]');
  await page.waitForTimeout(150);
  active = await page.locator('.sport-filter button.active').innerText();
  if (active !== 'All') throw new Error('FAIL: expected "All" active again, got: ' + active);
  headings = await groupHeadings();
  console.log('After switching back to All -- group headings:', headings);
  if (!headings.some(h => h.indexOf('NFL — Filter Test Week') === 0) || !headings.some(h => h.indexOf('NCAAF — Filter Test Week') === 0)) {
    throw new Error('FAIL: expected both sports back after switching to All, got: ' + JSON.stringify(headings));
  }
  console.log('PASS: switching back to All restores both groups');

  console.log('ALL SPORT-FILTER CHECKS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
