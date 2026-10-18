const test = require('node:test')
const assert = require('node:assert')
const P = require('../js/puzzle.js')

test('same seed builds the same grid', () => {
  for (const mode of ['easy', 'hard', 'weekly']) {
    const a = P.tournamentPuzzle(mode, 123456)
    const b = P.tournamentPuzzle(mode, 123456)
    assert.deepStrictEqual(a, b)
    assert.notStrictEqual(P.tournamentPuzzle(mode, 123457).letters, a.letters)
  }
})

test('every seed builds a solvable grid with the right shape', () => {
  for (const mode of ['easy', 'hard', 'weekly']) {
    const cfg = P.MODES[mode]
    for (let seed = 1; seed <= 3000; seed++) {
      const pz = P.tournamentPuzzle(mode, seed * 2654435761 >>> 0)
      assert.strictEqual(pz.words.length, cfg.words)
      assert.strictEqual(pz.letters.length, cfg.cols * cfg.cols)
      assert.match(pz.letters, /^[A-Z]+$/)
      const paths = Object.fromEntries(pz.placements.map(p => [p.word, p.cells]))
      assert.deepStrictEqual(P.verify(pz, paths), { ok: true }, mode + ' seed ' + seed)
    }
  }
})

test('dragging a word backwards still counts', () => {
  const pz = P.tournamentPuzzle('hard', 99)
  const paths = Object.fromEntries(pz.placements.map(p => [p.word, p.cells.slice().reverse()]))
  assert.deepStrictEqual(P.verify(pz, paths), { ok: true })
})

test('easy only allows its 4 directions', () => {
  for (let seed = 1; seed < 500; seed++) {
    const pz = P.tournamentPuzzle('easy', seed)
    for (const pl of pz.placements) {
      const c = pz.cols, a = pl.cells
      const d = [(a[1] % c) - (a[0] % c), Math.floor(a[1] / c) - Math.floor(a[0] / c)]
      assert.ok(P.DIRS.slice(0, 4).some(x => x[0] === d[0] && x[1] === d[1]))
    }
  }
})

test('rejects missing words, wrong cells, bent paths and junk', () => {
  const pz = P.tournamentPuzzle('hard', 4242)
  const good = Object.fromEntries(pz.placements.map(p => [p.word, p.cells]))
  const w = pz.words[0]
  assert.strictEqual(P.verify(pz, { ...good, [w]: undefined }).ok, false)
  const shifted = good[w].map(i => (i + 1) % (pz.cols * pz.cols))
  assert.strictEqual(P.verify(pz, { ...good, [w]: shifted }).ok, false)
  assert.strictEqual(P.verify(pz, { ...good, [w]: good[w].map(() => -1) }).ok, false)
  assert.strictEqual(P.verify(pz, { ...good, [w]: [...good[w]].sort(() => -1).concat(0) }).ok, false)
  assert.strictEqual(P.verify(pz, null).ok, false)
  assert.strictEqual(P.verify(pz, { [w]: 'nope' }).ok, false)
})

test('wraparound across rows is not a straight line', () => {
  // letters spelling a word across the end of one row into the next must fail
  const pz = { words: ['ABCD'], cols: 4, dirs: 8, letters: 'xxABCDxxxxxxxxxx'.toUpperCase().replace(/X/g, 'Z') }
  pz.letters = 'ZZABCDZZZZZZZZZZ'
  assert.strictEqual(P.verify(pz, { ABCD: [2, 3, 4, 5] }).ok, false)
})
