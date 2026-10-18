// End-to-end: local Avalanche-like chain (anvil) + BlockHuntV3 + the real worker.
// Usage: RPC=http://127.0.0.1:8545 WORKER=http://127.0.0.1:8787 CONTRACT=0x... node test/e2e.mjs
import assert from 'node:assert'
import { createRequire } from 'node:module'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils'
import { selector, word, startMessage, strip0x } from '../src/eth.js'

const require = createRequire(import.meta.url)
const Puzzle = require('../../js/puzzle.js')

const RPC = process.env.RPC
const WORKER = process.env.WORKER
const CONTRACT = process.env.CONTRACT
// anvil default account #1 (test-only key, public knowledge)
const PLAYER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const PLAYER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'
const HOUSE = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'

let id = 0
async function rpc(method, params = []) {
  const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(method + ': ' + JSON.stringify(j.error))
  return j.result
}
async function send(from, data, value = '0x0') {
  const hash = await rpc('eth_sendTransaction', [{ from, to: CONTRACT, data, value, gas: '0x' + (400000).toString(16) }])
  for (let i = 0; i < 50; i++) {
    const rc = await rpc('eth_getTransactionReceipt', [hash])
    if (rc) return rc
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('no receipt')
}
async function call(data) {
  return strip0x(await rpc('eth_call', [{ to: CONTRACT, data }, 'latest']))
}
const words = hex => Array.from({ length: hex.length / 64 }, (_, i) => hex.slice(i * 64, i * 64 + 64))
const big = w => BigInt('0x' + w)

function personalSign(key, message) {
  const msg = utf8ToBytes(message)
  const hash = keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n' + msg.length), msg))
  const s = secp256k1.sign(hash, hexToBytes(strip0x(key)))
  return '0x' + s.toCompactHex() + (27 + s.recovery).toString(16)
}
async function post(path, body) {
  const r = await fetch(WORKER + path, { method: 'POST', headers: { 'content-type': 'application/json', Origin: 'http://localhost' }, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json() }
}
function enterData(mode, referrer = '0x0000000000000000000000000000000000000000') {
  return '0x' + selector('enter(uint8,address)') + word(mode) + word(referrer, 'address')
}
function submitData(mode, round, nonce, timeMs, sig) {
  const s = strip0x(sig)
  return '0x' + selector('submitScore(uint8,uint256,uint256,uint256,bytes)') + word(mode) + word(round) + word(nonce) + word(timeMs) + word(160) + word(65) + s.padEnd(192, '0')
}
const newReq = () => bytesToHex(crypto.getRandomValues(new Uint8Array(8)))
async function startGame(mode, req = newReq()) {
  const ts = Math.floor(Date.now() / 1000)
  return post('/start', { player: PLAYER, mode, ts, req, sig: personalSign(PLAYER_KEY, startMessage({ player: PLAYER, mode, ts, req })) })
}
const solve = pz => Object.fromEntries(pz.placements.map(p => [p.word, p.cells]))
const step = (msg) => console.log('  ✓ ' + msg)

// ── 0. worker is wired to this chain + contract
const health = await (await fetch(WORKER + '/health')).json()
assert.strictEqual(health.contract.toLowerCase(), CONTRACT.toLowerCase())
const onChainSigner = '0x' + (await call('0x' + selector('signer()'))).slice(24)
assert.strictEqual(health.signer.toLowerCase(), onChainSigner.toLowerCase())
step('worker signer matches contract signer ' + health.signer)

// ── 1. no entry → no game
let r = await startGame('easy')
assert.strictEqual(r.status, 402, JSON.stringify(r.body))
step('start refused without a paid entry')

// ── 2. pay entry
let rc = await send(PLAYER, enterData(0), '0x' + (5n * 10n ** 16n).toString(16))
assert.strictEqual(rc.status, '0x1')
step('entered Easy (0.05 AVAX)')

// ── 3. forged / wrong-wallet start rejected
const ts = Math.floor(Date.now() / 1000)
const req0 = newReq()
r = await post('/start', { player: PLAYER, mode: 'easy', ts, req: req0, sig: personalSign('0x' + '11'.repeat(32), startMessage({ player: PLAYER, mode: 'easy', ts, req: req0 })) })
assert.strictEqual(r.status, 401)
step('start signed by another wallet rejected')

// ── 4. real game
r = await startGame('easy')
assert.strictEqual(r.status, 200, JSON.stringify(r.body))
const g = r.body
const pz = Puzzle.tournamentPuzzle('easy', g.seed)
step(`got puzzle seed ${g.seed}, round ${g.round}, nonce ${g.nonce}: ${pz.words.join(', ')}`)

// replaying the same signed start is refused
// (a second start would need a second entry anyway; this checks the replay guard)
// too fast → rejected (and attempt burnt)
await new Promise(res => setTimeout(res, Puzzle.minHumanMs('easy') + 600))
const bad = solve(pz)
bad[pz.words[0]] = bad[pz.words[0]].map(i => (i + 1) % (pz.cols * pz.cols))
// play properly instead (don't burn the attempt): submit correct paths
r = await post('/finish', { attemptId: g.attemptId, paths: solve(pz), name: 'Breezus 🦉<script>' })
assert.strictEqual(r.status, 200, JSON.stringify(r.body))
const fin = r.body
assert.ok(fin.timeMs >= Puzzle.minHumanMs('easy') && fin.timeMs < 20000)
step(`server timed the game at ${fin.timeMs} ms and signed it`)

// idempotent re-finish returns the same signature
r = await post('/finish', { attemptId: g.attemptId, paths: solve(pz) })
assert.strictEqual(r.body.signature, fin.signature)
step('lost reply can be re-fetched (same signature)')

// ── 5. tampered time is rejected by the contract, real one accepted
rc = await send(PLAYER, submitData(0, fin.round, fin.nonce, 1, fin.signature)).catch(e => ({ status: 'reverted' }))
assert.notStrictEqual(rc.status, '0x1')
step('contract rejects the signature with a faked 1 ms time')
rc = await send(PLAYER, submitData(0, fin.round, fin.nonce, fin.timeMs, fin.signature))
assert.strictEqual(rc.status, '0x1')
step('contract accepted the server-signed score')

let w = words(await call('0x' + selector('getRound(uint8,uint256)') + word(0) + word(fin.round)))
assert.strictEqual('0x' + w[5].slice(24), PLAYER)
assert.strictEqual(Number(big(w[8])), fin.timeMs)
step('player is #1 on-chain with ' + fin.timeMs + ' ms')

// ── 6. entry used up
r = await startGame('easy')
assert.strictEqual(r.status, 402)
step('second game without a second entry refused')
{
  const ts2 = Math.floor(Date.now() / 1000), req2 = newReq()
  const body = { player: PLAYER, mode: 'easy', ts: ts2, req: req2, sig: personalSign(PLAYER_KEY, startMessage({ player: PLAYER, mode: 'easy', ts: ts2, req: req2 })) }
  await send(PLAYER, enterData(0), '0x' + (5n * 10n ** 16n).toString(16))
  const first = await post('/start', body)
  assert.strictEqual(first.status, 200)
  await post('/finish', { attemptId: first.body.attemptId, paths: {} }) // abandon it
  await send(PLAYER, enterData(0), '0x' + (5n * 10n ** 16n).toString(16))
  const replay = await post('/start', body)
  assert.strictEqual(replay.status, 409)
  step('replayed start request refused')
}

// ── 7. cheating paths on a new entry
await send(PLAYER, enterData(0), '0x' + (5n * 10n ** 16n).toString(16))
r = await startGame('easy')
assert.strictEqual(r.status, 200)
const pz2 = Puzzle.tournamentPuzzle('easy', r.body.seed)
const fast = await post('/finish', { attemptId: r.body.attemptId, paths: solve(pz2) })
assert.strictEqual(fast.status, 422)
assert.match(fast.body.error, /faster than humanly possible/)
step('instant (bot-speed) finish rejected')
await send(PLAYER, enterData(0), '0x' + (5n * 10n ** 16n).toString(16))
r = await startGame('easy')
const pz3 = Puzzle.tournamentPuzzle('easy', r.body.seed)
const wrong = solve(pz3)
wrong[pz3.words[0]] = [0, 1, 2, 3].slice(0, pz3.words[0].length)
await new Promise(res => setTimeout(res, Puzzle.minHumanMs('easy') + 200))
const tamper = await post('/finish', { attemptId: r.body.attemptId, paths: wrong })
assert.strictEqual(tamper.status, 422)
step('wrong answers rejected: ' + tamper.body.error)

// ── 8. real leaderboard + feed
const board = await (await fetch(`${WORKER}/board?mode=easy&round=${fin.round}`)).json()
assert.strictEqual(board.scores.length, 1)
assert.strictEqual(board.scores[0].name, 'Breezus 🦉script')
const feed = await (await fetch(`${WORKER}/feed`)).json()
assert.strictEqual(feed.items.length, 1)
step('board + feed show only the real verified game, name sanitised')

// ── 9. settle after the round → winner paid automatically
w = words(await call('0x' + selector('getRound(uint8,uint256)') + word(0) + word(fin.round)))
const pool = big(w[0])
const endTime = Number(big(w[4]))
const block = await rpc('eth_getBlockByNumber', ['latest', false])
await rpc('evm_increaseTime', [endTime + 600 - Number(BigInt(block.timestamp)) + 1])
await rpc('evm_mine')
const before = BigInt(await rpc('eth_getBalance', [PLAYER, 'latest']))
rc = await send(HOUSE, '0x' + selector('settle(uint8,uint256)') + word(0) + word(fin.round))
assert.strictEqual(rc.status, '0x1')
const after = BigInt(await rpc('eth_getBalance', [PLAYER, 'latest']))
assert.strictEqual(after - before, pool)
step(`round settled: winner auto-paid ${Number(pool) / 1e18} AVAX (whole pool, solo winner)`)

console.log('\nE2E PASSED')
