/*
 * BlockHunt — paid tournaments (V3) + real live data.
 * Loaded after the main game script; uses its globals (wallet, prov, grid, toast, …).
 *
 * Fill in BH_CONFIG after deploying (see DEPLOY.md). Until both values are set,
 * paid modes show "opening soon" and everything else (free play, daily, 1v1) works.
 */
const BH_CONFIG = {
  contract: '', // BlockHuntV3 address on Avalanche C-Chain
  scoreServer: '', // e.g. https://blockhunt-score.<you>.workers.dev
  rpc: 'https://api.avax.network/ext/bc/C/rpc',
  chainId: '0xa86a', // 43114
  explorer: 'https://snowtrace.io'
}

const Tourney = (() => {
  const LIVE = /^0x[0-9a-fA-F]{40}$/.test(BH_CONFIG.contract) && /^https:\/\//.test(BH_CONFIG.scoreServer)
  const MODE_ID = { easy: 0, hard: 1, weekly: 2 }
  const FEE = { easy: 0.05, hard: 0.085, weekly: 0.1 }
  const FEE_WEI = { easy: 50000000000000000n, hard: 85000000000000000n, weekly: 100000000000000000n }
  const SEL = {
    enter: '2e1ec3e9',
    submitScore: '102b6530',
    settle: 'fd9ca573',
    claim: '4e71d92d',
    getRound: '65c90d01',
    getPlayer: '6b79881c',
    claimable: '402914f5',
    paused: '5c975abb'
  }
  const GRACE_S = 600
  const ZERO = '0x0000000000000000000000000000000000000000'

  // ── live game state ──
  let game = null // {mode, attempt, puzzle, paths:{}, startedLocal}
  const rounds = {} // mode -> latest getRound result
  let lastFeedKey = ''

  // ── helpers ──
  const w32 = v => BigInt(v).toString(16).padStart(64, '0')
  const addr32 = a => a.toLowerCase().replace(/^0x/, '').padStart(64, '0')
  const words = hex => hex.replace(/^0x/, '').match(/.{64}/g) || []
  const big = h => BigInt('0x' + h)
  const avax = wei => Number(wei) / 1e18
  const fmtAvax = n => (n >= 1 ? n.toFixed(2) : String(+n.toFixed(4))) + ' AVAX'
  const short = a => a.slice(0, 6) + '…' + a.slice(-4)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const nowS = () => Math.floor(Date.now() / 1000)

  function roundIdAt(mode, t = nowS()) {
    const day = Math.floor(t / 86400)
    return mode === 'weekly' ? Math.floor((day + 4) / 7) : day
  }
  function roundEnd(mode, id) {
    return mode === 'weekly' ? ((id + 1) * 7 - 4) * 86400 : (id + 1) * 86400
  }

  async function rpc(method, params) {
    const r = await fetch(BH_CONFIG.rpc, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    })
    const j = await r.json()
    if (j.error) throw new Error(j.error.message || 'RPC error')
    return j.result
  }
  const call = data => rpc('eth_call', [{ to: BH_CONFIG.contract, data: '0x' + data }, 'latest'])

  async function getRound(mode, id = roundIdAt(mode)) {
    const w = words(await call(SEL.getRound + w32(MODE_ID[mode]) + w32(id)))
    const top = [5, 6, 7].map(i => '0x' + w[i].slice(24)).map(a => (a === ZERO ? null : a))
    const topMs = [8, 9, 10].map(i => Number(big(w[i])))
    return { mode, id, pool: avax(big(w[0])), entries: Number(big(w[1])), players: Number(big(w[2])), settled: big(w[3]) === 1n, endTime: Number(big(w[4])), top, topMs }
  }
  async function getClaimable(a) {
    return avax(big(words(await call(SEL.claimable + addr32(a)))[0]))
  }

  async function server(path, body) {
    const r = await fetch(BH_CONFIG.scoreServer + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
    const j = await r.json().catch(() => ({}))
    if (!r.ok) {
      const e = new Error(j.error || 'Score server error')
      e.status = r.status
      throw e
    }
    return j
  }

  async function ensureChain() {
    const id = await prov.request({ method: 'eth_chainId' })
    if (String(id).toLowerCase() === BH_CONFIG.chainId) return
    try {
      await prov.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BH_CONFIG.chainId }] })
    } catch (e) {
      if (e.code === 4902) {
        await prov.request({
          method: 'wallet_addEthereumChain',
          params: [{ chainId: BH_CONFIG.chainId, chainName: 'Avalanche C-Chain', nativeCurrency: { name: 'AVAX', symbol: 'AVAX', decimals: 18 }, rpcUrls: [BH_CONFIG.rpc], blockExplorerUrls: [BH_CONFIG.explorer] }]
        })
      } else throw e
    }
  }

  async function sendTx(data, valueWei = 0n, gas = 300000) {
    const hash = await prov.request({
      method: 'eth_sendTransaction',
      params: [{ from: wallet, to: BH_CONFIG.contract, data: '0x' + data, value: '0x' + valueWei.toString(16), gas: '0x' + gas.toString(16) }]
    })
    for (let i = 0; i < 90; i++) {
      await sleep(1000)
      const rc = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null)
      if (rc) {
        if (rc.status !== '0x1') throw new Error('Transaction failed on-chain')
        return hash
      }
    }
    throw new Error('Transaction is taking a while — check Snowtrace')
  }

  function toHexUtf8(s) {
    return '0x' + Array.from(new TextEncoder().encode(s), b => b.toString(16).padStart(2, '0')).join('')
  }

  function savedReferrer() {
    try {
      const r = localStorage.getItem('bh_ref') || ''
      return /^0x[0-9a-fA-F]{40}$/.test(r) && (!wallet || r.toLowerCase() !== wallet.toLowerCase()) ? r : ZERO
    } catch {
      return ZERO
    }
  }

  // ── public: capture ?ref=0x… links ──
  function captureReferral() {
    const ref = new URLSearchParams(location.search).get('ref') || ''
    if (/^0x[0-9a-fA-F]{40}$/.test(ref)) {
      try {
        if (!localStorage.getItem('bh_ref')) localStorage.setItem('bh_ref', ref)
      } catch {}
      try {
        history.replaceState({}, '', location.pathname)
      } catch {}
    }
  }

  // ── entering a paid game ──
  async function enter(mode) {
    if (!LIVE) {
      toast('💎 Paid tournaments are getting their anti-cheat upgrade — back very soon. Play free meanwhile!')
      return
    }
    if (game) return
    setDiff(mode, true)
    if (!wallet || !prov) {
      window._pendingEntry = mode
      openWM()
      return
    }
    window._pendingEntry = null
    const btn = document.getElementById(mode + 'EntBtn')
    const label = btn ? btn.textContent : ''
    const busy = t => {
      if (btn) {
        btn.disabled = true
        btn.textContent = t
      }
    }
    const reset = () => {
      if (btn) {
        btn.disabled = false
        btn.textContent = label
      }
    }
    try {
      busy('⏳ Checking network…')
      await ensureChain()
      const id = roundIdAt(mode)
      const pw = words(await call(SEL.getPlayer + w32(MODE_ID[mode]) + w32(id) + addr32(wallet)))
      const entries = Number(big(pw[0]))
      const attempts = Number(big(pw[1]))
      // We only know the server's issued count when we ask; pay if no entry is obviously unused
      if (entries <= attempts) {
        busy('⏳ Confirm entry in wallet…')
        const hash = await sendTx(SEL.enter + w32(MODE_ID[mode]) + addr32(savedReferrer()), FEE_WEI[mode], 200000)
        showTxToast('Entry confirmed — ' + FEE[mode] + ' AVAX', hash)
        if (typeof unlockAch === 'function') unlockAch('tourney_enter')
      }
      busy('✍️ Sign to start (free)…')
      const ts = nowS()
      const req = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('')
      const msg = `BlockHunt tournament start\nWallet: ${wallet.toLowerCase()}\nMode: ${mode}\nTime: ${ts}\nRequest: ${req}`
      const sig = await prov.request({ method: 'personal_sign', params: [toHexUtf8(msg), wallet] })
      busy('⏳ Getting your puzzle…')
      reset()
      play(mode, { player: wallet, mode, ts, req, sig })
    } catch (e) {
      reset()
      const msg = e.code === 4001 || /reject|cancel|denied/i.test(e.message || '') ? 'Cancelled' : e.message || 'Something went wrong'
      toast(msg, true)
    }
  }

  function play(mode, startBody) {
    const cfg = BHPuzzle.MODES[mode]
    isDailyMode = false
    training = false
    v1Data = null
    gameFinished = false
    noHintThisGame = true
    hleft = cfg.hints
    stopOpponentTracker()
    updateHintBtn()
    const tag = document.getElementById('mtag')
    if (tag) tag.textContent = '⚡ ' + cfg.label + ' Tournament'
    hidePlayFree()
    launchCountdown('⚡ ' + cfg.label + ' Tournament', async () => {
      let attempt
      for (let i = 0; i < 6; i++) {
        try {
          attempt = await server('/start', startBody)
          break
        } catch (e) {
          // a fresh entry can take a few seconds to show up on the public RPC
          if (e.status === 402 && /No paid entry found/.test(e.message) && i < 5) {
            await sleep(2500)
            continue
          }
          toast(e.message, true)
          showPlayFree()
          return
        }
      }
      if (!attempt) return
      const puzzle = BHPuzzle.tournamentPuzzle(mode, attempt.seed)
      game = { mode, attempt, puzzle, paths: {} }
      COLS = puzzle.cols
      awords = puzzle.words.slice()
      found = []
      path = []
      rng = null
      presetLetters = puzzle.letters
      buildGrid()
      presetLetters = null
      renderWords()
      updProg()
      resetCombo()
      const gw = document.getElementById('gridWrap')
      if (gw) gw.classList.add('active')
      setTEl('2:00', '')
      t0 = Date.now()
      gameOn = true
      stats.played++
      saveSt()
      renderSt()
      DRAG.resize()
      rippleIn()
      showGameBar()
      scrollToGrid()
      runTimer()
    })
  }

  function recordFound(word, cells) {
    if (game) game.paths[word] = cells.slice()
  }

  // Called from onWin() when every word is found in a paid game
  async function onSolved(localSeconds) {
    const g = game
    game = null
    const cfg = BHPuzzle.MODES[g.mode]
    showOv({
      ico: '⏳',
      tit: 'CHECKING…',
      tcls: 'win',
      sub: 'YOUR TIME',
      time: localSeconds.toFixed(2) + 's',
      stats: '',
      rnk: 'Verifying your words with the score server',
      bst: '',
      dif: cfg.label + ' Tournament',
      showPrize: false,
      msg: ''
    })
    let fin
    try {
      fin = await serverRetry('/finish', { attemptId: g.attempt.attemptId, paths: g.paths, name: (profile.avatar || '') + ' ' + (profile.name || 'Player') })
    } catch (e) {
      showOv({ ico: '⚠️', tit: 'NOT COUNTED', tcls: 'fail', sub: 'YOUR TIME', time: localSeconds.toFixed(2) + 's', stats: '', rnk: e.message, bst: '', dif: cfg.label + ' Tournament', showPrize: false, msg: 'This entry has been used. Enter again to try another puzzle.' })
      return
    }
    const official = fin.timeMs / 1000
    setOv('otime', official.toFixed(2) + 's')
    setOv('otit', 'SUBMITTING')
    setOv('ornk', '✍️ Confirm in your wallet to lock your time on-chain (tiny gas fee)')
    try {
      const data = SEL.submitScore + w32(fin.modeId) + w32(fin.round) + w32(fin.nonce) + w32(fin.timeMs) + w32(160) + w32(65) + fin.signature.replace(/^0x/, '').padEnd(192, '0')
      const hash = await sendTx(data, 0n, 250000)
      showTxToast('Score locked on Avalanche', hash)
    } catch (e) {
      const cancelled = e.code === 4001 || /reject|cancel|denied/i.test(e.message || '')
      setOv('otit', 'NOT SUBMITTED')
      setOv('ornk', cancelled ? 'You cancelled — your time is NOT on-chain yet.' : 'Submit failed: ' + (e.message || 'unknown'))
      pendingSubmit = { fin, until: roundEnd(g.mode, fin.round) + GRACE_S }
      setOv('omsg', 'Tap "Submit score" below before the round closes to count it.')
      showSubmitRetry(true)
      return
    }
    await showRoundResult(g.mode, fin, official)
  }

  let pendingSubmit = null
  async function retrySubmit() {
    if (!pendingSubmit) return
    const { fin, until } = pendingSubmit
    if (nowS() > until) {
      toast('This round has closed', true)
      pendingSubmit = null
      showSubmitRetry(false)
      return
    }
    try {
      const data = SEL.submitScore + w32(fin.modeId) + w32(fin.round) + w32(fin.nonce) + w32(fin.timeMs) + w32(160) + w32(65) + fin.signature.replace(/^0x/, '').padEnd(192, '0')
      const hash = await sendTx(data, 0n, 250000)
      showTxToast('Score locked on Avalanche', hash)
      pendingSubmit = null
      showSubmitRetry(false)
      await showRoundResult(fin.mode, fin, fin.timeMs / 1000)
    } catch (e) {
      toast(e.code === 4001 ? 'Cancelled' : 'Submit failed: ' + (e.message || ''), true)
    }
  }

  async function serverRetry(path, body) {
    let last
    for (let i = 0; i < 3; i++) {
      try {
        return await server(path, body)
      } catch (e) {
        last = e
        if (e.status && e.status < 500) throw e
        await sleep(1200)
      }
    }
    throw last
  }

  async function showRoundResult(mode, fin, official) {
    const cfg = BHPuzzle.MODES[mode]
    let r
    try {
      r = await getRound(mode, fin.round)
    } catch {}
    const me = wallet.toLowerCase()
    const place = r ? r.top.findIndex(a => a && a.toLowerCase() === me) + 1 : 0
    const placesFilled = r ? r.top.filter(Boolean).length : 0
    const shares = splits(r ? r.pool : 0, placesFilled)
    stats.wins++
    if (!stats.best[mode] || official < stats.best[mode]) stats.best[mode] = official
    saveSt()
    renderSt()
    if (place >= 1 && place <= 3 && typeof checkAchTourneyTop3 === 'function') checkAchTourneyTop3(place)
    const left = Math.max(0, r ? r.endTime - nowS() : 0)
    const h = Math.floor(left / 3600)
    const m = Math.floor((left % 3600) / 60)
    showOv({
      ico: place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : '⚡',
      tit: place ? 'IN THE MONEY' : 'LOCKED IN',
      tcls: 'win',
      sub: 'OFFICIAL TIME',
      time: official.toFixed(2) + 's',
      stats: `<div class="ostat"><div class="ostat-val">${awords.length}</div><div class="ostat-lbl">Words</div></div><div class="ostat"><div class="ostat-val">${r ? r.players : '—'}</div><div class="ostat-lbl">Players</div></div><div class="ostat"><div class="ostat-val">${r ? fmtAvax(r.pool).replace(' AVAX', '') : '—'}</div><div class="ostat-lbl">Pool AVAX</div></div>`,
      rnk: place ? `You're #${place} right now` : 'Not in the top 3 yet — enter again to beat your time',
      bst: '',
      dif: `${cfg.label} round closes in ${h}h ${m}m · winners paid automatically`,
      showPrize: !!r,
      pool: r ? r.pool : 0,
      prizes: shares,
      you: place ? shares[place - 1] : 0,
      msg: place ? 'Hold your spot until the round closes and the AVAX lands in your wallet.' : 'Each entry is one fresh puzzle. Best time counts.'
    })
    particles()
    refresh()
  }

  function splits(pool, filled) {
    const s1 = pool * 0.7
    const s2 = pool * 0.2
    const s3 = pool - s1 - s2
    if (filled <= 1) return [pool, 0, 0]
    if (filled === 2) return [s1 + s3, s2, 0]
    return [s1, s2, s3]
  }

  function onTimeout() {
    const g = game
    game = null
    if (!g) return false
    // Burn the attempt server-side so the board stays honest
    server('/finish', { attemptId: g.attempt.attemptId, paths: {} }).catch(() => {})
    showOv({
      ico: '⏱',
      tit: 'TIME UP',
      tcls: 'fail',
      sub: 'WORDS FOUND',
      time: found.length + ' / ' + awords.length,
      stats: '',
      rnk: '',
      bst: '',
      dif: BHPuzzle.MODES[g.mode].label + ' Tournament',
      showPrize: false,
      msg: 'That entry is used. Enter again for a fresh puzzle — practise free to warm up.'
    })
    return true
  }

  function quit() {
    if (game) {
      server('/finish', { attemptId: game.attempt.attemptId, paths: {} }).catch(() => {})
      game = null
    }
  }

  function setOv(id, text) {
    const e = document.getElementById(id)
    if (e) e.textContent = text
  }
  function showSubmitRetry(show) {
    const b = document.getElementById('submitRetryBtn')
    if (b) b.style.display = show ? '' : 'none'
  }

  // ── live data: pools, boards, feed, claims ──
  async function refresh() {
    renderModeCards()
    if (!LIVE) return renderOffline()
    try {
      for (const mode of ['easy', 'hard', 'weekly']) rounds[mode] = await getRound(mode)
    } catch {
      return
    }
    const e = rounds.easy
    const h = rounds.hard
    setText('pbPool', (e.pool + h.pool).toFixed(3))
    setText('pbPlayers', String(e.entries + h.entries))
    setText('pbFee', '0.050')
    for (const mode of ['easy', 'hard', 'weekly']) {
      const r = rounds[mode]
      setText(mode + 'Prize', r.entries ? fmtAvax(r.pool) + ' · ' + r.players + (r.players === 1 ? ' player' : ' players') : 'Be the first in')
      setText(mode + 'Players', r.players + (r.players === 1 ? ' player' : ' players'))
    }
    renderTop3('tBoard', rounds.weekly)
    renderBoard()
    renderFeed()
    refreshWallet()
  }

  function renderOffline() {
    const live = document.getElementById('thLive')
    if (live) live.innerHTML = '<span class="th-pulse" style="background:var(--gold);box-shadow:0 0 8px var(--gold)"></span>FREE PLAY OPEN · TOURNAMENTS SOON'
    setText('pbPool', '—')
    setText('pbPlayers', '—')
    for (const mode of ['easy', 'hard', 'weekly']) setText(mode + 'Prize', 'Opening soon')
    const feed = document.getElementById('actFeed')
    if (feed) feed.innerHTML = '<div class="act-empty">Paid tournaments reopen soon with anti-cheat scoring. Live results will show here.</div>'
    renderBoard()
  }

  function renderModeCards() {
    for (const mode of ['easy', 'hard', 'weekly']) {
      const b = document.getElementById(mode + 'EntBtn')
      if (!b || b.disabled) continue
      const label = { easy: 'Enter Easy', hard: 'Enter Hard', weekly: 'Enter Weekly' }[mode]
      b.textContent = !LIVE ? '⏳ Opening soon — play free above' : wallet ? '⚡ ' + label + ' — ' + FEE[mode] + ' AVAX' : '🔗 Connect Wallet to Enter'
    }
  }

  function renderTop3(elId, r) {
    const el = document.getElementById(elId)
    if (!el || !r) return
    const medals = ['🥇', '🥈', '🥉']
    const rows = r.top.map((a, i) => (a ? { a, ms: r.topMs[i], i } : null)).filter(Boolean)
    if (!rows.length) {
      el.innerHTML = '<div class="lb-empty" style="padding:6px 0">No finished games this week yet</div>'
      return
    }
    const sh = splits(r.pool, rows.length)
    el.innerHTML = rows
      .map(x => `<div class="t3-row"><span>${medals[x.i]}</span><span class="t3-who">${short(x.a)}${wallet && x.a.toLowerCase() === wallet.toLowerCase() ? ' ◀' : ''}</span><span class="t3-t">${(x.ms / 1000).toFixed(2)}s</span><span class="t3-p">${+sh[x.i].toFixed(4)}</span></div>`)
      .join('')
  }

  async function renderBoard() {
    const el = document.getElementById('lblist')
    const title = document.getElementById('lbTitle')
    if (!el) return
    if (!LIVE) {
      if (title) title.textContent = 'Your Practice Times'
      return renderLb()
    }
    const mode = diff in MODE_ID ? diff : 'easy'
    if (title) title.textContent = BHPuzzle.MODES[mode].label + ' · ' + (mode === 'weekly' ? 'This Week' : 'Today')
    let board
    try {
      board = await server('/board?mode=' + mode + '&round=' + roundIdAt(mode))
    } catch {
      return
    }
    if (!board.scores.length) {
      el.innerHTML = `<div class="lb-empty">No finished ${BHPuzzle.MODES[mode].label} games yet — the pool is waiting</div>`
      return
    }
    const r = rounds[mode]
    const paid = r ? new Set(r.top.filter(Boolean).map(a => a.toLowerCase())) : new Set()
    const me = wallet ? wallet.toLowerCase() : ''
    el.innerHTML = board.scores
      .slice(0, 10)
      .map((s, i) => {
        const cls = i === 0 ? 'g' : i === 1 ? 's' : i === 2 ? 'b' : ''
        const onchain = paid.has(s.player) ? '<span class="lb-chain" title="Locked on-chain">⛓</span>' : ''
        return `<div class="lb-row${s.player === me ? ' me' : ''}"><div class="lbrnk ${cls || 'r'}">${i + 1}</div><div class="lbnm">${esc(s.name)}${onchain}</div><div class="lbdf">${s.games > 1 ? s.games + ' games' : ''}</div><div class="lbtm">${(s.timeMs / 1000).toFixed(2)}s</div></div>`
      })
      .join('')
  }

  async function renderFeed() {
    const feed = document.getElementById('actFeed')
    if (!feed) return
    let data
    try {
      data = await server('/feed')
    } catch {
      return
    }
    const key = data.items.map(i => i.at).join(',')
    if (key === lastFeedKey) return
    lastFeedKey = key
    if (!data.items.length) {
      feed.innerHTML = '<div class="act-empty">No tournament games yet today — be the first!</div>'
      return
    }
    feed.innerHTML = data.items
      .slice(0, 7)
      .map(i => `<div class="act-row">⚡ <strong>${esc(i.name)}</strong> finished ${BHPuzzle.MODES[i.mode].label} in <strong>${(i.timeMs / 1000).toFixed(1)}s</strong> <span class="act-ago">${ago(i.at)}</span></div>`)
      .join('')
  }

  function ago(ms) {
    const s = Math.max(1, Math.floor((Date.now() - ms) / 1000))
    if (s < 60) return s + 's ago'
    if (s < 3600) return Math.floor(s / 60) + 'm ago'
    if (s < 86400) return Math.floor(s / 3600) + 'h ago'
    return Math.floor(s / 86400) + 'd ago'
  }

  async function refreshWallet() {
    const box = document.getElementById('earnBox')
    if (!box) return
    if (!LIVE || !wallet) {
      box.style.display = 'none'
      return
    }
    box.style.display = ''
    setText('refLink', location.origin + location.pathname + '?ref=' + wallet)
    try {
      const c = await getClaimable(wallet)
      setText('claimAmt', fmtAvax(c))
      const btn = document.getElementById('claimBtn')
      if (btn) btn.disabled = c <= 0
    } catch {}
    checkUnsettledWins()
  }

  // If a finished round you placed in hasn't been settled yet, let you trigger it
  async function checkUnsettledWins() {
    const btn = document.getElementById('settleBtn')
    if (!btn || !wallet) return
    const me = wallet.toLowerCase()
    for (const mode of ['easy', 'hard', 'weekly']) {
      const prev = roundIdAt(mode) - 1
      if (nowS() < roundEnd(mode, prev) + GRACE_S) continue
      try {
        const r = await getRound(mode, prev)
        if (!r.settled && r.pool > 0 && r.top.some(a => a && a.toLowerCase() === me)) {
          btn.style.display = ''
          btn.textContent = '🏆 Collect ' + BHPuzzle.MODES[mode].label + ' prize'
          btn.onclick = () => settle(mode, prev)
          return
        }
      } catch {}
    }
    btn.style.display = 'none'
  }

  async function settle(mode, id) {
    try {
      await ensureChain()
      const hash = await sendTx(SEL.settle + w32(MODE_ID[mode]) + w32(id), 0n, 300000)
      showTxToast('Round settled — prizes sent', hash)
      refresh()
    } catch (e) {
      toast(e.code === 4001 ? 'Cancelled' : e.message || 'Settle failed', true)
    }
  }

  async function claim() {
    try {
      await ensureChain()
      const hash = await sendTx(SEL.claim, 0n, 100000)
      showTxToast('Claimed to your wallet', hash)
      refreshWallet()
    } catch (e) {
      toast(e.code === 4001 ? 'Cancelled' : e.message || 'Claim failed', true)
    }
  }

  function copyRef() {
    const url = location.origin + location.pathname + '?ref=' + wallet
    const done = () => {
      toast('🔗 Invite link copied — you earn 2% of every entry your friends make')
      if (typeof unlockAch === 'function') unlockAch('ref_first')
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, () => prompt('Your invite link:', url))
    else prompt('Your invite link:', url)
  }

  function setText(id, t) {
    const e = document.getElementById(id)
    if (e) e.textContent = t
  }

  function start() {
    captureReferral()
    refresh()
    setInterval(() => {
      if (!document.hidden) refresh()
    }, 20000)
  }

  return {
    LIVE,
    enter,
    recordFound,
    onSolved,
    onTimeout,
    quit,
    refresh,
    renderBoard,
    renderModeCards,
    claim,
    copyRef,
    retrySubmit,
    start,
    get active() {
      return !!game
    }
  }
})()
