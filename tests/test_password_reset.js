const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));
  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  // Sign up a user.
  await page.fill('form[data-action="signup"] input[name="username"]', 'resetuser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Reset Test Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Reset');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'User');
  await page.fill('form[data-action="signup"] input[name="email"]', 'reset@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'oldpassword1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'oldpassword1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  // Log out.
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  // Switch to login tab, click Forgot password.
  await page.click('button[data-action="auth-mode"][data-mode="login"]');
  await page.waitForTimeout(150);
  await page.click('button[data-action="auth-mode"][data-mode="reset"]');
  await page.waitForTimeout(150);

  // Wrong email should be rejected.
  await page.fill('form[data-action="verify-reset"] input[name="username"]', 'resetuser');
  await page.fill('form[data-action="verify-reset"] input[name="email"]', 'wrong@test.com');
  await page.click('form[data-action="verify-reset"] button[type="submit"]');
  await page.waitForTimeout(200);
  let ta = await page.locator('form[data-action="reset-password"]').count();
  if (ta !== 0) throw new Error('FAIL: wrong email should not advance to reset-password step');
  console.log('PASS: wrong email correctly rejected');

  // Correct email (case/whitespace-insensitive) should advance.
  await page.fill('form[data-action="verify-reset"] input[name="email"]', '  RESET@Test.com  ');
  await page.click('form[data-action="verify-reset"] button[type="submit"]');
  await page.waitForTimeout(200);
  ta = await page.locator('form[data-action="reset-password"]').count();
  if (ta !== 1) throw new Error('FAIL: correct (case-insensitive) email should advance to reset-password step');
  console.log('PASS: correct email advances to reset step');

  // Mismatched new passwords rejected.
  await page.fill('form[data-action="reset-password"] input[name="password"]', 'newpassword1');
  await page.fill('form[data-action="reset-password"] input[name="confirmPassword"]', 'newpassword2');
  await page.click('form[data-action="reset-password"] button[type="submit"]');
  await page.waitForTimeout(200);
  ta = await page.locator('form[data-action="reset-password"]').count();
  if (ta !== 1) throw new Error('FAIL: mismatched passwords should not have completed the reset');

  // Matching new password completes the reset and returns to login.
  await page.fill('form[data-action="reset-password"] input[name="password"]', 'newpassword1');
  await page.fill('form[data-action="reset-password"] input[name="confirmPassword"]', 'newpassword1');
  await page.click('form[data-action="reset-password"] button[type="submit"]');
  await page.waitForTimeout(300);
  const onLogin = await page.locator('form[data-action="login"]').count();
  if (onLogin !== 1) throw new Error('FAIL: should return to the login form after a successful reset');
  console.log('PASS: reset completed and returned to login');

  // Old password should no longer work; new password should.
  await page.fill('form[data-action="login"] input[name="username"]', 'resetuser');
  await page.fill('form[data-action="login"] input[name="password"]', 'oldpassword1');
  await page.click('form[data-action="login"] button[type="submit"]');
  await page.waitForTimeout(200);
  let loggedIn = await page.locator('.who-chip').count();
  if (loggedIn !== 0) throw new Error('FAIL: old password should no longer work after reset');
  console.log('PASS: old password rejected after reset');

  await page.fill('form[data-action="login"] input[name="username"]', 'resetuser');
  await page.fill('form[data-action="login"] input[name="password"]', 'newpassword1');
  await page.click('form[data-action="login"] button[type="submit"]');
  await page.waitForTimeout(200);
  loggedIn = await page.locator('.who-chip').count();
  if (loggedIn !== 1) throw new Error('FAIL: new password should work after reset');
  console.log('PASS: new password works after reset');

  console.log('ALL RESET-PASSWORD CHECKS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
