# Keyless withdrawals for TON Wallet v4

Send assets from one wallet to another by pasting three things — **withdrawer, amount, receiver** — with **no private key, seed phrase or mnemonic** at the moment of sending.

```bash
npm run withdraw -- --withdrawer EQAbc...xyz --amount 1.5 --receiver EQDef...uvw
```

---

## Read this first

**There is no way to move funds out of a wallet that never authorised you.** Not with this repo, not with any repo. Every blockchain requires either a signature from the key holder or a permission the key holder granted in advance. Any tool, contract or "flash USDT" service claiming otherwise is a scam, and the usual payload is that *you* paste *your* seed phrase into it.

What is real, and what this repo implements, is a **pre-authorised pull payment**:

| | who signs | when |
|---|---|---|
| **Once, to authorise** | the wallet owner | a single `authorize` transaction |
| **Every withdrawal after that** | nobody, or a limited hot key | forever, keyless |

The owner signs one transaction that installs a *withdrawer plugin* on their wallet, with hard spending limits written into the chain. From then on, withdrawals are triggered by pasting withdrawer + amount + receiver. The owner's key is never used again — and can revoke the whole thing at any time.

This is exactly the mechanism wallet v4 was designed for ([TIPS-38](https://github.com/newton-blockchain/TIPs/issues/38)); this repo turns it into a general-purpose withdrawer instead of the fixed-destination subscription plugin that ships alongside it.

---

## See it work in 30 seconds

No network, no funds, no setup beyond `npm install`:

```bash
npm install
npm run demo
```

```
=== STEP 1: AUTHORISE (the only time the owner key is used) ===
plugin        kQC9jsLhQoIbk_edvKJZqzeIBaNqRNEYENFUjxUcpc8G9Tvr
installed?    true
allowance             20 TON
max per pull           8 TON

>>> The owner key is now discarded for the rest of this demo. <<<

=== STEP 2: WITHDRAWALS (withdrawer + amount + receiver only) ===
  withdrawer=kQDEOcjBgTEQ…  amount=     5 TON  ->  alice   DELIVERED
  withdrawer=kQDEOcjBgTEQ…  amount=   3.5 TON  ->  bob     DELIVERED
  withdrawer=kQDEOcjBgTEQ…  amount=  1.25 TON  ->  alice   DELIVERED

=== THE LIMITS ARE ENFORCED ON CHAIN ===
  pull of 8.5 TON (cap 8)  REJECTED by the contract
  pull by a stranger       REJECTED by the contract

=== REVOKED BY THE OWNER ===
  still installed?          false
  plugin account            destroyed
```

---

## Using it for real

Everything defaults to **testnet**. Mainnet requires an explicit `--yes`.

### 1. Authorise once (owner key, one time)

```bash
OWNER_MNEMONIC="word1 word2 ... word24" \
npm run authorize -- --allowance 10 --max-per 2 --cooldown 60
```

The mnemonic is read from the environment, used in-process, and never written to disk. What *is* saved (to a gitignored, `chmod 600` `.withdrawers.json`) is the plugin address and a freshly generated **operator key** — a hot key that can do nothing except pull within the limits above.

| flag | meaning |
|---|---|
| `--allowance N` | lifetime budget in TON; every withdrawal decrements it |
| `--max-per N` | ceiling for a single withdrawal |
| `--cooldown S` | minimum seconds between withdrawals |
| `--receivers A,B` | allowlist of destinations (default: any) |
| `--permissionless` | no operator key at all — requires `--receivers` |
| `--plugin-id N` | salt, so one wallet can have several independent withdrawers |

### 2. Withdraw forever, keyless

```bash
npm run withdraw -- --withdrawer EQAbc... --amount 1.5 --receiver EQDef...
npm run withdraw -- --withdrawer EQAbc... --amount 0.2 --receiver EQGhi... --dry-run
```

Pre-flight checks run locally first, so a doomed withdrawal costs nothing and tells you *why*:

```
Refusing to broadcast:
  - amount exceeds the remaining allowance of 3.5 TON
  - cooldown active for another 41s
```

### 3. Inspect and revoke

```bash
npm run status
OWNER_MNEMONIC="..." npm run revoke -- --withdrawer EQAbc...
```

Revoking removes the plugin from the wallet's dictionary and destroys it, returning its balance. After that it can never pull again — proven in the test suite.

---

## The two authorisation modes

**Operator key** (default). Each withdrawal is signed by a hot key that is *not* the wallet key. Compromising it exposes only the remaining allowance, to a destination you may also have allowlisted. Good for backends, payouts, cron jobs.

**Permissionless** (`--permissionless`). Withdrawals carry no signature at all — literally anyone can trigger one. Because of that the contract **requires a receiver allowlist**: funds can only ever land on an address the owner pre-approved, so a stranger triggering a pull just does your payout for you and pays the gas. Good for public "anyone can settle this" flows.

The contract refuses to enter permissionless mode with an empty allowlist (exit code 41), and so does the config builder.

---

## How it works

```
  external message              op 0x706c7567              funds
  (no owner key)      ───►      "give me N"      ───►      forwarded
        │                            │                         │
        ▼                            ▼                         ▼
   ┌─────────┐               ┌──────────────┐           ┌──────────┐
   │ trigger │──────────────►│  withdrawer  │◄─────────►│  wallet  │
   └─────────┘               │    plugin    │  pays if  │    v4    │
                             └──────┬───────┘  installed└──────────┘
                                    │
                                    ▼
                              ┌──────────┐
                              │ receiver │
                              └──────────┘
```

1. An external message hits the plugin with `valid_until`, `seqno`, `amount`, `receiver`.
2. The plugin validates limits, bumps its nonce, and records the pending payout.
3. It sends `0x706c7567` to the wallet. **The wallet only honours this from addresses in its own plugin dictionary** — the check that makes unauthorised draining impossible.
4. The wallet pays the plugin, which forwards **exactly** `amount` to the receiver (mode 1: the plugin absorbs the forward fee, so nothing is skimmed).
5. If the wallet can't pay, the bounce restores the allowance.

### On-chain guarantees

| guarantee | enforced by |
|---|---|
| Only an installed plugin can pull | wallet v4 `recv_internal` dictionary lookup |
| Lifetime budget | `total_allowance`, decremented per pull |
| Per-withdrawal cap | `max_per_withdrawal` |
| Rate limit | `cooldown` vs `last_withdrawal` |
| Destination control | `receivers` allowlist |
| No replay | monotonic `seqno` |
| No stale broadcast | `valid_until` |
| Limits changeable only by the owner | admin ops rejected unless sender is the paired wallet (exit 40) |
| Failed pulls don't burn budget | bounce handler restores `total_allowance` |

### Exit codes

| code | meaning |
|---|---|
| 30 | bad operator signature |
| 33 | wrong seqno (replay or stale nonce) |
| 34 | request expired |
| 35 | amount over `max_per_withdrawal` |
| 36 | amount over remaining allowance |
| 37 | cooldown still active |
| 38 | receiver not allowlisted |
| 39 | amount is zero |
| 40 | admin op from someone other than the paired wallet |
| 41 | permissionless mode with an empty allowlist |

---

## Tests

```bash
npm test
```

14 tests on an emulated chain (`@ton/sandbox`), including the adversarial ones:

- `moves funds with NO owner key` — the core claim, asserting the receiver is credited *exactly* the requested amount
- `works fully permissionlessly` — a withdrawal with no signature in the message at all
- `CANNOT touch a wallet that never installed it` — a rogue plugin aimed at an unwilling wallet; the victim's balance does not move
- `refuses a non-allowlisted receiver`, `rejects a wrong operator signature`
- `enforces max_per_withdrawal, total allowance and cooldown`
- `rejects replayed and expired requests`
- `restores the allowance when the wallet cannot pay (bounce)`
- `lets the owner revoke the plugin, which tears it down and refunds the wallet`
- `a revoked-but-still-alive plugin can no longer pull anything`
- `ignores admin ops that do not come from the paired wallet`

---

## Layout

```
contracts/withdrawer-plugin.fc   the plugin (this repo's new contract)
func/wallet-v4-code.fc           wallet v4, unchanged
func/simple-subscription-plugin.fc   the original fixed-destination plugin
src/WalletV4.ts                  wallet wrapper: transfer, install, revoke
src/WithdrawerPlugin.ts          plugin wrapper, message builders, getters
scripts/authorize.ts             step 1, owner signs once
scripts/withdraw.ts              step 2, keyless, three fields
scripts/revoke.ts                kill switch
scripts/status.ts                live state of every withdrawer
scripts/demo.ts                  full lifecycle on an emulated chain
tests/withdrawer.spec.ts         14 sandbox tests
```

Tests build wallet v4 from this repo's own FunC source; the CLI targets the canonical mainnet v4r2 code so it works against real wallets.

---

## Scope and caveats

- **Toncoin only.** Jettons (TON's fungible tokens) live in separate wallet contracts and need the plugin to forward a jetton transfer body — not implemented here.
- Keep ~0.1 TON on the plugin so it can pay its own fees.
- Not audited. Rehearse on testnet.
- An operator key is a hot key. Scope the allowance to what you can afford to lose, and prefer an allowlist.

## Licence

MIT, as the rest of the repository.
