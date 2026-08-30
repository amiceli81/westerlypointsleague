const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

  const navigations = [];
  page.on('framenavigated', frame => navigations.push(frame.url()));

  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  cdp.on('Page.frameRequestedNavigation', evt => navigations.push(evt.url));

  // --- No players yet: email card should show the empty state, no form ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  let emailCardText = await page.evaluate(() => {
    const h3s = Array.from(document.querySelectorAll('.section-title h3'));
    const target = h3s.find(h => h.textContent.includes('Email the pool'));
    return target ? target.closest('.card').textContent : null;
  });
  console.log('Email card with zero players:', emailCardText);
  if (!emailCardText || !emailCardText.toLowerCase().includes('no players with an email')) {
    throw new Error('FAIL: expected empty-state message with zero players, got: ' + emailCardText);
  }

  // --- Sign up two players ---
  async function signup(username, teamName, email) {
    await page.click('button[data-action="set-tab"][data-tab="week"]');
    await page.waitForTimeout(150);
    await page.fill('form[data-action="signup"] input[name="username"]', username);
    await page.fill('form[data-action="signup"] input[name="teamName"]', teamName);
    await page.fill('form[data-action="signup"] input[name="firstName"]', 'Test');
    await page.fill('form[data-action="signup"] input[name="lastName"]', 'Player');
    await page.fill('form[data-action="signup"] input[name="email"]', email);
    await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
    await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
    await page.click('form[data-action="signup"] button[type="submit"]');
    await page.waitForTimeout(250);
    await page.click('button[data-action="log-out"]');
    await page.waitForTimeout(150);
  }
  await signup('emailer1', 'Team One', 'one@test.com');
  await signup('emailer2', 'Team Two', 'two@test.com');

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);

  emailCardText = await page.evaluate(() => {
    const h3s = Array.from(document.querySelectorAll('.section-title h3'));
    const target = h3s.find(h => h.textContent.includes('Email the pool'));
    return target ? target.closest('.card').textContent : null;
  });
  console.log('Email card with 2 players:', emailCardText);
  if (!emailCardText.includes('2 players') && !emailCardText.includes('all 2')) {
    throw new Error('FAIL: expected recipient count of 2 somewhere, got: ' + emailCardText);
  }

  // --- Compose and "send" (open mailto:) ---
  await page.fill('form[data-action="compose-email"] input[name="subject"]', 'Week 1 reminder');
  await page.fill('form[data-action="compose-email"] textarea[name="body"]', 'Dont forget to make your picks!');
  await page.click('form[data-action="compose-email"] button[type="submit"]');
  await page.waitForTimeout(300);

  const mailtoNav = navigations.find(u => u.startsWith('mailto:'));
  console.log('Captured mailto navigation:', mailtoNav);
  if (!mailtoNav) throw new Error('FAIL: expected a mailto: navigation, got: ' + JSON.stringify(navigations));

  const decoded = decodeURIComponent(mailtoNav);
  console.log('Decoded mailto:', decoded);
  if (!decoded.includes('one@test.com') || !decoded.includes('two@test.com')) {
    throw new Error('FAIL: expected both player emails in the mailto link, got: ' + decoded);
  }
  if (!decoded.includes('bcc=')) throw new Error('FAIL: expected emails on BCC, not To, got: ' + decoded);
  if (!decoded.includes('Week 1 reminder')) throw new Error('FAIL: expected subject in mailto link, got: ' + decoded);
  if (!decoded.includes('picks')) throw new Error('FAIL: expected body text in mailto link, got: ' + decoded);

  console.log('ALL EMAIL TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
