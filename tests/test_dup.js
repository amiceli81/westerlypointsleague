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

  // Give the game a future kickoff (rather than none) so we can also exercise
  // the "picks hidden until kickoff" behavior later in this same test.
  const futureKickoff = new Date(Date.now() + 60 * 60 * 1000);

  // --- Admin: log in, then repurpose an existing seeded game as our fixture ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.locator('.admin-game-row button[data-action="edit-game"]').first().click();
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="week"]', 'Week 1');
  await page.fill('form[data-action="save-game"] input[name="away"]', 'Away Team');
  await page.fill('form[data-action="save-game"] input[name="home"]', 'Home Team');
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(futureKickoff));
  await page.fill('form[data-action="save-game"] input[name="spread"]', '3');
  await page.fill('form[data-action="save-game"] input[name="total"]', '44');
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  // --- Sign up a player ---
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'duptester');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Dup Testers');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Dup');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Tester');
  await page.fill('form[data-action="signup"] input[name="email"]', 'dup@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(300);

  // Many real seeded games are also unlocked, so scope every action to the specific
  // card we created (identified by its unique team names) rather than a bare selector.
  const card = page.locator('.game-card', { has: page.locator('.tname', { hasText: 'Away Team' }) })
    .filter({ has: page.locator('.tname', { hasText: 'Home Team' }) });

  async function reload() {
    await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
    await page.waitForTimeout(80);
    await page.click('button[data-action="set-tab"][data-tab="week"]');
    await page.waitForTimeout(80);
  }

  // --- Submit ATS: home, 50 pts ---
  let form = card.locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="home"]').check();
  await form.locator('input[name="ats-points"]').fill('150');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);
  await reload();

  let cardText = await card.innerText();
  console.log('After submitting ATS home/150:', cardText.replace(/\n/g, ' | '));
  if (!cardText.includes('Home Team') || !cardText.includes('150')) {
    throw new Error('FAIL: expected ATS recap to show Home Team / 150, got: ' + cardText);
  }
  if (!cardText.toLowerCase().includes("can't be changed") && !cardText.toLowerCase().includes('locked in')) {
    throw new Error('FAIL: expected a "locked in" notice after submitting ATS, got: ' + cardText);
  }
  // The ATS market must no longer be editable -- no radio inputs for it at all.
  let atsRadioCount = await card.locator('input[name="ats-pick"]').count();
  if (atsRadioCount !== 0) throw new Error('FAIL: expected ATS to have no editable inputs once submitted, found ' + atsRadioCount);
  // OU hasn't been touched yet, so it should still be editable.
  let ouRadioCount = await card.locator('input[name="ou-pick"]').count();
  if (ouRadioCount === 0) throw new Error('FAIL: expected OU to still be editable (untouched market)');

  // --- Defense-in-depth: even a raw forged submission targeting ATS again
  // must not change the already-submitted pick. The UI no longer offers a
  // way to do this, so we inject a form directly and dispatch a real submit
  // event (the app listens at the document level, not per-form). ---
  const gameId = await form.getAttribute('data-game');
  await page.evaluate(function(gid) {
    var f = document.createElement('form');
    f.setAttribute('data-action', 'save-picks');
    f.setAttribute('data-game', gid);
    var p = document.createElement('input'); p.name = 'ats-pick'; p.value = 'away'; f.appendChild(p);
    var pts = document.createElement('input'); pts.name = 'ats-points'; pts.value = '999'; f.appendChild(pts);
    document.body.appendChild(f);
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    f.remove();
  }, gameId);
  await page.waitForTimeout(150);
  await reload();
  cardText = await card.innerText();
  console.log('After forged ATS-change attempt:', cardText.replace(/\n/g, ' | '));
  if (!cardText.includes('Home Team') || !cardText.includes('150')) {
    throw new Error('FAIL: forged resubmission changed the already-locked ATS pick: ' + cardText);
  }
  if (cardText.includes('999')) throw new Error('FAIL: forged resubmission was applied (999 pts leaked through): ' + cardText);

  // --- Now submit OU: over, 15 pts (still allowed -- untouched market) ---
  form = card.locator('form[data-action="save-picks"]');
  await form.locator('input[name="ou-pick"][value="over"]').check();
  await form.locator('input[name="ou-points"]').fill('115');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);
  await reload();

  cardText = await card.innerText();
  console.log('After submitting OU over/115:', cardText.replace(/\n/g, ' | '));
  if (!cardText.includes('Over') || !cardText.includes('115')) {
    throw new Error('FAIL: expected OU recap to show Over / 115, got: ' + cardText);
  }
  // Both markets are now submitted -- the entire form should be gone.
  const anyRadios = await card.locator('input[type="radio"]').count();
  if (anyRadios !== 0) throw new Error('FAIL: expected no editable inputs left once both ATS and OU are submitted, found ' + anyRadios);

  // --- Defense-in-depth again, this time on OU, now that both are locked ---
  await page.evaluate(function(gid) {
    var f = document.createElement('form');
    f.setAttribute('data-action', 'save-picks');
    f.setAttribute('data-game', gid);
    var p = document.createElement('input'); p.name = 'ou-pick'; p.value = 'under'; f.appendChild(p);
    var pts = document.createElement('input'); pts.name = 'ou-points'; pts.value = '500'; f.appendChild(pts);
    document.body.appendChild(f);
    f.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    f.remove();
  }, gameId);
  await page.waitForTimeout(150);
  await reload();
  cardText = await card.innerText();
  console.log('After forged OU-change attempt:', cardText.replace(/\n/g, ' | '));
  if (!cardText.includes('Over') || !cardText.includes('115')) {
    throw new Error('FAIL: forged resubmission changed the already-locked OU pick: ' + cardText);
  }
  if (cardText.includes('500') || cardText.includes('Under')) {
    throw new Error('FAIL: forged OU resubmission was applied: ' + cardText);
  }

  function picksCardText() {
    return page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.card'));
      const c = cards.find(c => {
        const h3 = c.querySelector('.section-title h3');
        return h3 && h3.textContent.includes('Away Team') && h3.textContent.includes('Home Team');
      });
      return c ? c.textContent : null;
    });
  }

  function futurePicksRows() {
    return page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('.card'));
      const c = cards.find(c => {
        const h3 = c.querySelector('.section-title h3');
        return h3 && h3.textContent.trim() === 'Pending Picks';
      });
      if (!c) return null;
      return Array.from(c.querySelectorAll('table.board tbody tr')).map(tr =>
        Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
      );
    });
  }

  // --- A SECOND player wagers on the same still-open game ---
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'duptester2');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Testers Squad B');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Dup');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Two');
  await page.fill('form[data-action="signup"] input[name="email"]', 'dup2@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(250);
  form = card.locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="away"]').check();
  await form.locator('input[name="ats-points"]').fill('120');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);

  // --- Viewed AS the second player: no per-game card at all before kickoff
  // (not even their own), only the "Future picks" count-by-player summary,
  // which never names a game or what was picked ---
  await page.click('button[data-action="set-tab"][data-tab="picks"]');
  await page.waitForTimeout(150);
  let ourCardText = await picksCardText();
  console.log('All Picks (as duptester2) BEFORE kickoff -- per-game card:', ourCardText);
  if (ourCardText !== null) {
    throw new Error('FAIL: expected no per-game card at all before kickoff, got: ' + ourCardText);
  }
  let futureRows = await futurePicksRows();
  console.log('Future picks rows (as duptester2):', JSON.stringify(futureRows));
  if (!futureRows) throw new Error('FAIL: expected a "Pending Picks" summary card to exist');
  // Dup Testers has 2 pending picks (ATS + OU) on this game; Testers Squad B
  // (duptester2) has 1 (ATS only) -- both counts, no game names or picks.
  const dupRow = futureRows.find(r => r[0] === 'Dup Testers');
  const squadBRow = futureRows.find(r => r[0] === 'Testers Squad B');
  if (!dupRow || dupRow[1] !== '2') throw new Error('FAIL: expected Dup Testers to show 2 future picks, got: ' + JSON.stringify(dupRow));
  if (!squadBRow || squadBRow[1] !== '1') throw new Error('FAIL: expected Testers Squad B to show 1 future pick, got: ' + JSON.stringify(squadBRow));
  const futureText = futureRows.map(r => r.join(' ')).join(' | ');
  if (/Away Team|Home Team/.test(futureText)) throw new Error('FAIL: the future-picks summary should never name a game, got: ' + futureText);

  // --- Viewed as a logged-out visitor: same story -- no per-game card, but
  // the future-picks counts (counts only, no picks) are visible to anyone ---
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);
  await page.click('button[data-action="set-tab"][data-tab="picks"]');
  await page.waitForTimeout(150);
  ourCardText = await picksCardText();
  console.log('All Picks (logged out) BEFORE kickoff -- per-game card:', ourCardText);
  if (ourCardText !== null) {
    throw new Error('FAIL: expected no per-game card at all for a still-open game for a logged-out visitor, got: ' + ourCardText);
  }
  futureRows = await futurePicksRows();
  console.log('Future picks rows (logged out):', JSON.stringify(futureRows));
  if (!futureRows || !futureRows.find(r => r[0] === 'Dup Testers' && r[1] === '2') || !futureRows.find(r => r[0] === 'Testers Squad B' && r[1] === '1')) {
    throw new Error('FAIL: expected the future-picks counts to still show for a logged-out visitor, got: ' + JSON.stringify(futureRows));
  }

  // --- After kickoff (simulated via admin edit), picks SHOULD be visible to everyone ---
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.click('.admin-game-row:has-text("Away Team") button[data-action="edit-game"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() - 5 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  await page.click('button[data-action="set-tab"][data-tab="picks"]');
  await page.waitForTimeout(150);
  const rowsAfter = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('.card'));
    const c = cards.find(c => {
      const h3 = c.querySelector('.section-title h3');
      return h3 && h3.textContent.includes('Away Team') && h3.textContent.includes('Home Team');
    });
    if (!c) return null;
    return Array.from(c.querySelectorAll('table.board tbody tr')).map(tr =>
      Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim())
    );
  });
  console.log('All Picks rows AFTER kickoff:', JSON.stringify(rowsAfter));
  if (!rowsAfter || rowsAfter.length !== 3) throw new Error('FAIL: expected 3 revealed rows (duptester ATS+OU, duptester2 ATS) after kickoff, got ' + JSON.stringify(rowsAfter));
  const atsRow = rowsAfter.find(r => r[0] === 'Dup Testers' && r[1] === 'ATS');
  const ouRow = rowsAfter.find(r => r[0] === 'Dup Testers' && r[1] === 'OU');
  const secondAtsRow = rowsAfter.find(r => r[0] === 'Testers Squad B');
  if (!atsRow || !atsRow[2].includes('Home Team') || atsRow[3] !== '150') throw new Error('FAIL: revealed ATS row wrong: ' + JSON.stringify(atsRow));
  if (!ouRow || !ouRow[2].includes('Over') || ouRow[3] !== '115') throw new Error('FAIL: revealed OU row wrong: ' + JSON.stringify(ouRow));
  if (!secondAtsRow || !secondAtsRow[2].includes('Away Team') || secondAtsRow[3] !== '120') throw new Error('FAIL: revealed second player\'s ATS row wrong: ' + JSON.stringify(secondAtsRow));

  console.log('ALL TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
