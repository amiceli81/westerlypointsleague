const { chromium } = require('playwright');
const fs = require('fs');

// Same ET math as pool.html's nextMondayEightThirtyET(), replicated here so
// the test can independently predict the freeze point instead of just
// trusting the app's own computation.
function nyOffsetMinutes(ms) {
  var dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  var parts = {};
  dtf.formatToParts(new Date(ms)).forEach(function (p) { parts[p.type] = p.value; });
  var asIfUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asIfUTC - ms) / 60000);
}
function nextMondayEightThirtyET(afterMs) {
  var dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  var parts = {};
  dtf.formatToParts(new Date(afterMs)).forEach(function (p) { parts[p.type] = p.value; });
  var y = +parts.year, mo = +parts.month, d = +parts.day, h = +parts.hour, mi = +parts.minute;
  var weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  var daysAhead = (1 - weekday + 7) % 7;
  var pastCutoffToday = weekday === 1 && (h > 20 || (h === 20 && mi >= 30));
  if (daysAhead === 0 && pastCutoffToday) daysAhead = 7;
  var targetDateOnly = new Date(Date.UTC(y, mo - 1, d));
  targetDateOnly.setUTCDate(targetDateOnly.getUTCDate() + daysAhead);
  var ty = targetDateOnly.getUTCFullYear(), tmo = targetDateOnly.getUTCMonth() + 1, td = targetDateOnly.getUTCDate();
  function estimate(offsetMin) { return Date.UTC(ty, tmo - 1, td, 20, 30, 0) - offsetMin * 60000; }
  var firstPass = estimate(nyOffsetMinutes(afterMs));
  return estimate(nyOffsetMinutes(firstPass));
}

(async () => {
  const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
  const expectedFreezePoint = nextMondayEightThirtyET(tenDaysAgo);
  // A kickoff safely inside the frozen week's Tuesday-Monday window (2 days
  // before the freeze point, e.g. a Saturday if the freeze point is Monday).
  const frozenWeekKickoff = new Date(expectedFreezePoint - 2 * 24 * 60 * 60 * 1000);
  // A kickoff in the CURRENT live week (a few hours from now) -- should be
  // invisible to the report while frozen, and appear once updated.
  const liveWeekKickoff = new Date(Date.now() + 3 * 60 * 60 * 1000);

  const baseHtml = fs.readFileSync('/tmp/test_dup_full.html', 'utf8');
  const m = baseHtml.match(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/);
  const data = JSON.parse(m[2]);
  data.complianceUpdatedAt = new Date(tenDaysAgo).toISOString();
  data.games.push({
    id: 'frozen-week-game', sport: 'NFL', week: 'Frozen Compliance Week', away: 'Frozen Away', home: 'Frozen Home',
    favorite: 'home', spread: 3, total: 44, kickoff: frozenWeekKickoff.toISOString(),
    status: 'open', finalHome: null, finalAway: null, order: 9101,
  });
  data.games.push({
    id: 'live-week-game', sport: 'NFL', week: 'Live Compliance Week', away: 'Live Away', home: 'Live Home',
    favorite: 'home', spread: 3, total: 44, kickoff: liveWeekKickoff.toISOString(),
    status: 'open', finalHome: null, finalAway: null, order: 9102,
  });
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const fixtureHtml = baseHtml.slice(0, m.index) + m[1] + safeJson + m[3] + baseHtml.slice(m.index + m[0].length);
  fs.writeFileSync('/tmp/test_compliance_freeze_full.html', fixtureHtml);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));
  await page.goto('file:///tmp/test_compliance_freeze_full.html');
  await page.waitForTimeout(300);

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  const complianceCard = page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Under-wagered this week' }) });
  const cardText1 = await complianceCard.innerText();
  console.log('Compliance card (should be frozen on the old week):', cardText1.replace(/\n/g, ' | '));

  if (!/frozen as of/i.test(cardText1)) throw new Error('FAIL: expected a "Frozen as of" note with a 10-day-old complianceUpdatedAt, got: ' + cardText1);
  console.log('PASS: the report shows a "Frozen as of" note when a freeze point has passed since the last update');

  if (!cardText1.toLowerCase().includes('frozen compliance week')) throw new Error('FAIL: expected the frozen week to be shown, got: ' + cardText1);
  if (cardText1.toLowerCase().includes('live compliance week')) throw new Error('FAIL: the current live week leaked into the frozen report, got: ' + cardText1);
  console.log('PASS: while frozen, the report shows the OLD week, not the new live week');

  // Click "Update this week" -- should go live and show the new week instead.
  const updateBtn = complianceCard.locator('button[data-action="update-compliance-week"]');
  if (await updateBtn.count() !== 1) throw new Error('FAIL: expected an "Update this week" button');
  await updateBtn.click();
  await page.waitForTimeout(200);

  const cardText2 = await complianceCard.innerText();
  console.log('Compliance card (after clicking Update):', cardText2.replace(/\n/g, ' | '));
  if (/frozen as of/i.test(cardText2)) throw new Error('FAIL: expected the freeze note to disappear after clicking Update, got: ' + cardText2);
  if (!cardText2.toLowerCase().includes('live compliance week')) throw new Error('FAIL: expected the new live week to show after clicking Update, got: ' + cardText2);
  if (cardText2.toLowerCase().includes('frozen compliance week')) throw new Error('FAIL: expected the old frozen week to no longer show after updating, got: ' + cardText2);
  console.log('PASS: clicking "Update this week" unfreezes the report and shows the current live week');

  console.log('ALL COMPLIANCE-FREEZE TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
