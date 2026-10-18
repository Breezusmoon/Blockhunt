import test from 'node:test'
import assert from 'node:assert'
import { cleanName } from '../src/index.js'
import { roundIdAt, startMessage, addressFromPrivateKey, recoverPersonalSign } from '../src/eth.js'
import { secp256k1 } from '@noble/curves/secp256k1'
import { keccak_256 } from '@noble/hashes/sha3'
import { utf8ToBytes, concatBytes, hexToBytes } from '@noble/hashes/utils'

test('names are cleaned', () => {
  assert.strictEqual(cleanName('<b>Breezus</b> 🦉'), 'bBreezusb 🦉')
  assert.strictEqual(cleanName(''), 'Player')
  assert.strictEqual(cleanName('a'.repeat(40)).length, 18)
})

test('round ids match the contract', () => {
  assert.strictEqual(roundIdAt(2, 3 * 86400), 1) // Sun 4 Jan 1970
  assert.strictEqual(roundIdAt(2, 3 * 86400 - 1), 0)
  assert.strictEqual(roundIdAt(0, 1792281600), 20744)
})

test('personal_sign recovery', () => {
  const key = '0x' + '42'.repeat(32)
  const msg = startMessage({ player: addressFromPrivateKey(key), mode: 'easy', ts: 1, req: 'ab'.repeat(8) })
  const m = utf8ToBytes(msg)
  const h = keccak_256(concatBytes(utf8ToBytes('\x19Ethereum Signed Message:\n' + m.length), m))
  const s = secp256k1.sign(h, hexToBytes('42'.repeat(32)))
  const sig = '0x' + s.toCompactHex() + (27 + s.recovery).toString(16)
  assert.strictEqual(recoverPersonalSign(msg, sig), addressFromPrivateKey(key))
})
