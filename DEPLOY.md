# Launching BlockHunt V3 (paid tournaments)

Until this is done the site runs free play, daily challenge and 1v1 — paid buttons say
"opening soon". About 15 minutes on your Mac. Nothing here touches the old V2 contract
(it never had any entries, so there's nothing to migrate).

**You need:** Terminal, ~0.1 AVAX in your house wallet for gas, a free Cloudflare account
(sign up at https://dash.cloudflare.com/sign-up).

---

### 1. Get the code

```bash
node -v            # if this errors, install the LTS from https://nodejs.org first
git clone https://github.com/Breezusmoon/Blockhunt.git
cd Blockhunt/worker
npm install
npx wrangler login # a browser tab opens — click Allow
```

### 2. Create the score-server key

```bash
node scripts/new-signer.mjs
```

It saves a brand-new signing key straight into Cloudflare (it's never shown or saved on
your Mac) and prints a **SIGNER ADDRESS**. Copy that address.

> This key only signs scores. It never holds money. If it ever leaks, run this script again
> and update the contract with `setSigner` — no funds are at risk while you do.

### 3. Deploy the contract

Open **https://breezusmoon.github.io/Blockhunt/tools/deploy-v3.html** in the browser that has
Core Wallet.

1. Connect your **house wallet** (`0x0EA9…f789`) — it becomes the owner and receives the house cut
2. Paste the SIGNER ADDRESS
3. Deploy → confirm in Core (≈0.01–0.05 AVAX gas)

Copy the **contract address** it shows.

### 4. Start the score server

```bash
npx wrangler deploy --var CONTRACT_ADDRESS:0xYOUR_CONTRACT_ADDRESS
```

It prints a URL like `https://blockhunt-score.<your-name>.workers.dev`. Open
`<that URL>/health` — it should show your contract and signer.

### 5. Switch the site on

Send Claude the **contract address** and the **worker URL**. Claude puts them into
`js/tournament.js` (`BH_CONFIG`) and `worker/wrangler.toml` and pushes — the buttons go live
about a minute later.

### 6. Fix the settle bot's key ⚠️

The GitHub secret `SETTLE_PRIVATE_KEY` currently holds your **house wallet** key. Replace it:

1. In Core, create a new account (call it "Settle bot") and send it ~0.2 AVAX
2. Export that account's private key
3. GitHub → Blockhunt → Settings → Secrets and variables → Actions → `SETTLE_PRIVATE_KEY` → **Update** → paste the bot key

Settling is open to anyone in V3, so the bot only ever needs gas money.

### 7. Verify on Snowtrace (Claude can do this for you)

Upload `contracts/BlockHuntV3.standard-input.json`, compiler `v0.8.24+commit.e11b9ed9`,
contract `src/BlockHuntV3.sol:BlockHuntV3`, constructor args = house + signer addresses.

### 8. Smoke test

Enter Easy with a real 0.05 AVAX, play, submit. You should appear on the board and in the
live feed. After 00:10 UTC the bot settles and the prize lands in your wallet.

---

## How V3 works

| | |
|---|---|
| Entry fees | Easy 0.05 · Hard 0.085 · Weekly 0.10 AVAX |
| House cut | 5% Easy / Hard · 10% Weekly (taken at entry, claim any time) |
| Referrals | 2% of every entry a referred friend makes, paid out of the house cut |
| Prizes | Top 3 split the pool 70 / 20 / 10. Empty places go to 1st |
| Nobody finishes | Whole pool rolls into the live round of that mode |
| Rounds | Daily = UTC day. Weekly = Sunday 00:00 UTC → Sunday. 10-minute grace to finish |
| Attempts | One paid entry = one fresh puzzle. Enter again to retry. Best time counts |
| Anti-cheat | The score server picks each puzzle, times the game itself, re-checks every word and rejects bot-speed finishes. The contract only accepts scores it signed |
| Payouts | Sent automatically on settle; if a wallet bounces it, the prize waits under Claim |
| Owner powers | Rotate the signer key, pause new entries. Can never touch pools or fees |

## Running the tests

```bash
FOUNDRY=<foundry bin dir> PW_DIR=<dir with puppeteer-core + @sparticuz/chromium> bash tests/run-local.sh
```

Runs the contract tests (incl. fuzzing), puzzle engine checks, a full score-server game on a
local chain, and headless browser tests on desktop, phone and a real paid game.
