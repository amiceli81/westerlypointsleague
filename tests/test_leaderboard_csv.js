const { chromium } = require('playwright');
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

  await page.fill('form[data-action="signup"] input[name="username"]', 'lbcsvuser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'LB CSV Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'LB');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'CSV');
  await page.fill('form[data-action="signup"] input[name="email"]', 'lbcsv@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);

  // No week filter -- just a plain "export what's shown" button.
  const weekSelectCount = await page.locator('select[data-action="filter-leaderboard-week"]').count();
  if (weekSelectCount !== 0) throw new Error('FAIL: expected no leaderboard week filter select');
  console.log('PASS: no week filter on the leaderboard');

  const exportBtn = page.locator('button[data-action="download-leaderboard-csv"]');
  if (await exportBtn.count() !== 1) throw new Error('FAIL: expected an "Export as CSV" button');
  await exportBtn.click();
  await page.waitForTimeout(200);

  const download = await page.evaluate(() => window.__lastDownload);
  if (!download) throw new Error('FAIL: downloads.save() was never called');
  console.log('CSV filename:', download.filename);
  if (!/leaderboard.*\.csv$/i.test(download.filename)) throw new Error('FAIL: unexpected filename: ' + download.filename);

  console.log('CSV contents:\n' + download.data);
  const lines = download.data.trim().split(/\r\n/);
  if (!/^Rank,Player,Wins,Losses,Pushes,Balance$/.test(lines[0])) {
    throw new Error('FAIL: unexpected CSV header: ' + lines[0]);
  }
  const dataRow = lines.find(l => l.includes('LB CSV Team'));
  if (!dataRow) throw new Error('FAIL: expected LB CSV Team in the CSV, got: ' + download.data);
  if (!dataRow.endsWith(',1000')) throw new Error('FAIL: expected the starting balance 1000 in the row, got: ' + dataRow);
  console.log('PASS: leaderboard CSV export matches what\'s displayed');

  console.log('ALL LEADERBOARD-CSV TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
