// Small, dependency-light Ethereum helpers for the score server.
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from '@noble/hashes/utils'

export const strip0x = h => (h.startsWith('0x') ? h.slice(2) : h)
export const keccakHex = bytes => '0x' + bytesToHex(keccak_256(bytes))

export function selector(signature) {
  return bytesToHex(keccak_256(utf8ToBytes(signature))).slice(0, 8)
}

export function isAddress(a) {
  return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)
}

// ABI-encode static values: each becomes one 32-byte word
export function word(value, type) {
  if (type === 'address') return strip0x(value).toLowerCase().padStart(64, '0')
  if (type === 'bytes32') return strip0x(value).padStart(64, '0')
  return BigInt(value).toString(16).padStart(64, '0')
}

export function addressFromPublicKey(pub /* Uint8Array 65 uncompressed */) {
  return '0x' + bytesToHex(keccak_256(pub.slice(1))).slice(-40)
}

export function addressFromPrivateKey(priv) {
  return addressFromPublicKey(secp256k1.getPublicKey(hexToBytes(strip0x(priv)), false))
}

/** Recover the wallet that produced an EIP-191 personal_sign signature. */
export function recoverPersonalSign(message, signature) {
  const msg = utf8ToBytes(message)
  const prefix = utf8ToBytes('\x19Ethereum Signed Message:\n' + msg.length)
  const hash = keccak_256(concatBytes(prefix, msg))
  const sig = hexToBytes(strip0x(signature))
  if (sig.length !== 65) throw new Error('Bad signature length')
  let v = sig[64]
  if (v >= 27) v -= 27
  if (v !== 0 && v !== 1) throw new Error('Bad signature v')
  const pub = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(v).recoverPublicKey(hash)
  return addressFromPublicKey(pub.toRawBytes(false))
}

const SCORE_TYPEHASH = keccakHex(utf8ToBytes('BlockHuntScore(v3)'))

/** Exactly mirrors BlockHuntV3.scoreDigest(). */
export function scoreDigest({ chainId, contract, player, modeId, roundId, nonce, timeMs }) {
  const encoded =
    word(SCORE_TYPEHASH, 'bytes32') +
    word(chainId) +
    word(contract, 'address') +
    word(player, 'address') +
    word(modeId) +
    word(roundId) +
    word(nonce) +
    word(timeMs)
  const inner = keccak_256(hexToBytes(encoded))
  return keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n32'), inner))
}

/** 65-byte r||s||v signature (low-s, v = 27/28) the contract accepts. */
export function signScore(privateKey, fields) {
  const sig = secp256k1.sign(scoreDigest(fields), hexToBytes(strip0x(privateKey)), { lowS: true })
  return '0x' + sig.toCompactHex() + (27 + sig.recovery).toString(16)
}

/** eth_call against the V3 contract's getPlayer(uint8,uint256,address). */
export async function getPlayer(rpcUrl, contract, modeId, roundId, player) {
  const data = '0x' + selector('getPlayer(uint8,uint256,address)') + word(modeId) + word(roundId) + word(player, 'address')
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: contract, data }, 'latest'] })
  })
  const json = await res.json()
  if (json.error || !json.result || json.result === '0x') throw new Error('Chain read failed')
  const h = strip0x(json.result)
  return {
    entries: Number(BigInt('0x' + h.slice(0, 64))),
    attempts: Number(BigInt('0x' + h.slice(64, 128))),
    bestMs: Number(BigInt('0x' + h.slice(128, 192)))
  }
}

/** Same round maths as BlockHuntV3.roundIdAt(). */
export function roundIdAt(modeId, unixSeconds) {
  const day = Math.floor(unixSeconds / 86400)
  return modeId === 2 ? Math.floor((day + 4) / 7) : day
}

export function startMessage({ player, mode, ts, req }) {
  return `BlockHunt tournament start\nWallet: ${player.toLowerCase()}\nMode: ${mode}\nTime: ${ts}\nRequest: ${req}`
}
