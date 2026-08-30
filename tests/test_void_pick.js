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
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Void Away');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Void Home');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() + 3 * 60 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  // Sign up and wager on it.
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'voidtester');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Void Test Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Void');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Tester');
  await page.fill('form[data-action="signup"] input[name="email"]', 'void@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  const card = page.locator('.game-card', { has: page.locator('.tname', { hasText: 'Void Away' }) })
    .filter({ has: page.locator('.tname', { hasText: 'Void Home' }) });
  const form = card.locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="home"]').check();
  await form.locator('input[name="ats-points"]').fill('250');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(200);

  // --- Go to the admin tab and find the Void a pick card ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);

  const voidHeading = await page.locator('.section-title h3', { hasText: 'Void a pick' }).count();
  if (voidHeading !== 1) throw new Error('FAIL: expected a "Void a pick" section in the Commissioner tab');

  const voidRow = page.locator('tr', { hasText: 'Void Test Team' }).filter({ hasText: 'Void Away' });
  if (await voidRow.count() !== 1) throw new Error('FAIL: expected exactly one void-pick row for this wager, found ' + (await voidRow.count()));
  const rowText = await voidRow.innerText();
  console.log('Void-pick row:', rowText.replace(/\n/g, ' | '));
  if (!rowText.includes('250') || !rowText.toLowerCase().includes('pending')) {
    throw new Error('FAIL: expected the void row to show 250 pts and pending, got: ' + rowText);
  }

  // --- The commissioner shouldn't be able to see WHAT was picked, only
  // enough to identify and void the right wager. ---
  const voidTableHeaders = await page.locator('.card', { has: page.locator('.section-title h3', { hasText: 'Void a pick' }) })
    .locator('table.board thead th').allInnerTexts();
  if (voidTableHeaders.some(h => h.trim().toLowerCase() === 'pick')) {
    throw new Error('FAIL: expected no "Pick" column header in Void a pick, got headers: ' + JSON.stringify(voidTableHeaders));
  }
  console.log('PASS: no "Pick" column header in Void a pick');
  const voidRowCellCount = await voidRow.locator('td').count();
  if (voidRowCellCount !== 6) throw new Error('FAIL: expected 6 cells in a void-pick row (no separate pick cell), got ' + voidRowCellCount);
  console.log('PASS: void-pick row has no separate pick cell (6 cells: player, game, type, pts, result, void button)');

  // --- Cancel the confirm() dialog: the wager should survive ---
  page.once('dialog', dialog => dialog.dismiss());
  await voidRow.locator('button[data-action="void-pick"]').click();
  await page.waitForTimeout(200);
  let stillThere = await page.locator('tr', { hasText: 'Void Test Team' }).filter({ hasText: 'Void Away' }).count();
  if (stillThere !== 1) throw new Error('FAIL: dismissing the confirm() dialog should have left the wager in place');
  console.log('PASS: dismissed confirm leaves the wager intact');

  // --- Accept the confirm() dialog: the wager should be removed ---
  page.once('dialog', dialog => {
    console.log('Confirm dialog text:', dialog.message());
    dialog.accept();
  });
  await voidRow.locator('button[data-action="void-pick"]').click();
  await page.waitForTimeout(200);
  let goneRow = await page.locator('tr', { hasText: 'Void Test Team' }).filter({ hasText: 'Void Away' }).count();
  if (goneRow !== 0) throw new Error('FAIL: accepting the confirm() dialog should have removed the void-pick row');
  console.log('PASS: accepted confirm removes the wager row');

  // --- Balance should now be back to the starting balance (wager is gone) ---
  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);
  const leaderRow = await page.locator('table.board tbody tr', { hasText: 'Void Test Team' }).innerText();
  console.log('Leaderboard row after void:', leaderRow.replace(/\n/g, ' | '));
  if (leaderRow.includes('250')) throw new Error('FAIL: the voided wager should not affect the balance, got: ' + leaderRow);
  if (!/\b1000\b/.test(leaderRow)) throw new Error('FAIL: expected the balance to be back at the starting 1000, got: ' + leaderRow);

  // --- Defense-in-depth: a forged void-pick dispatch from a page that was
  // never logged in as commissioner must not go through. Build a fresh
  // fixture with a wager already seeded into state (same technique
  // test_rules.js uses), load it as a plain never-logged-in visitor, and
  // attempt the forged dispatch there. ---
  const fs = require('fs');
  const html = fs.readFileSync('/tmp/test_dup_full.html', 'utf8');
  const m = html.match(/(<script id="state-data" type="application\/json">)([\s\S]*?)(<\/script>)/);
  const data = JSON.parse(m[2]);
  const forgedGameId = 'forged-void-game';
  const forgedWagerId = 'forged-void-wager';
  data.games.push({
    id: forgedGameId, sport: 'NFL', week: 'Forged Void Week', away: 'Forged Away', home: 'Forged Home',
    favorite: 'home', spread: 3, total: 44, kickoff: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: 'open', finalHome: null, finalAway: null, order: 9101,
  });
  data.wagers.push({ id: forgedWagerId, gameId: forgedGameId, player: 'forgeduser', type: 'ATS', pick: 'home', points: 200 });
  const safeJson = JSON.stringify(data).replace(/</g, '\\u003c');
  const forgedHtml = html.slice(0, m.index) + m[1] + safeJson + m[3] + html.slice(m.index + m[0].length);
  fs.writeFileSync('/tmp/test_void_forged.html', forgedHtml);

  const browser2 = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page2 = await browser2.newPage();
  page2.on('pageerror', err => console.log('PAGE EXCEPTION (forged-void check):', err.message));
  await page2.goto('file:///tmp/test_void_forged.html');
  await page2.waitForTimeout(300);

  await page2.evaluate(function(wid) {
    var btn = document.createElement('button');
    btn.setAttribute('data-action', 'void-pick');
    btn.setAttribute('data-wager', wid);
    document.body.appendChild(btn);
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    btn.remove();
  }, forgedWagerId);
  await page2.waitForTimeout(150);

  // Now legitimately log in as commissioner and check, through the real
  // render pipeline (not a stale script tag -- state-data is never rewritten
  // into the DOM mid-session), whether the forged attempt actually removed
  // anything.
  await page2.click('button[data-action="set-tab"][data-tab="admin"]');
  await page2.waitForTimeout(150);
  await page2.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page2.click('form[data-action="admin-login"] button[type="submit"]');
  await page2.waitForTimeout(150);
  const survivedForgedVoid = await page2.locator('tr', { hasText: 'forgeduser' }).filter({ hasText: 'Forged Away' }).count();
  if (survivedForgedVoid !== 1) throw new Error('FAIL: a forged void-pick dispatch without commissioner access should not have removed the wager');
  console.log('PASS: forged void-pick without commissioner access is rejected');

  console.log('ALL VOID-PICK TESTS PASSED');
  await browser2.close();
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
