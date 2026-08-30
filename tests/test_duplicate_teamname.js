const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));
  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

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

  // First signup with a given team name succeeds.
  await signup('teamowner1', 'The Champs');
  let loggedIn = await page.locator('.who-chip .name').count();
  if (loggedIn !== 1) throw new Error('FAIL: first signup with team name "The Champs" should have succeeded');
  console.log('PASS: first signup with a unique team name succeeds');

  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  // Second signup with the exact same team name (different username) is rejected.
  await signup('teamowner2', 'The Champs');
  loggedIn = await page.locator('.who-chip .name').count();
  if (loggedIn !== 0) throw new Error('FAIL: duplicate team name "The Champs" should have been rejected');
  const bodyText1 = await page.evaluate(() => document.body.innerText);
  if (!/team name is already taken/i.test(bodyText1)) throw new Error('FAIL: expected a duplicate team name toast');
  console.log('PASS: exact-duplicate team name is rejected');

  // Case-insensitive / whitespace-insensitive duplicate is also rejected.
  await signup('teamowner3', '  the champs  ');
  loggedIn = await page.locator('.who-chip .name').count();
  if (loggedIn !== 0) throw new Error('FAIL: case/whitespace-insensitive duplicate team name should have been rejected');
  console.log('PASS: case/whitespace-insensitive duplicate team name is rejected');

  // A genuinely different team name still works fine.
  await signup('teamowner4', 'The Underdogs');
  loggedIn = await page.locator('.who-chip .name').count();
  if (loggedIn !== 1) throw new Error('FAIL: a distinct team name should still be allowed');
  console.log('PASS: a distinct team name is still allowed');

  await browser.close();
  console.log('ALL DUPLICATE TEAM NAME TESTS PASSED');
})().catch(err => { console.error(err); process.exit(1); });
