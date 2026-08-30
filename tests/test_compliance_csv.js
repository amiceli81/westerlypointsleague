const { chromium } = require('playwright');
function pad(n) { return String(n).padStart(2, '0'); }
function toLocalInputValue(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

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

  const teamA = await page.locator('.admin-game-row').nth(0).locator('strong').innerText();
  const row = page.locator('.admin-game-row', { hasText: teamA.split('@')[0].trim() });
  await row.locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.selectOption('form[data-action="save-game"] select[name="sport"]', 'NFL');
  await page.fill('form[data-action="save-game"] input[name="week"]', 'CSV Test Week');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + 3 * 60 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'compliancecsvuser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Compliance CSV Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Compliance');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'CSV');
  await page.fill('form[data-action="signup"] input[name="email"]', 'compliancecsv@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  // One small wager (100 pts, well under the 500-pt half-balance threshold)
  // -- flagged as under-wagered, but with a non-zero wager count to check.
  const card = page.locator('.game-card', { hasText: teamA.split('@')[0].trim() });
  const pickForm = card.locator('form[data-action="save-picks"]');
  await pickForm.locator('input[name="ats-pick"]').first().check();
  await pickForm.locator('input[name="ats-points"]').fill('100');
  await pickForm.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(200);

  const complianceCard = page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Under-wagered this week' }) });
  const exportBtn = complianceCard.locator('button[data-action="download-compliance-csv"]');
  if (await exportBtn.count() !== 1) throw new Error('FAIL: expected an "Export as CSV" button on the compliance card');
  await exportBtn.click();
  await page.waitForTimeout(200);

  const download = await page.evaluate(() => window.__lastDownload);
  if (!download) throw new Error('FAIL: downloads.save() was never called for the compliance CSV export');
  console.log('CSV filename:', download.filename);
  if (!/under-wagered.*\.csv$/i.test(download.filename)) throw new Error('FAIL: unexpected filename: ' + download.filename);

  console.log('CSV contents:\n' + download.data);
  const lines = download.data.trim().split(/\r\n/);
  if (!lines[0].startsWith('Week,')) throw new Error('FAIL: expected a "Week,..." first line, got: ' + lines[0]);
  if (!lines[0].includes('CSV Test Week')) throw new Error('FAIL: expected the current week name in the CSV, got: ' + lines[0]);
  if (!/^Team,Week-start balance,Half,Wagered,# Wagers,Short By$/.test(lines[1])) throw new Error('FAIL: unexpected CSV header row: ' + lines[1]);
  const dataRow = lines.find(l => l.includes('Compliance CSV Team'));
  if (!dataRow) throw new Error('FAIL: expected Compliance CSV Team in the CSV, got: ' + download.data);
  if (dataRow !== 'Compliance CSV Team,1000,500,100,1,400') {
    throw new Error('FAIL: expected balance=1000, half=500, wagered=100, wagerCount=1, shortBy=400 in the row, got: ' + dataRow);
  }
  console.log('PASS: compliance CSV export contains the current week and under-wagered rows');

  console.log('ALL COMPLIANCE-CSV TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
