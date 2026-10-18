# BlockHunt 🦉

**Crypto word hunt — find the words, win the AVAX.**

Live at **https://breezusmoon.github.io/Blockhunt/**

## Modes

| Mode | Cost | Words | Hints | Prizes |
|---|---|---|---|---|
| Free play | Free | 6 | 3 | Bragging rights |
| Daily challenge | Free | 8 | — | Same puzzle for everyone today |
| 1v1 | Free | — | — | Challenge a mate with a link |
| Easy tournament | 0.05 AVAX | 6 | 3 | Top 3 · 70/20/10 · daily |
| Hard tournament | 0.085 AVAX | 10 | 1 | Top 3 · 70/20/10 · daily |
| Weekly championship | 0.10 AVAX | 12 | 0 | Top 3 · 70/20/10 · Sun→Sun |

Paid tournaments run on **BlockHunt V3** (Avalanche C-Chain) with server-verified,
signature-checked scores. See [DEPLOY.md](DEPLOY.md) for launch steps and the full rules.

## What's where

```
index.html              the game (single page, no build step)
assets/                 logo, icons, fighter portraits (WebP)
js/puzzle.js            shared puzzle engine — used by the game AND the score server
js/tournament.js        paid tournaments, live pools/boards/feed, claims, referrals
js/share.js             share-image card
contracts/              BlockHuntV3.sol + Foundry tests
worker/                 score server (Cloudflare Worker + Durable Object)
tools/deploy-v3.html    one-click contract deploy page
tests/                  puzzle, browser and end-to-end tests (tests/run-local.sh)
.github/workflows/      Pages deploy + daily auto-settle
```

## Deploy

Push to `main` → GitHub Actions publishes the site (only the game files, not the contracts
or server code).
