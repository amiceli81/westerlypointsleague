const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  // --- Anonymous visitor: Rules tab exists, is empty, and has no textarea ---
  await page.click('button[data-action="set-tab"][data-tab="rules"]');
  await page.waitForTimeout(150);
  let text = await page.evaluate(() => document.querySelector('main').innerText);
  if (!/Pool rules/.test(text)) throw new Error('FAIL: Rules tab heading not found');
  if (!/hasn.t posted any rules yet/i.test(text)) throw new Error('FAIL: expected empty-state message for anonymous visitor, got: ' + text);
  let taCount = await page.locator('textarea.rules-textarea').count();
  if (taCount !== 0) throw new Error('FAIL: anonymous visitor should not see an editable rules textarea');

  // --- Commissioner: log in, see + fill the textarea, save ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.click('button[data-action="set-tab"][data-tab="rules"]');
  await page.waitForTimeout(150);
  const rulesTextarea = page.locator('textarea[name="rulesText"]');
  if (await rulesTextarea.count() !== 1) throw new Error('FAIL: commissioner should see exactly one editable rules textarea');

  const ruleBody = 'Line one: no picking after kickoff.\nLine two: <script>alert(1)</script> stays literal text.\nLine three: ties push.';
  await rulesTextarea.fill(ruleBody);

  // Wrong PIN on the save-rules form itself should be rejected, even though
  // this browser is already unlocked as commissioner.
  await page.fill('form[data-action="save-rules"] input[name="pin"]', '0000');
  await page.click('form[data-action="save-rules"] button[type="submit"]');
  await page.waitForTimeout(200);

  // Confirm the wrong-PIN attempt never actually reached state (not just that
  // the unsubmitted DOM textarea still shows what was typed): switch away and
  // back, which re-renders the tab from state.rulesText.
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(100);
  await page.click('button[data-action="set-tab"][data-tab="rules"]');
  await page.waitForTimeout(100);
  const rejectedValue = await page.locator('textarea[name="rulesText"]').inputValue();
  if (rejectedValue === ruleBody) throw new Error('FAIL: a save-rules submission with the wrong PIN should not have been saved to state, but it was.');

  // Correct PIN should save it.
  await page.locator('textarea[name="rulesText"]').fill(ruleBody);
  await page.fill('form[data-action="save-rules"] input[name="pin"]', '1234');
  await page.click('form[data-action="save-rules"] button[type="submit"]');
  await page.waitForTimeout(200);

  const savedValue = await page.locator('textarea[name="rulesText"]').inputValue();
  if (savedValue !== ruleBody) throw new Error('FAIL: rules textarea did not retain saved text after re-render. Got: ' + savedValue);

  // Reload the underlying tab render (switch away and back) to confirm it persisted in state, not just the DOM.
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(100);
  await page.click('button[data-action="set-tab"][data-tab="rules"]');
  await page.waitForTimeout(100);
  const persisted = await page.locator('textarea[name="rulesText"]').inputValue();
  if (persisted !== ruleBody) throw new Error('FAIL: rules text did not persist across tab switch. Got: ' + persisted);

  console.log('ALL RULES TESTS PASSED (commissioner edit/save/persist checks)');
  await browser.close();

  // --- Separately: a non-commissioner viewer sees the saved text read-only,
  // with the raw <script> escaped/inert. There's no in-app "log out of
  // commissioner mode" action, and app state lives only in-memory for the
  // page's lifetime (real persistence goes through the Artifact capability,
  // not localStorage) -- so to check the read-only render path honestly we
  // build a fresh fixture with rulesText pre-seeded in its embedded state
  // and load THAT as a plain, never-logged-in visitor. ---
  const fs = require('fs');
  const html = fs.readFileSync('/tmp/test_dup_full.html', 'utf8');
  const m = html.match(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/);
  const data = JSON.parse(m[2]);
  data.rulesText = 'Line one: no picking after kickoff.\nLine two: <script>alert(1)<\/script> stays literal text.\nLine three: ties push.';
  // Match the app's own buildFullDocument() escaping (every '<' -> <)
  // so this fixture is embedded the same safe way a real save would do it.
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const patched = html.slice(0, m.index) + m[1] + safeJson + m[3] + html.slice(m.index + m[0].length);
  fs.writeFileSync('/tmp/test_rules_readonly.html', patched);

  const browser2 = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page2 = await browser2.newPage();
  page2.on('pageerror', err => console.log('PAGE EXCEPTION (readonly check):', err.message));
  await page2.goto('file:///tmp/test_rules_readonly.html');
  await page2.waitForTimeout(300);
  await page2.click('button[data-action="set-tab"][data-tab="rules"]');
  await page2.waitForTimeout(150);

  const roTaCount = await page2.locator('textarea.rules-textarea').count();
  if (roTaCount !== 0) throw new Error('FAIL: non-commissioner visitor should not see an editable textarea');
  const readOnlyText = await page2.locator('.rules-text').innerText();
  if (!readOnlyText.includes('Line one: no picking after kickoff.') || !readOnlyText.includes('Line three: ties push.')) {
    throw new Error('FAIL: read-only rules view missing expected content: ' + readOnlyText);
  }
  if (!readOnlyText.includes('<script>alert(1)</script>')) {
    throw new Error('FAIL: expected the literal <script> text to display as text, got: ' + readOnlyText);
  }
  const scriptRan = await page2.evaluate(() => window.__rulesXssRan === true);
  if (scriptRan) throw new Error('FAIL: the injected <script> actually executed -- XSS in rules rendering');

  console.log('ALL RULES TESTS PASSED (read-only view + escaping)');
  await browser2.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
