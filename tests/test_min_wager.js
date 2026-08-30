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

  // Make one fixture game open (future kickoff) via admin edit.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);
  await page.locator('.admin-game-row').first().locator('button[data-action="edit-game"]').click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="week"]', 'Min Wager Test Week');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + 3 * 60 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);

  await page.fill('form[data-action="signup"] input[name="username"]', 'minwageruser');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Min Wager Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Min');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Wager');
  await page.fill('form[data-action="signup"] input[name="email"]', 'minwager@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  const card = page.locator('.game-card').first();
  const form = card.locator('form[data-action="save-picks"]');

  const minAttr = await form.locator('input[name="ats-points"]').getAttribute('min');
  if (minAttr !== '100') throw new Error('FAIL: expected min="100" on ats-points input, got: ' + minAttr);
  console.log('PASS: pts-input min attribute is 100');

  // The form must opt out of native constraint validation, so OUR popup is
  // what actually shows on an under-minimum wager, not a generic browser bubble.
  const hasNovalidate = await form.evaluate(el => el.noValidate === true);
  if (!hasNovalidate) throw new Error('FAIL: expected the pick form to have novalidate set');
  console.log('PASS: pick form has novalidate');

  // The spinner up/down arrows should be suppressed on .pts-input elements --
  // check the app's own stylesheet for the suppression rules (getComputedStyle
  // on a ::-webkit-*-spin-button pseudo-element isn't reliably readable back
  // from headless Chromium, so this checks the rule is present instead).
  const styleText = await page.evaluate(() => document.getElementById('app-style').textContent);
  if (!/\.pts-input[^{]*\{[^}]*-moz-appearance:\s*textfield/.test(styleText)) {
    throw new Error('FAIL: expected -moz-appearance:textfield on .pts-input');
  }
  if (!/\.pts-input::-webkit-(?:outer|inner)-spin-button[\s\S]*?-webkit-appearance:\s*none/.test(styleText)) {
    throw new Error('FAIL: expected -webkit-appearance:none on .pts-input spin buttons');
  }
  console.log('PASS: pts-input spinner-arrow suppression rules are present');

  await form.locator('input[name="ats-pick"]').first().check();
  await form.locator('input[name="ats-points"]').fill('50');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  let toastText = await page.locator('#toast-root .toast').last().innerText().catch(() => null);
  console.log('Under-minimum toast text:', toastText);
  if (!toastText || !/at least 100 points/i.test(toastText)) {
    throw new Error('FAIL: expected "at least 100 points" popup, got: ' + toastText);
  }
  let stillOpenForm = await card.locator('form[data-action="save-picks"]').count();
  if (stillOpenForm !== 1) throw new Error('FAIL: the under-minimum wager should not have been saved (form should still be open)');
  console.log('PASS: under-minimum wager rejected, form remains open');

  await form.locator('input[name="ats-pick"]').first().check();
  await form.locator('input[name="ats-points"]').fill('100');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);
  const recapText = await card.locator('.recap').innerText();
  if (!/100 pts/.test(recapText)) throw new Error('FAIL: a 100-point wager should have been accepted, got: ' + recapText);
  console.log('PASS: exactly-100 wager accepted');

  console.log('ALL MIN-WAGER CHECKS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
