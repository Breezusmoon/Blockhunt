// Headless browser tests for the BlockHunt site.
//   SITE=http://127.0.0.1:8090/index.html node tests/browser.test.mjs            (offline checks)
//   + RPC=… WORKER=… CONTRACT=…  → also plays a full paid game on a local chain
import assert from 'node:assert'
import { createRequire } from 'node:module'
const require = createRequire(process.env.PW_DIR + '/package.json')
const chromium = require('@sparticuz/chromium')
const puppeteer = require('puppeteer-core')

const SITE = process.env.SITE
const RPC = process.env.RPC
const WORKER = process.env.WORKER
const CONTRACT = process.env.CONTRACT
const PLAYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const FAKE_NAMES = /CryptoKing|HODLmaster|AVAXmaxi|SatoshiHunter|DeFiWizard|MoonHunter|BlockBreaker|ChainRunner|TokenSlayer|HashHero/

const step = m => console.log('  ✓ ' + m)
const sleep = ms => new Promise(r => setTimeout(r, ms))

const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: [...chromium.args, '--autoplay-policy=no-user-gesture-required'], headless: true })

async function openPage({ mobile = false, tournament = false } = {}) {
  const page = await browser.newPage()
  const errors = []
  const missing = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', m => {
    if (m.type() === 'error' && !/favicon|ERR_CONNECTION|Failed to load resource/.test(m.text())) errors.push(m.text())
  })
  page.on('response', r => {
    if (r.status() >= 400 && r.url().startsWith(new URL(SITE).origin)) missing.push(r.status() + ' ' + r.url())
  })
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('bh7_seen', '1') } catch {} })
  if (mobile) {
    await page.emulate({ viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' })
  } else {
    await page.setViewport({ width: 1440, height: 900 })
  }
  if (tournament) {
    // Point the site at the local chain + worker, and give it a test wallet
    await page.setRequestInterception(true)
    page.on('request', async req => {
      if (req.url().endsWith('/js/tournament.js')) {
        const body = await (await fetch(req.url())).text()
        req.respond({
          status: 200,
          contentType: 'application/javascript',
          body: body
            .replace("contract: '',", `contract: '${CONTRACT}',`)
            .replace("scoreServer: '',", `scoreServer: '${WORKER}',`)
            .replace("rpc: 'https://api.avax.network/ext/bc/C/rpc',", `rpc: '${RPC}',`)
            .replace("chainId: '0xa86a',", "chainId: '0x7a69',")
            .replace('/^https:\\/\\//.test(BH_CONFIG.scoreServer)', '/^https?:\\/\\//.test(BH_CONFIG.scoreServer)')
        })
      } else req.continue()
    })
    await page.evaluateOnNewDocument((rpc, player) => {
      let id = 0
      const call = async (method, params) => {
        const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
        const j = await r.json()
        if (j.error) {
          const e = new Error(j.error.message)
          e.code = j.error.code
          throw e
        }
        return j.result
      }
      window.ethereum = {
        isMetaMask: true,
        request: async ({ method, params }) => {
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [player]
          if (method === 'eth_chainId') return '0x7a69'
          if (method === 'wallet_switchEthereumChain') return null
          return call(method, params)
        },
        on() {},
        removeListener() {}
      }
    }, RPC, PLAYER)
  }
  await page.goto(SITE, { waitUntil: 'networkidle0' })
  await sleep(3600) // intro screen
  return { page, errors, missing }
}

// Find each target word's cells in the visible grid (forward, as placed)
async function locateWords(page) {
  return page.evaluate(() => {
    const cols = COLS
    const letters = grid.map(t => t.textContent)
    const dirs = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]]
    const out = {}
    for (const w of awords) {
      search: for (let y = 0; y < cols; y++)
        for (let x = 0; x < cols; x++)
          for (const [dx, dy] of dirs) {
            const cells = []
            for (let i = 0; i < w.length; i++) {
              const xx = x + dx * i, yy = y + dy * i
              if (xx < 0 || yy < 0 || xx >= cols || yy >= cols || letters[yy * cols + xx] !== w[i]) break
              cells.push(yy * cols + xx)
            }
            if (cells.length === w.length) {
              out[w] = cells
              break search
            }
          }
    }
    return out
  })
}

async function tileCenters(page, cells) {
  return page.evaluate(cs => cs.map(i => {
    const r = grid[i].getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }), cells)
}

async function dragMouse(page, cells) {
  const pts = await tileCenters(page, cells)
  await page.mouse.move(pts[0].x, pts[0].y)
  await page.mouse.down()
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 3 })
  await page.mouse.up()
}

