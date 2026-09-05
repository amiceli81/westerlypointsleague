const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  page.on('pageerror', err => console.log('PAGE EXCEPTION:', err.message));

  // Mock 'artifact' with a real publish() so we can capture and inspect the
  // full serialized document on every save -- none of the existing tests do
  // this (they all mock artifact as unavailable), so this is the first test
  // to actually exercise buildFullDocument()'s real output.
  await page.addInitScript(() => {
    window.claude = {
      use: function(name) {
        if (name === 'artifact') {
          return Promise.resolve({
            publish: function(html) {
              window.__lastPublish = html;
              window.__publishCount = (window.__publishCount || 0) + 1;
              return Promise.resolve({ status: 'ok' });
            }
          });
        }
        return Promise.resolve(null);
      }
    };
  });

  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);

  // --- 1. Migration: pool.html's own bundled state-data is the legacy bare
  // shape (75 real-looking games, no `leagues` key) -- a fresh load should
  // auto-migrate it into exactly one league and auto-enter it (no picker).
  const pickerVisibleAtStart = await page.locator('[data-action="create-league"]').count();
  if (pickerVisibleAtStart !== 0) throw new Error('FAIL: picker should not show when exactly one league exists');
  const titleText = await page.locator('h1.pool-title').innerText();
  if (!titleText.includes('The Westerly Points League')) throw new Error('FAIL: expected auto-entered league title, got: ' + titleText);
  const gameCount = await page.locator('.admin-game-row, .game-card').count();
  console.log('games visible after auto-migrate+enter (This Week tab, current week only):', gameCount);
  console.log('PASS: fresh load auto-migrates the legacy shape and auto-enters the single league');

  // --- 2. Trigger a save (sign up a player) and inspect the published shape ---
  await page.fill('form[data-action="signup"] input[name="username"]', 'league1user');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'League One Team');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'One');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Player');
  await page.fill('form[data-action="signup"] input[name="email"]', 'one@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);

  let published = await page.evaluate(() => window.__lastPublish);
  if (!published) throw new Error('FAIL: expected a publish() call after signup');
  let parsePublished = (html) => {
    const m = html.match(/<script id="state-data" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) throw new Error('FAIL: published document has no state-data script tag');
    return JSON.parse(m[1]);
  };
  let rootAfterSignup = parsePublished(published);
  if (!Array.isArray(rootAfterSignup.leagues)) throw new Error('FAIL: published root is not {leagues:[...]} shaped: ' + JSON.stringify(rootAfterSignup).slice(0, 300));
  if (rootAfterSignup.leagues.length !== 1) throw new Error('FAIL: expected exactly 1 league after signup, got ' + rootAfterSignup.leagues.length);
  const league1 = rootAfterSignup.leagues[0];
  if (league1.id !== 'original') throw new Error('FAIL: migrated legacy league should keep the fixed id "original", got: ' + league1.id);
  const requiredFields = ['poolName','startingBalance','commissionerPin','players','games','wagers','announcements','adjustments','weekVisibility','rulesText','complianceUpdatedAt'];
  for (const f of requiredFields) {
    if (!(f in league1.data)) throw new Error('FAIL: league.data missing field "' + f + '"');
  }
  if (!league1.data.players.some(p => p.username === 'league1user')) throw new Error('FAIL: signed-up player not found in published league 1 data');
  console.log('PASS: published document is {leagues:[{id:"original", data:{...}}]}-shaped with the new player, all fields present');

  // --- Idempotency: feed the ALREADY-migrated shape back in as the on-disk
  // state-data and confirm the wrap logic does NOT double-wrap it. ---
  const fs = require('fs');
  const alreadyMigratedHtml = fs.readFileSync('/tmp/test_dup_full.html', 'utf8')
    .replace(/(<script id="state-data" type="application\/json">)[\s\S]*?(<\/script>)/,
      (_, open, close) => open + JSON.stringify(rootAfterSignup).replace(/</g, '\\u003c') + close);
  fs.writeFileSync('/tmp/test_dup_already_migrated.html', alreadyMigratedHtml);
  await page.goto('file:///tmp/test_dup_already_migrated.html');
  await page.waitForTimeout(300);
  await page.click('button[data-action="show-league-picker"]');
  await page.waitForTimeout(150);
  const leagueRowsIdempotent = await page.locator('button[data-action="enter-league"]').count();
  if (leagueRowsIdempotent !== 1) throw new Error('FAIL: re-loading an already-migrated document should still show exactly 1 league, got ' + leagueRowsIdempotent + ' (double-wrap bug)');
  console.log('PASS: migration is idempotent -- reloading an already-migrated document does not double-wrap it');

  // --- 3. "All Leagues" link shows the picker with exactly 1 league ---
  await page.goto('file:///tmp/test_dup_full.html');
  await page.waitForTimeout(300);
  await page.click('button[data-action="show-league-picker"]');
  await page.waitForTimeout(150);
  const leagueRowsBefore = await page.locator('button[data-action="enter-league"]').count();
  if (leagueRowsBefore !== 1) throw new Error('FAIL: expected exactly 1 league listed in the picker, got ' + leagueRowsBefore);
  console.log('PASS: "All Leagues" shows the picker with exactly the 1 existing league');

  // --- 4. Create a second league ---
  await page.fill('form[data-action="create-league"] input[name="name"]', 'League Two');
  await page.click('form[data-action="create-league"] button[type="submit"]');
  await page.waitForTimeout(200);

  const league2Title = await page.locator('h1.pool-title').innerText();
  if (!league2Title.includes('League Two')) throw new Error('FAIL: expected to be switched into "League Two", got: ' + league2Title);
  const emptyBoard = await page.locator('.empty').count();
  if (emptyBoard < 1) throw new Error('FAIL: expected an empty-board message in the brand-new league');
  const bleedThroughGames = await page.locator('.game-card').count();
  if (bleedThroughGames !== 0) throw new Error('FAIL: new league should have zero games, found ' + bleedThroughGames);
  console.log('PASS: creating a league switches into a clean, empty board with no bleed-through from league 1');

  published = await page.evaluate(() => window.__lastPublish);
  let rootAfterCreate = parsePublished(published);
  if (rootAfterCreate.leagues.length !== 2) throw new Error('FAIL: expected exactly 2 leagues after creation, got ' + rootAfterCreate.leagues.length);
  console.log('PASS: published document now has exactly 2 leagues');

  // --- 5. Per-league login isolation: sign up "bob" in League Two ---
  await page.fill('form[data-action="signup"] input[name="username"]', 'bob');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Bobs Team L2');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Bob');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'Two');
  await page.fill('form[data-action="signup"] input[name="email"]', 'bob2@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);
  let loggedInName = await page.locator('.who-chip .name').innerText();
  if (!loggedInName.includes('Bobs Team L2')) throw new Error('FAIL: expected bob logged in as "Bobs Team L2", got: ' + loggedInName);

  // Switch to League One -- bob should NOT be logged in there.
  await page.click('button[data-action="show-league-picker"]');
  await page.waitForTimeout(150);
  const rows = page.locator('tr', { has: page.locator('button[data-action="enter-league"]') });
  const rowCount = await rows.count();
  let enteredLeagueOne = false;
  for (let i = 0; i < rowCount; i++) {
    const text = await rows.nth(i).innerText();
    if (text.includes('The Westerly Points League')) {
      await rows.nth(i).locator('button[data-action="enter-league"]').click();
      enteredLeagueOne = true;
      break;
    }
  }
  if (!enteredLeagueOne) throw new Error('FAIL: could not find "The Westerly Points League" row in the picker');
  await page.waitForTimeout(150);

  const loggedInChipInL1 = await page.locator('.who-chip').count();
  if (loggedInChipInL1 !== 0) throw new Error('FAIL: bob should NOT be logged in in League One (separate accounts per league)');
  console.log('PASS: bob\'s login in League Two does not carry over to League One');

  // Sign up "bob" independently in League One too -- should succeed (separate account space).
  await page.fill('form[data-action="signup"] input[name="username"]', 'bob');
  await page.fill('form[data-action="signup"] input[name="teamName"]', 'Bobs Team L1');
  await page.fill('form[data-action="signup"] input[name="firstName"]', 'Bob');
  await page.fill('form[data-action="signup"] input[name="lastName"]', 'One');
  await page.fill('form[data-action="signup"] input[name="email"]', 'bob1@test.com');
  await page.fill('form[data-action="signup"] input[name="password"]', 'password1');
  await page.fill('form[data-action="signup"] input[name="confirmPassword"]', 'password1');
  await page.click('form[data-action="signup"] button[type="submit"]');
  await page.waitForTimeout(200);
  loggedInName = await page.locator('.who-chip .name').innerText();
  if (!loggedInName.includes('Bobs Team L1')) throw new Error('FAIL: expected bob (L1 account) logged in as "Bobs Team L1", got: ' + loggedInName);
  console.log('PASS: signing up "bob" in League One succeeds independently of League Two\'s "bob" account');

  // --- 6. Switch back to League Two -- bob's L2 login should still be intact ---
  await page.click('button[data-action="show-league-picker"]');
  await page.waitForTimeout(150);
  const rows2 = page.locator('tr', { has: page.locator('button[data-action="enter-league"]') });
  const rowCount2 = await rows2.count();
  let enteredLeagueTwo = false;
  for (let i = 0; i < rowCount2; i++) {
    const text = await rows2.nth(i).innerText();
    if (text.includes('League Two')) {
      await rows2.nth(i).locator('button[data-action="enter-league"]').click();
      enteredLeagueTwo = true;
      break;
    }
  }
  if (!enteredLeagueTwo) throw new Error('FAIL: could not find "League Two" row in the picker');
  await page.waitForTimeout(150);
  loggedInName = await page.locator('.who-chip .name').innerText();
  if (!loggedInName.includes('Bobs Team L2')) throw new Error('FAIL: expected bob still logged in as "Bobs Team L2" after switching back, got: ' + loggedInName);
  console.log('PASS: switching back to League Two restores bob\'s L2 login (per-league persistence)');

  // --- Final round-trip: both leagues intact with their own distinct players ---
  published = await page.evaluate(() => window.__lastPublish);
  const rootFinal = parsePublished(published);
  if (rootFinal.leagues.length !== 2) throw new Error('FAIL: expected 2 leagues in final published state, got ' + rootFinal.leagues.length);
  const finalL1 = rootFinal.leagues.find(l => l.name === 'The Westerly Points League');
  const finalL2 = rootFinal.leagues.find(l => l.name === 'League Two');
  if (!finalL1 || !finalL1.data.players.some(p => p.username === 'bob' && p.teamName === 'Bobs Team L1')) {
    throw new Error('FAIL: League One\'s bob account missing/wrong in final published data');
  }
  if (!finalL2 || !finalL2.data.players.some(p => p.username === 'bob' && p.teamName === 'Bobs Team L2')) {
    throw new Error('FAIL: League Two\'s bob account missing/wrong in final published data');
  }
  if (!finalL1.data.games.length) throw new Error('FAIL: League One should still have its original games intact');
  if (finalL2.data.games.length !== 0) throw new Error('FAIL: League Two should still have zero games');
  console.log('PASS: final published document has both leagues fully isolated and intact');

  console.log('ALL MULTI-LEAGUE TESTS PASSED');
  await browser.close();
})().catch(async (e) => { console.error('TEST FAILED:', e.message); process.exit(1); });
