/*
 * BlockHunt shared puzzle engine
 * ------------------------------------------------------------------
 * Used by BOTH the game (browser) and the score server (Cloudflare Worker),
 * so a tournament grid built from the same seed is identical on both sides.
 * The server picks the seed when a paid game starts, then re-checks every
 * word the player found against this exact grid before signing their time.
 *
 * Changing anything in here changes every tournament grid — bump
 * PUZZLE_VERSION and redeploy the worker at the same time as the site.
 */
(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.BHPuzzle = api
})(typeof self !== 'undefined' ? self : this, function () {
  const PUZZLE_VERSION = 1

  // Directions: right, down, diag ↘, diag ↗, left, up, diag ↖, diag ↙
  const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1], [-1, 0], [0, -1], [-1, -1], [-1, 1]]

  const MODES = {
    easy: { id: 0, words: 6, cols: 11, dirs: 4, minL: 4, maxL: 8, hints: 3, label: 'Easy' },
    hard: { id: 1, words: 10, cols: 13, dirs: 8, minL: 4, maxL: 11, hints: 1, label: 'Hard' },
    weekly: { id: 2, words: 12, cols: 13, dirs: 8, minL: 4, maxL: 11, hints: 0, label: 'Weekly' }
  }

  const ROUND_TIME_MS = 120000

  // Tournament word list — everyday crypto words most players will know.
  const TOURNAMENT_WORDS = [
    'BITCOIN', 'AVALANCHE', 'AVAX', 'BLOCK', 'CHAIN', 'TOKEN', 'WALLET', 'MINING', 'MINER', 'HASH',
    'LEDGER', 'STAKE', 'STAKING', 'YIELD', 'SWAP', 'TRADE', 'CHART', 'TREND', 'CRASH', 'SURGE',
    'RALLY', 'PUMP', 'DUMP', 'MOON', 'WHALE', 'HODL', 'FOMO', 'BULL', 'BEAR', 'ALPHA',
    'DEGEN', 'REKT', 'SHILL', 'BAGS', 'STACK', 'GRIND', 'PAPER', 'HANDS', 'DIAMOND', 'COIN',
    'MARKET', 'PRICE', 'PROFIT', 'GAINS', 'LOSS', 'CANDLE', 'VOLUME', 'SPOT', 'FUTURES', 'LONG',
    'SHORT', 'LEVER', 'MARGIN', 'REWARD', 'BRIDGE', 'NODE', 'NETWORK', 'ADDRESS', 'BALANCE', 'DEPOSIT',
    'SAVINGS', 'GAS', 'FEES', 'MINT', 'BURN', 'SUPPLY', 'HALVING', 'SATOSHI', 'ETHER', 'SOLANA',
    'DEFI', 'LIQUID', 'VAULT', 'KEYS', 'SEED', 'PHRASE', 'EXCHANGE', 'AIRDROP', 'NFT', 'METAVERSE',
    'CRYPTO', 'DIGITAL', 'ASSET', 'BUYER', 'SELLER', 'HOLDER', 'INVEST', 'RISK', 'SIGNAL', 'TICKER'
  ]

  function mulberry32(a) {
    a >>>= 0
    return function () {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /** Pick the tournament words for a seed (deterministic). */
  function pickWords(seed, mode, pool) {
    const cfg = MODES[mode]
    const ok = (pool || TOURNAMENT_WORDS).filter(w => w.length >= cfg.minL && w.length <= cfg.maxL && w.length <= cfg.cols)
    const rnd = mulberry32(seed ^ 0x9e3779b9)
    const a = ok.slice()
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const tmp = a[i]; a[i] = a[j]; a[j] = tmp
    }
    return a.slice(0, cfg.words)
  }

  /**
   * Build a grid. Returns { cols, letters (string, row-major), placements:[{word,cells}] }.
   * Deterministic for (seed, words, cols, dirs).
   */
  function generate(seed, words, cols, dirCount) {
    const dirs = DIRS.slice(0, dirCount)
    for (let attempt = 0; attempt < 50; attempt++) {
      const rnd = mulberry32((seed + attempt * 7919) >>> 0)
      const cells = new Array(cols * cols).fill('')
      const placements = []
      let failed = false
      const ordered = words.slice().sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
      for (const word of ordered) {
        let placed = false
        for (let tries = 0; tries < 1000 && !placed; tries++) {
          const d = dirs[Math.floor(rnd() * dirs.length)]
          const ox = Math.floor(rnd() * cols)
          const oy = Math.floor(rnd() * cols)
          const path = []
          let fits = true
          for (let i = 0; i < word.length; i++) {
            const x = ox + i * d[0]
            const y = oy + i * d[1]
            if (x < 0 || y < 0 || x >= cols || y >= cols) { fits = false; break }
            const idx = y * cols + x
            if (cells[idx] && cells[idx] !== word[i]) { fits = false; break }
            path.push(idx)
          }
          if (!fits) continue
          path.forEach((idx, i) => { cells[idx] = word[i] })
          placements.push({ word, cells: path })
          placed = true
        }
        if (!placed) { failed = true; break }
      }
      if (failed) continue
      const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
      for (let i = 0; i < cells.length; i++) if (!cells[i]) cells[i] = ABC[Math.floor(rnd() * 26)]
      return { cols, letters: cells.join(''), placements }
    }
    throw new Error('Could not build grid')
  }

  /** Full tournament puzzle for a mode + seed. */
  function tournamentPuzzle(mode, seed) {
    const cfg = MODES[mode]
    if (!cfg) throw new Error('Unknown mode')
    const words = pickWords(seed, mode)
    const grid = generate(seed, words, cfg.cols, cfg.dirs)
    return { mode, seed, words, cols: cfg.cols, dirs: cfg.dirs, letters: grid.letters, placements: grid.placements }
  }

  /**
   * Check a player's answer. `paths` maps each word to the list of cell indexes
   * they dragged. A path must be a straight line in an allowed direction and spell
   * the word forwards or backwards. Returns { ok, reason }.
   */
  function verify(puzzle, paths) {
    if (!paths || typeof paths !== 'object') return { ok: false, reason: 'No answers' }
    const cols = puzzle.cols
    const allowed = DIRS.slice(0, puzzle.dirs)
    for (const word of puzzle.words) {
      const p = paths[word]
      if (!Array.isArray(p) || p.length !== word.length) return { ok: false, reason: 'Missing ' + word }
      if (!p.every(i => Number.isInteger(i) && i >= 0 && i < cols * cols)) return { ok: false, reason: 'Bad cell' }
      const spelt = p.map(i => puzzle.letters[i]).join('')
      const fwd = spelt === word
      const rev = spelt.split('').reverse().join('') === word
      if (!fwd && !rev) return { ok: false, reason: 'Wrong letters for ' + word }
      // straight line, one step at a time
      const dx = (p[1] % cols) - (p[0] % cols)
      const dy = Math.floor(p[1] / cols) - Math.floor(p[0] / cols)
      // the drag may be backwards; the allowed direction is the one the word reads in
      const rd = fwd ? [dx, dy] : [-dx, -dy]
      if (!allowed.some(d => d[0] === rd[0] && d[1] === rd[1])) return { ok: false, reason: 'Direction not allowed' }
      for (let k = 1; k < p.length; k++) {
        const sx = (p[k] % cols) - (p[k - 1] % cols)
        const sy = Math.floor(p[k] / cols) - Math.floor(p[k - 1] / cols)
        if (sx !== dx || sy !== dy) return { ok: false, reason: 'Not a straight line' }
      }
    }
    return { ok: true }
  }

  /** Fastest time a human could plausibly manage (ms). */
  function minHumanMs(mode) {
    return MODES[mode].words * 900
  }

  return { PUZZLE_VERSION, DIRS, MODES, ROUND_TIME_MS, TOURNAMENT_WORDS, mulberry32, pickWords, generate, tournamentPuzzle, verify, minHumanMs }
})