async function dragTouch(page, cells) {
  const pts = await tileCenters(page, cells)
  const cdp = await page.createCDPSession()
  const tp = p => [{ x: p.x, y: p.y, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(pts[0]) })
  for (const p of pts.slice(1)) {
    const prev = pts[pts.indexOf(p) - 1]
    for (let s = 1; s <= 3; s++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp({ x: prev.x + (p.x - prev.x) * s / 3, y: prev.y + (p.y - prev.y) * s / 3 }) })
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

async function scrollGridIntoView(page) {
  await page.evaluate(() => document.getElementById('gridWrap').scrollIntoView({ block: 'center' }))
  await sleep(400)
}

const text = (page, sel) => page.$eval(sel, e => e.textContent.trim())
const visible = (page, sel) => page.$eval(sel, e => !!(e.offsetWidth || e.offsetHeight) && getComputedStyle(e).display !== 'none')

// ─────────────────────────────── 1. offline site (production config) ───────────────────────────────
console.log('Desktop — production config (V3 not deployed yet)')
{
  const { page, errors, missing } = await openPage()
  assert.deepStrictEqual(missing, [], 'missing files: ' + missing.join(', '))
  step('every file the page asks for exists (no 404s)')
  const bytes = await page.evaluate(() => performance.getEntriesByType('resource').concat(performance.getEntriesByType('navigation')).reduce((s, e) => s + (e.transferSize || e.encodedBodySize || 0), 0))
  step(`first load ≈ ${(bytes / 1024).toFixed(0)} KB (was ~6,900 KB)`)
  assert.ok(!FAKE_NAMES.test(await page.evaluate(() => document.body.innerText)), 'fake names on page')
  step('no simulated players anywhere on the page')
  assert.ok(!/WINNER TAKES ALL|Win up to 1 AVAX|0\.02 AVAX/.test(await page.evaluate(() => document.body.innerText)))
  step('no fixed prize promises or paid hints')
  assert.strictEqual(await text(page, '#timer'), '2:00')
  assert.ok(await visible(page, '#playFreeBtn'))
  const words = await page.$$eval('#wlist .chip', c => c.length)
  assert.ok(words >= 6)
  step(`practice grid ready: ${words} words showing, clock parked at 2:00, PLAY FREE visible`)
  await sleep(1500)
  assert.strictEqual(await text(page, '#timer'), '2:00', 'clock started on its own')
  step('clock does not start on its own')
  assert.match(await text(page, '#easyEntBtn'), /Opening soon/)
  step('paid buttons say "opening soon" until V3 is deployed')
  await page.click('#easyEntBtn')
  await sleep(300)
  assert.match(await text(page, '#toast'), /anti-cheat upgrade/)
  step('tapping a paid mode explains the upgrade instead of taking money')

  // Practice game with real mouse drags
  await page.click('#playFreeBtn')
  await sleep(1300)
  assert.notStrictEqual(await text(page, '#timer'), '2:00')
  step('PLAY FREE starts the clock')
  await scrollGridIntoView(page)
  const found = await locateWords(page)
  assert.strictEqual(Object.keys(found).length, await page.evaluate(() => awords.length))
  let n = 0
  for (const [w, cells] of Object.entries(found)) {
    await dragMouse(page, n % 2 ? cells.slice().reverse() : cells) // every other word dragged backwards
    n++
  }
  await sleep(800)
  assert.strictEqual(await page.evaluate(() => found.length), n)
  assert.ok(await visible(page, '#ov'))
  assert.match(await text(page, '#otit'), /SOLVED/)
  step(`solved practice with real mouse drags (${n} words, half dragged backwards) → win screen`)
  // play again → new grid starts straight away
  await page.click('#playAgainBtn')
  await sleep(4600)
  assert.ok(await page.evaluate(() => gameOn))
  step('Play Again starts a fresh practice round')
  await page.evaluate(() => quitGame())
  await sleep(300)
  assert.ok(await visible(page, '#playFreeBtn'))
  assert.strictEqual(await text(page, '#timer'), '2:00')
  step('Quit parks a fresh grid with PLAY FREE again')

  // Hints are free and limited
  await page.click('#playFreeBtn')
  await sleep(300)
  const before = await page.evaluate(() => hleft)
  await page.evaluate(() => useHint())
  assert.strictEqual(await page.evaluate(() => hleft), before - 1)
  assert.match(await text(page, '#gbHintBtn'), /Hint \(\d\)|No hints/)
  step('hints are free and counted down')
  await page.evaluate(() => quitGame())

  // Profile: fighter images actually render
  await page.evaluate(() => openProfModal())
  await sleep(400)
  const imgs = await page.evaluate(() => ({ avatar: getComputedStyle(document.getElementById('profAvatar')).backgroundImage, sel: document.getElementById('pmSelChar').style.backgroundImage }))
  assert.match(imgs.avatar, /owl\.webp/)
  step('owl portrait renders in the profile (was url(undefined))')
  await page.evaluate(() => closeProfModal())

  // Daily + 1v1 run their clocks
  await page.evaluate(() => { localStorage.removeItem('bh7_daily_done'); startDaily() })
  await sleep(5200)
  const t1 = await text(page, '#timer')
  await sleep(1200)
  assert.notStrictEqual(await text(page, '#timer'), t1)
  step('daily challenge clock runs')
  await page.evaluate(() => quitGame())
  await page.evaluate(() => { v1Data = { n: 'Mate', t: 40, d: 'easy', w: null, s: 1234 }; accept1v1() })
  await sleep(5200)
  const t2 = await text(page, '#timer')
  await sleep(1200)
  assert.notStrictEqual(await text(page, '#timer'), t2)
  step('1v1 clock runs (was stuck behind a hidden START button)')
  assert.deepStrictEqual(errors, [], 'console errors: ' + errors.join(' | '))
  step('no JavaScript errors')
  await page.close()
}

// ─────────────────────────────── 2. phone ───────────────────────────────
console.log('Phone — 390×844 touch')
{
  const { page, errors } = await openPage({ mobile: true })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 1, 'horizontal overflow ' + overflow + 'px')
  step('no sideways scrolling')
  await page.evaluate(() => startFreePlay())
  await sleep(600)
  await scrollGridIntoView(page)
  const found = await locateWords(page)
  for (const cells of Object.values(found)) await dragTouch(page, cells)
  await sleep(800)
  const got = await page.evaluate(() => found.length)
  assert.strictEqual(got, Object.keys(found).length, `touch drags found ${got}/${Object.keys(found).length}`)
  step(`solved with real touch drags (${got} words)`)
  const tile = await page.evaluate(() => grid[0].getBoundingClientRect().width)
  assert.ok(tile >= 24, 'tiles too small: ' + tile)
  step(`tiles are ${tile.toFixed(0)}px wide on a phone`)
  assert.deepStrictEqual(errors, [], 'console errors: ' + errors.join(' | '))
  step('no JavaScript errors on mobile')
  await page.close()
}

