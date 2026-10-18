// Creates the score-server signing key and stores it as a Cloudflare secret.
// The key is never printed or written to disk — only its public address is shown,
// which is what you paste into the contract deploy page.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { addressFromPrivateKey } from '../src/eth.js'

const key = '0x' + randomBytes(32).toString('hex')
const address = addressFromPrivateKey(key)

const child = spawn('npx', ['wrangler', 'secret', 'put', 'SIGNER_KEY'], { stdio: ['pipe', 'inherit', 'inherit'], shell: process.platform === 'win32' })
child.stdin.end(key + '\n')
child.on('exit', code => {
  if (code !== 0) {
    console.error('\n❌ Could not save the key to Cloudflare. Run `npx wrangler login` first, then try again.')
    process.exit(1)
  }
  console.log('\n✅ Score-server key saved to Cloudflare.')
  console.log('\n   SIGNER ADDRESS (paste this into the deploy page):\n')
  console.log('   ' + address + '\n')
})
