const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

  // Simulate the downloads capability being granted, capturing whatever the
  // page tries to save so we can inspect its content -- and simulate
  // 'artifact' being unavailable (null) same as the real test harness always
  // has, so save() still just toasts instead of erroring.
  await page.addInitScript(() => {
    window.claude = {
      use: function(name) {
        if (name === 'downloads') {
          return Promise.resolve({
            save: function(req) {
              window.__lastDownload = req;
              return Promise.resolve({ status: 'saved' });
            }
          });
        }
        return Promise.resolve(null);
      }
    };
  });

  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  // --- Non-commissioner: the backup card/button should not be reachable (admin tab requires login) ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  let btnCount = await page.locator('button[data-action="download-roster-backup"]').count();
  if (btnCount !== 0) throw new Error('FAIL: backup button should not be visible before commissioner login');

  // --- Commissioner login ---
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(200); // allow the downloads capability promise to resolve

  // Sign up two players so there's a non-trivial roster to back up.
  async function signup(username, teamName, first, last, email) {
    await page.click('button[data-action="set-tab"][data-tab="week"]');
    await page.waitForTimeout(150);
    await page.fill('form[data-action="signup"] input[name="username"]', username);
    await page.fill('form[data-action="signup"] input[name="teamName"]', teamName);
    await page.fill('form[data-action="signup"] input[name="firstName"]', first);
    await page.fill('form[data-action="signup"] input[name="lastName"]', last);
    await page.fill('form[data-action="signup"] input[name="email"]', email);
    await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
    await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
    await page.click('form[data-action="signup"] button[type="submit"]');
    await page.waitForTimeout(250);
    await page.click('button[data-action="log-out"]');
    await page.waitForTimeout(150);
  }
  await signup('backupuser1', 'Team Backup One', 'Back', 'Upone', 'backupuser1@test.com');
  await signup('backupuser2', 'Team Backup Two', 'Back', 'Uptwo', 'backupuser2@test.com');

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(200);

  const btnText = await page.locator('button[data-action="download-roster-backup"]').innerText();
  console.log('Button text:', btnText);
  if (!/\(\d+ account/.test(btnText)) throw new Error('FAIL: button should show an account count, got: ' + btnText);

  await page.click('button[data-action="download-roster-backup"]');
  await page.waitForTimeout(200);

  const download = await page.evaluate(() => window.__lastDownload);
  if (!download) throw new Error('FAIL: downloads.save() was never called');
  console.log('Saved filename:', download.filename);
  if (!/roster-backup.*\.json$/.test(download.filename)) throw new Error('FAIL: unexpected filename: ' + download.filename);

  const data = JSON.parse(download.data);
  console.log('Backup contents:', JSON.stringify(data, null, 2));
  if (!Array.isArray(data.accounts)) throw new Error('FAIL: backup missing accounts array');
  const backupOne = data.accounts.find(a => a.username === 'backupuser1');
  if (!backupOne) throw new Error('FAIL: backupuser1 missing from export');
  if (backupOne.teamName !== 'Team Backup One' || backupOne.email !== 'backupuser1@test.com') {
    throw new Error('FAIL: backupuser1 profile fields incorrect: ' + JSON.stringify(backupOne));
  }
  const rawStr = download.data;
  if (/passwordHash|salt/i.test(rawStr)) {
    throw new Error('FAIL: backup leaked password hash/salt fields: ' + rawStr);
  }

  const toastText = await page.locator('.toast').innerText().catch(() => null);
  console.log('Toast after save:', toastText);

  console.log('ALL ROSTER BACKUP TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