// ─────────────────────────────── 3. paid game against local chain + worker ───────────────────────────────
if (RPC && WORKER && CONTRACT) {
  console.log('Paid tournament — local chain + score server')
  const { page, errors } = await openPage({ tournament: true })
  await sleep(1500)
  assert.match(await text(page, '#easyEntBtn'), /Enter Easy — 0\.05 AVAX/)
  step('wallet auto-connected, buttons show real entry fees')
  assert.match(await text(page, '#easyPrize'), /Be the first in/)
  assert.match(await text(page, '#lbTitle'), /Easy · Today/)
  step('empty pool shown honestly before anyone enters')

  await page.evaluate(() => { profile.name = 'Breezus' })
  await page.click('#easyEntBtn')
  await page.waitForFunction(() => Tourney.active && gameOn, { timeout: 30000 })
  step('entry paid on-chain, start signed, countdown → server puzzle on screen')
  const serverWords = await page.evaluate(() => awords.join(','))
  const local = await page.evaluate(() => BHPuzzle.tournamentPuzzle('easy', 0) && grid.map(t => t.textContent).join(''))
  assert.ok(local.length === 121)
  step('tournament grid: ' + serverWords)

  // the hidden-tab trick must not freeze a paid clock
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')) })
  await sleep(1200)
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')) })
  assert.ok(await page.evaluate(() => Date.now() - t0 > 1000))
  step('switching tabs does not pause a paid clock')

  await sleep(5000) // play at a believable human speed
  await scrollGridIntoView(page)
  const found = await locateWords(page)
  for (const cells of Object.values(found)) await dragMouse(page, cells)
  await page.waitForFunction(() => /IN THE MONEY|LOCKED IN/.test(document.getElementById('otit').textContent), { timeout: 30000 })
  const official = await text(page, '#otime')
  assert.match(await text(page, '#ornk'), /#1/)
  step(`server verified + signed, score locked on-chain: ${official} → #1`)
  assert.match(await text(page, '#oprPool'), /0\.0475 AVAX/)
  assert.match(await page.$eval('#oprYou', e => e.textContent), /0\.0475 AVAX/)
  step('win screen shows the real pool and payout (solo winner takes the 0.0475 pool)')
  await page.click('#playAgainBtn').catch(() => {})
  await page.evaluate(() => closeOv())
  await page.evaluate(() => Tourney.refresh())
  await sleep(2500)
  assert.match(await text(page, '#lblist'), /Breezus/)
  assert.match(await text(page, '#actFeed'), /Breezus.*Easy/)
  assert.match(await text(page, '#easyPrize'), /0\.0475 AVAX · 1 player/)
  assert.match(await text(page, '#pbPool'), /0\.048/)
  step('leaderboard, live feed, mode card and hero all show the real game')
  assert.ok(await visible(page, '#earnBox'))
  step('claim + invite box visible for a connected wallet')
  assert.deepStrictEqual(errors.filter(e => !/net::ERR/.test(e)), [], 'console errors: ' + errors.join(' | '))
  step('no JavaScript errors')
  await page.close()
}

await browser.close()
console.log('\nBROWSER TESTS PASSED')
