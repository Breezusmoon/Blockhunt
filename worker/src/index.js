/*
 * BlockHunt score server — Cloudflare Worker + one Durable Object.
 *
 *   POST /start   wallet-signed request → issues a fresh puzzle seed for one paid entry
 *   POST /finish  found-word paths → server checks them, times the game, signs the score
 *   GET  /board   verified times for a round (real players only)
 *   GET  /feed    latest verified finishes (powers the live activity feed)
 *   GET  /health  config check
 *
 * The signing key (SIGNER_KEY) only signs scores. It never holds or moves money.
 */
import Puzzle from '../../js/puzzle.js'
import { addressFromPrivateKey, getPlayer, isAddress, recoverPersonalSign, roundIdAt, signScore, startMessage } from './eth.js'

const MODE_IDS = { easy: 0, hard: 1, weekly: 2 }
const START_WINDOW_S = 180 // a signed start request is valid for 3 minutes
const FINISH_SLACK_MS = 5000 // network slack after the 2-minute clock

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors })
    try {
      const url = new URL(request.url)
      if (url.pathname === '/health') {
        return json({ ok: true, contract: env.CONTRACT_ADDRESS, chainId: Number(env.CHAIN_ID), signer: addressFromPrivateKey(env.SIGNER_KEY), puzzleVersion: Puzzle.PUZZLE_VERSION }, 200, cors)
      }
      const id = env.LEDGER.idFromName('main')
      const stub = env.LEDGER.get(id)
      const res = await stub.fetch(request)
      const out = new Response(res.body, res)
      for (const [k, v] of Object.entries(cors)) out.headers.set(k, v)
      return out
    } catch (e) {
      return json({ error: 'Server error' }, 500, cors)
    }
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin') || ''
  const allowed = String(env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
  const ok = allowed.includes(origin)
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

export function cleanName(n) {
  const s = String(n || '').normalize('NFKC').replace(/[^\p{L}\p{N}\p{Extended_Pictographic} _.\-]/gu, '').trim().slice(0, 18)
  return s || 'Player'
}

function randomU32() {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

function randomId() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('')
}

export class Ledger {
  constructor(ctx, env) {
    this.ctx = ctx
    this.env = env
    this.sql = ctx.storage.sql
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, contract TEXT, player TEXT, mode TEXT, round INTEGER, nonce INTEGER,
        seed INTEGER, started_at INTEGER, finished INTEGER DEFAULT 0, time_ms INTEGER, name TEXT);
      CREATE INDEX IF NOT EXISTS attempts_round ON attempts(contract, mode, round, finished);
      CREATE TABLE IF NOT EXISTS issued (
        contract TEXT, player TEXT, mode TEXT, round INTEGER, count INTEGER, PRIMARY KEY (contract, player, mode, round));
      CREATE TABLE IF NOT EXISTS used_starts (sig TEXT PRIMARY KEY, at INTEGER);
    `)
  }

  now() {
    return Date.now()
  }

  get contract() {
    return String(this.env.CONTRACT_ADDRESS).toLowerCase()
  }

  async fetch(request) {
    const url = new URL(request.url)
    try {
      if (request.method === 'POST' && url.pathname === '/start') return await this.start(await request.json())
      if (request.method === 'POST' && url.pathname === '/finish') return await this.finish(await request.json())
      if (request.method === 'GET' && url.pathname === '/board') return this.board(url.searchParams)
      if (request.method === 'GET' && url.pathname === '/feed') return this.feed()
      return json({ error: 'Not found' }, 404)
    } catch (e) {
      return json({ error: e.publicMessage || 'Bad request' }, e.status || 400)
    }
  }

  fail(status, message) {
    const e = new Error(message)
    e.status = status
    e.publicMessage = message
    throw e
  }

  async start(body) {
    const { player, mode, ts, req, sig } = body || {}
    if (!isAddress(player)) this.fail(400, 'Bad wallet address')
    if (!(mode in MODE_IDS)) this.fail(400, 'Bad mode')
    const nowMs = this.now()
    if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > START_WINDOW_S) this.fail(400, 'Start request expired — check your device clock')
    if (typeof req !== 'string' || !/^[0-9a-f]{16,64}$/.test(req)) this.fail(400, 'Bad request id')
    let signer
    try {
      signer = recoverPersonalSign(startMessage({ player, mode, ts, req }), sig)
    } catch {
      this.fail(401, 'Bad wallet signature')
    }
    if (signer.toLowerCase() !== player.toLowerCase()) this.fail(401, 'Signature is not from this wallet')

    // Each signed start can only be used once
    this.sql.exec('DELETE FROM used_starts WHERE at < ?', nowMs - START_WINDOW_S * 2000)
    const seen = this.sql.exec('SELECT 1 FROM used_starts WHERE sig = ?', String(sig).toLowerCase()).toArray()
    if (seen.length) this.fail(409, 'This start was already used')

    const modeId = MODE_IDS[mode]
    const round = roundIdAt(modeId, Math.floor(nowMs / 1000))
    const p = player.toLowerCase()
    let chain
    try {
      chain = await getPlayer(this.env.RPC_URL, this.env.CONTRACT_ADDRESS, modeId, round, p)
    } catch {
      this.fail(503, 'Could not reach Avalanche — try again in a moment')
    }

    const row = this.sql.exec('SELECT count FROM issued WHERE contract = ? AND player = ? AND mode = ? AND round = ?', this.contract, p, mode, round).toArray()[0]
    const nonce = Math.max(row ? row.count : 0, chain.attempts)
    if (nonce >= chain.entries) this.fail(402, chain.entries ? 'All your entries for this round are used — enter again to play' : 'No paid entry found yet — wait a few seconds after your entry confirms')

    const attemptId = randomId()
    const seed = randomU32()
    this.sql.exec('INSERT INTO used_starts (sig, at) VALUES (?, ?)', String(sig).toLowerCase(), nowMs)
    this.sql.exec(
      'INSERT INTO issued (contract, player, mode, round, count) VALUES (?, ?, ?, ?, ?) ON CONFLICT(contract, player, mode, round) DO UPDATE SET count = excluded.count',
      this.contract, p, mode, round, nonce + 1
    )
    this.sql.exec('INSERT INTO attempts (id, contract, player, mode, round, nonce, seed, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', attemptId, this.contract, p, mode, round, nonce, seed, nowMs)

    return json({ attemptId, mode, modeId, round, nonce, seed, puzzleVersion: Puzzle.PUZZLE_VERSION, entriesLeft: chain.entries - nonce - 1 })
  }

  async finish(body) {
    const { attemptId, paths, name } = body || {}
    if (typeof attemptId !== 'string') this.fail(400, 'Missing attempt')
    const a = this.sql.exec('SELECT * FROM attempts WHERE id = ?', attemptId).toArray()[0]
    if (!a || a.contract !== this.contract) this.fail(404, 'Unknown game')
    // Same game sent twice (e.g. the reply got lost) → hand back the same signed score
    if (a.finished === 2) return json(this.signed(a, a.time_ms))
    if (a.finished) this.fail(409, 'This game was already checked')

    const elapsed = this.now() - a.started_at
    // Lock the attempt first so a rejected answer can't be retried
    this.sql.exec('UPDATE attempts SET finished = 1 WHERE id = ?', attemptId)

    if (elapsed > Puzzle.ROUND_TIME_MS + FINISH_SLACK_MS) this.fail(410, "Time's up for this game")
    const puzzle = Puzzle.tournamentPuzzle(a.mode, a.seed)
    const check = Puzzle.verify(puzzle, paths)
    if (!check.ok) this.fail(422, 'Answers did not check out: ' + check.reason)
    if (elapsed < Puzzle.minHumanMs(a.mode)) this.fail(422, 'Finished faster than humanly possible')

    const timeMs = Math.min(elapsed, Puzzle.ROUND_TIME_MS)
    const nm = cleanName(name)
    this.sql.exec('UPDATE attempts SET finished = 2, time_ms = ?, name = ? WHERE id = ?', timeMs, nm, attemptId)

    return json(this.signed(a, timeMs))
  }

  signed(a, timeMs) {
    const modeId = MODE_IDS[a.mode]
    const signature = signScore(this.env.SIGNER_KEY, {
      chainId: Number(this.env.CHAIN_ID),
      contract: this.env.CONTRACT_ADDRESS,
      player: a.player,
      modeId,
      roundId: a.round,
      nonce: a.nonce,
      timeMs
    })
    return { mode: a.mode, modeId, round: a.round, nonce: a.nonce, timeMs, signature }
  }

  board(params) {
    const mode = params.get('mode')
    if (!(mode in MODE_IDS)) this.fail(400, 'Bad mode')
    const round = Number(params.get('round') ?? roundIdAt(MODE_IDS[mode], Math.floor(this.now() / 1000)))
    if (!Number.isInteger(round)) this.fail(400, 'Bad round')
    const rows = this.sql
      .exec(
        `SELECT player, MIN(time_ms) AS time_ms, COUNT(*) AS games,
                (SELECT name FROM attempts b WHERE b.contract = a.contract AND b.player = a.player AND b.mode = a.mode AND b.round = a.round AND b.finished = 2 ORDER BY b.time_ms ASC LIMIT 1) AS name
         FROM attempts a WHERE contract = ? AND mode = ? AND round = ? AND finished = 2
         GROUP BY player ORDER BY time_ms ASC LIMIT 50`,
        this.contract, mode, round
      )
      .toArray()
    return json({ mode, round, scores: rows.map(r => ({ player: r.player, name: r.name, timeMs: r.time_ms, games: r.games })) })
  }

  feed() {
    const rows = this.sql
      .exec('SELECT name, mode, time_ms, started_at FROM attempts WHERE contract = ? AND finished = 2 ORDER BY started_at DESC LIMIT 15', this.contract)
      .toArray()
    return json({ items: rows.map(r => ({ name: r.name, mode: r.mode, timeMs: r.time_ms, at: r.started_at + r.time_ms })) })
  }
}
