const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));
  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  await page.fill('form[data-action="signup"] input[name="username"]', 'payeruser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Payer Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Pay');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Er');
  await page.fill('form[data-action="signup"] input[name="email"]', 'payer@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  const bootCard = page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Boot a player' }) });
  const row = bootCard.locator('tr', { hasText: 'Payer Team' });
  if (await row.count() !== 1) throw new Error('FAIL: expected exactly one row for Payer Team, found ' + (await row.count()));

  const paymentForm = row.locator('form[data-action="save-payment"]');
  if (await paymentForm.count() !== 1) throw new Error('FAIL: expected a save-payment form in the row');

  // Defaults are No/No/blank.
  const defaultPaid = await paymentForm.locator('select[name="paid"]').inputValue();
  const defaultBuyBack = await paymentForm.locator('select[name="buyBack"]').inputValue();
  const defaultPayType = await paymentForm.locator('input[name="payType"]').inputValue();
  if (defaultPaid !== 'no' || defaultBuyBack !== 'no' || defaultPayType !== '') {
    throw new Error('FAIL: expected defaults paid=no, buyBack=no, payType="", got: ' + JSON.stringify({ defaultPaid, defaultBuyBack, defaultPayType }));
  }
  console.log('PASS: payment fields default to No/No/blank');

  // Set paid=yes, buyBack=yes, payType text, and save.
  await paymentForm.locator('select[name="paid"]').selectOption('yes');
  await paymentForm.locator('select[name="buyBack"]').selectOption('yes');
  await paymentForm.locator('input[name="payType"]').fill('Venmo @payer');
  await paymentForm.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  // Navigate away and back (forces a fresh render from `state`, not just
  // leftover form input) to confirm the values actually saved into state.
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  const rowAfter = bootCard.locator('tr', { hasText: 'Payer Team' });
  const formAfter = rowAfter.locator('form[data-action="save-payment"]');
  const paidAfter = await formAfter.locator('select[name="paid"]').inputValue();
  const buyBackAfter = await formAfter.locator('select[name="buyBack"]').inputValue();
  const payTypeAfter = await formAfter.locator('input[name="payType"]').inputValue();
  if (paidAfter !== 'yes' || buyBackAfter !== 'yes' || payTypeAfter !== 'Venmo @payer') {
    throw new Error('FAIL: expected saved values to persist across a re-render, got: ' + JSON.stringify({ paidAfter, buyBackAfter, payTypeAfter }));
  }
  console.log('PASS: saved payment info persists across a re-render');

  console.log('ALL PLAYER-PAYMENT TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
