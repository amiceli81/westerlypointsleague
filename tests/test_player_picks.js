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

  const soonKickoff = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes out -- open now; test forces it into the past later to simulate lock, so this just needs a safe margin to place picks under load
  const futureKickoff = new Date(Date.now() + 2 * 60 * 60 * 1000); // stays open

  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="admin-login"] input[name="pin"]', '1234');
  await page.click('form[data-action="admin-login"] button[type="submit"]');
  await page.waitForTimeout(150);

  const adminRows = page.locator('.admin-game-row');
  const fixtureAId = (await adminRows.nth(0).innerText()).split('\n')[0].trim();
  const fixtureBId = (await adminRows.nth(1).innerText()).split('\n')[0].trim();

  async function editGame(originalId, away, home, week, kickoff) {
    await page.locator('.admin-game-row', { hasText: originalId }).first().locator('button[data-action="edit-game"]').click();
    await page.waitForTimeout(150);
    await page.fill('form[data-action="save-game"] input[name="week"]', week);
    await page.fill('form[data-action="save-game"] input[name="away"]', away);
    await page.fill('form[data-action="save-game"] input[name="home"]', home);
    await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(kickoff));
    await page.fill('form[data-action="save-game"] input[name="spread"]', '3');
    await page.fill('form[data-action="save-game"] input[name="total"]', '44');
    await page.click('form[data-action="save-game"] button[type="submit"]');
    await page.waitForTimeout(150);
  }

  await editGame(fixtureAId, 'Locked Away', 'Locked Home', 'Player Picks Test Week', soonKickoff);
  await editGame(fixtureBId, 'Open Away', 'Open Home', 'Player Picks Test Week', futureKickoff);

  // Sign up and wager on BOTH games while both are still open.
  await page.click('button[data-action="set-tab"][data-tab="week"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="signup"] input[name="username"]', 'playerpicks');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Team Player Picks');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Player');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Picks');
  await page.fill('form[data-action="signup"] input[name="email"]', 'playerpicks@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(250);

  function lockedCard() {
    return page.locator('.game-card', { has: page.locator('.tname', { hasText: 'Locked Away' }) })
      .filter({ has: page.locator('.tname', { hasText: 'Locked Home' }) });
  }
  function openCard() {
    return page.locator('.game-card', { has: page.locator('.tname', { hasText: 'Open Away' }) })
      .filter({ has: page.locator('.tname', { hasText: 'Open Home' }) });
  }

  let form = lockedCard().locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="home"]').check();
  await form.locator('input[name="ats-points"]').fill('177');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);

  form = openCard().locator('form[data-action="save-picks"]');
  await form.locator('input[name="ats-pick"][value="away"]').check();
  await form.locator('input[name="ats-points"]').fill('133');
  await form.locator('button[type="submit"]').click();
  await page.waitForTimeout(150);

  // Simulate the "Locked" game kicking off by editing its kickoff into the past.
  await page.click('button[data-action="set-tab"][data-tab="admin"]');
  await page.waitForTimeout(150);
  await page.click('.admin-game-row:has-text("Locked Away") button[data-action="edit-game"]');
  await page.waitForTimeout(150);
  await page.fill('form[data-action="save-game"] input[name="kickoff"]', toLocalInputValue(new Date(Date.now() - 5 * 60 * 1000)));
  await page.click('form[data-action="save-game"] button[type="submit"]');
  await page.waitForTimeout(150);

  // Log out so we're viewing as an anonymous visitor, not the player themself.
  await page.click('button[data-action="log-out"]');
  await page.waitForTimeout(150);

  // --- Go to leaderboard, click the player's name ---
  await page.click('button[data-action="set-tab"][data-tab="leaderboard"]');
  await page.waitForTimeout(150);

  const playerLink = page.locator('button[data-action="view-player"]', { hasText: 'Team Player Picks' });
  if (await playerLink.count() !== 1) throw new Error('FAIL: expected exactly one leaderboard link for Team Player Picks, found ' + (await playerLink.count()));
  await playerLink.click();
  await page.waitForTimeout(150);

  const cardText = await page.evaluate(() => {
    const h3s = Array.from(document.querySelectorAll('.section-title h3'));
    const target = h3s.find(h => h.textContent.includes('Team Player Picks') && h.textContent.includes('picks'));
    return target ? target.closest('.card').textContent : null;
  });
  console.log('Player picks card text:', cardText);
  if (!cardText) throw new Error('FAIL: expected a picks card for Team Player Picks after clicking their name');
  if (!cardText.includes('Locked Away') || !cardText.includes('Locked Home')) {
    throw new Error('FAIL: expected the LOCKED game to appear in the revealed picks, got: ' + cardText);
  }
  if (cardText.includes('Open Away') || cardText.includes('Open Home')) {
    throw new Error('FAIL: the OPEN game (not started) leaked into another visitor\'s view of this player\'s picks: ' + cardText);
  }
  if (!cardText.includes('177')) throw new Error('FAIL: expected the 177-point locked-game pick amount to show, got: ' + cardText);

  // --- Close should remove the card ---
  await page.click('button[data-action="close-player-picks"]');
  await page.waitForTimeout(150);
  const stillThere = await page.locator('button[data-action="close-player-picks"]').count();
  if (stillThere !== 0) throw new Error('FAIL: expected the player picks card to close');

  console.log('ALL PLAYER-PICKS-FROM-LEADERBOARD TESTS PASSED');
  await browser.close();
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });
