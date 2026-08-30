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

  const futureKickoff = new Date(Date.now() + 60 * 60 * 1000);

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.locator('.admin-game-row button[data-action="edit-game"]').first().click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="week"]', 'Week 1');
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Soon Locked Away');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Soon Locked Home');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(futureKickoff));
  await page.fill('form[data-action="save-game"] input[name="spread"]', '3');
  await page.fill('form[data-action="save-game"] input[name="total"]', '44');
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  // --- Before kickoff: game shows on This Week ---
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  let bodyText = await page.evaluate(() => document.body.innerText);
  if (!bodyText.includes('Soon Locked Away')) throw new Error('FAIL: expected the open game to appear on This Week before kickoff');

  // --- Lock it (simulate kickoff passing via admin edit) ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.click('.admin-game-row:has-text("Soon Locked Away") button[data-action="edit-game"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() - 5 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  // --- After kickoff: game should be GONE from This Week by default ---
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('Soon Locked Away')) throw new Error('FAIL: locked game should no longer appear on This Week by default, but it did');
  const toggleLabel = await page.locator('.toolbar .toggle').innerText();
  console.log('Toggle label:', toggleLabel);
  if (!/show locked games/i.test(toggleLabel)) throw new Error('FAIL: expected toggle labeled "Show locked games", got: ' + toggleLabel);

  // --- Checking the toggle brings it back ---
  await page.click('input[data-action="toggle-completed"]');
  await page.waitForTimeout(150);
  bodyText = await page.evaluate(() => document.body.innerText);
  if (!bodyText.includes('Soon Locked Away')) throw new Error('FAIL: expected the locked game to reappear once "Show locked games" is checked');

  // --- Unchecking hides it again ---
  await page.click('input[data-action="toggle-completed"]');
  await page.waitForTimeout(150);
  bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('Soon Locked Away')) throw new Error('FAIL: expected the locked game to hide again after unchecking the toggle');

  // --- Game should still be fully visible/editable in All Picks and Commissioner ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  const adminBodyText = await page.evaluate(() => document.body.innerText);
  if (!adminBodyText.includes('Soon Locked Away')) throw new Error('FAIL: locked game should still be manageable from the Commissioner tab');

  console.log('ALL LOCKED-GAME-HIDDEN TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
