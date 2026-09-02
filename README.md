# Keyless withdrawals — TON, Ethereum, Bitcoin

Authorise a wallet **once**. After that, move funds by pasting three things — **withdrawer, amount, receiver** — with no private key, seed phrase or mnemonic at the moment of sending.

```bash
npm run withdraw -- --withdrawer <WALLET> --amount 1.5 --receiver <ADDRESS>   # TON
```

| chain | package | mechanism | arbitrary amount + receiver? | limits enforced by | gas paid by |
|---|---|---|---|---|---|
| **TON** | `/` (root) | wallet-v4 plugin | yes | the chain | sender wallet |
| **Ethereum / EVM** | `evm/` | `approve` + `transferFrom`, or an ETH vault | yes | the chain | sender wallet |
| **Bitcoin** | `btc/` | pre-signed transactions | **no — fixed at signing time** | cryptography | sender wallet |

```bash
npm install && npm run demo          # TON   18 tests
cd evm && npm install && npm test    # EVM   28 tests
cd btc && npm install && npm test    # BTC   11 tests
```

Gas is paid by the **sender wallet** on all three chains — see [Who pays the gas](#who-pays-the-gas).

---

## Read this first

**There is no way to move funds out of a wallet that never authorised you.** Not with this repo, not with any repo. Every blockchain requires either a signature from the key holder or a permission the key holder granted in advance. Any tool claiming otherwise is a scam, and the payload is almost always "paste your seed phrase here."

What is real, and what this repo implements, is a **pre-authorised pull payment**:

| | who signs | when |
|---|---|---|
| **Once, to authorise** | the wallet owner | a single setup transaction |
| **Every withdrawal after that** | nobody, or a limited hot key | forever, keyless |

---

## Bitcoin is genuinely different — please read

TON and Ethereum can enforce an allowance *on chain*: a capped, revocable permission that a limited key may exercise. **Bitcoin cannot.** It has no accounts, no `approve`, and no programmability that can say "this key may spend at most X." On Bitcoin, anything that can sign can sign away everything.

So there are exactly two options, and neither is what the other two chains do:

**A. Pre-signed vault — what `btc/` implements.** The owner signs a batch of withdrawals *in advance*. Broadcasting one later needs no key from anyone, and the limits are absolute because no other spend was ever signed. **The cost: amount and receiver are fixed when the vault is created.** You cannot paste an arbitrary amount to an arbitrary address.

**B. A hot key that holds the coins.** This allows arbitrary amounts and receivers, but "limits" exist only in your software. If the key leaks, everything goes. That is custody with extra steps, so this repo does not implement it.

If you need arbitrary keyless BTC payouts, the honest answer is that you want option B and should use a custodial provider that does it properly, or move that flow to TON/EVM.

---

## Who pays the gas

**The sender wallet does, on all three chains.** Whoever triggers a withdrawal should never be out of pocket, and receivers are always credited the full amount — never net of a fee.

| chain | how the sender pays | broadcaster's net cost |
|---|---|---|
| **TON** | the plugin requests `amount + fees` from the wallet and forwards `amount` with send-mode 1, so it reimburses its own outlay | zero — external messages are gasless to send |
| **Ethereum** | the withdrawal measures its own gas and refunds the broadcaster in ETH from the owner's **gas tank** | ~1% (a deliberate under-estimate; see below) |
| **Bitcoin** | the fee is pre-funded into each bucket by the split transaction | zero — no input of their own is needed |

**TON.** The plugin fronts the request-leg gas from its own float and asks the wallet for enough to cover that, the external-message gas, the payout leg and the forward fee. Its balance is flat-to-slightly-positive across withdrawals, so it runs indefinitely without being topped up, and the accumulated float returns to the wallet on revoke. Both properties are asserted in the tests.

**Ethereum.** `authorize(..., maxGasReimbursement)` with ETH attached funds a **gas tank** kept strictly separate from the ETH vault, so paying for gas can never eat the principal. Each withdrawal meters `gasleft()` and refunds `msg.sender`.

Three independent limits bound the refund, and they matter:

- `maxGasReimbursement` — the owner's per-withdrawal ceiling. **Without this a hostile relayer could broadcast at a 5000 gwei gas price and drain the tank**; there is a test for exactly that.
- the actual measured gas, so a refund can never exceed what was really burned.
- the tank balance — and when it is empty the withdrawal still succeeds, with the broadcaster simply absorbing the cost.

`GAS_OVERHEAD` (38,000) covers the intrinsic cost, calldata and the refund transfer itself. It is **deliberately a slight under-estimate**: over-estimating would let relayers turn a profit at the sender's expense, so the broadcaster is left ~1% short rather than the sender ever overpaying.

**Bitcoin.** Each split output holds `amount + fee`, so a pre-signed withdrawal spends its bucket and pays exactly `amount` to the receiver, with the difference going to the miner. A test checks the whole ledger balances: `payouts + withdrawal fees + split fee + change == funding`.


---

## TON — see it work in 30 seconds

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

---

## Ethereum / EVM

`evm/contracts/Withdrawer.sol` — one contract serving many owners, many tokens.

```bash
cd evm && npm install
npx hardhat test              # 18 tests
npx hardhat run scripts/demo.ts
```

**Authorise once** (two owner-signed calls, both standard):

```solidity
token.approve(withdrawer, 100e18);                      // the ERC-20's own gate
// allowance, per-tx cap, cooldown, allowlist, max gas reimbursement
withdrawer.authorize{value: 0.5 ether}(token, operator, 50e18, 10e18, 0, [], 0.05 ether);
```

**Withdraw forever, keyless.** Anyone can broadcast it and they pay the gas:

```solidity
withdrawer.withdraw(owner, token, amount, receiver, deadline, operatorSignature);
```

Native ETH has no `approve`, so it uses a vault: the owner deposits with `authorize{value: ...}` or `depositEth()`, and can always pull it back with `withdrawEth()`. ERC-20s are never held by the contract — the pull is a plain `transferFrom` gated by the owner's own approval, so shrinking the approval instantly caps the damage regardless of the policy.

`canWithdraw(owner, token, amount, receiver)` is a free view that returns the same verdict the state-changing path would, with a human-readable reason.

Same two modes as TON: an **operator key** signing EIP-712, or **permissionless** (`operator = address(0)`, empty signature) which the contract only permits alongside a receiver allowlist.

---

## Bitcoin

`btc/src/vault.ts` — a pre-signed vault. Read the Bitcoin caveat above before using this.

```bash
cd btc && npm install
npm test        # 9 tests
npm run demo
```

```
=== STEP 2: WITHDRAWALS (paste amount + receiver, no key) ===
    0.00100000 BTC -> alice  txid=af04eedcb520ee0d…  signed=true  fee=550 sat
    0.00250000 BTC -> bob    txid=e9a70040b36d1ab2…  signed=true  fee=550 sat

=== WHAT IS AND IS NOT POSSIBLE ===
  an amount nobody pre-signed         DOES NOT EXIST
  a receiver nobody pre-signed        DOES NOT EXIST
  redirecting a pre-signed payout     BREAKS THE SIGNATURE
```

**How it works.** One owner-signed *split* transaction fans the funding UTXO into a dedicated output per planned withdrawal, plus change. The owner then pre-signs one withdrawal per output. Because each spends a **different** output, they are not double-spends of one another and can be broadcast independently, in any order, or never.

**Guarantees**, from cryptography rather than from a contract:

| guarantee | why |
|---|---|
| Broadcasting needs no key | the signatures already exist |
| Receiver cannot be changed | `SIGHASH_ALL` covers the outputs; the tests prove tampering invalidates it |
| Amount cannot be raised | same |
| Only planned payouts can happen | nothing else was ever signed |
| Withdrawals don't conflict | each spends its own split output |
| Owner can cancel | spend the split outputs elsewhere first |

`inspectPresigned()` re-derives receiver, amount and signedness straight from the raw transaction, so a holder never has to trust the JSON sitting next to it.


## How the TON plugin works

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

## TON tests

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

## Running against a live network

Each chain has a self-contained runner. All three generate a throwaway testnet
key on first run, print the address to fund, and exit. Fund it, run the same
command again, and it completes end to end.

Secrets go to gitignored `chmod 600` files and are never committed.

**Nothing that can hold value is ever discarded.** Every generated key --
owner, operator, relayer, receiver -- is written to `.live-key.json` *before*
anything is funded, and the EVM runner sweeps unspent relayer gas back to the
owner when it finishes. Set `RECEIVER` to use an address you already control.

### Ethereum (Sepolia)

```bash
cd evm && npm install
RPC_URL=https://ethereum-sepolia-rpc.publicnode.com npm run live
```

Send the tokens to an address you control so you can watch them arrive:

```bash
RPC_URL=... RECEIVER=0xYourAddress npm run live
```

Needs ~0.08 test ETH for 8 transactions (the last one sweeps unspent relayer
gas back to you).
Faucets: [sepoliafaucet.com](https://sepoliafaucet.com), [Google Cloud faucet](https://cloud.google.com/application/web3/faucet/ethereum/sepolia).

Prints the gas ledger the run exists to validate:

```
gasUsed     127816
gasPrice    1.348691336 gwei

=== GAS ACCOUNTING ===
  burned by the transaction   0.000172384331802176 ETH
  reimbursed from sender      0.000170409847686272 ETH
  relayer net cost            0.000001974484115904 ETH
  relayer out of pocket       1.14% of gas burned
  reimbursement <= burned?    YES (relayer cannot profit)
```

Against a local node instead:

```bash
npx hardhat node                             # terminal 1
RPC_URL=http://127.0.0.1:8545 npm run live   # terminal 2
```

### Bitcoin (signet)

```bash
cd btc && npm install
npm run live
```

```bash
RECEIVER=tb1qYourAddress npm run live
```

Needs ~0.0006 signet BTC. Faucet: [signetfaucet.com](https://signetfaucet.com).
Wait for 1 confirmation before re-running. `BROADCAST=0 npm run live` builds and
pre-signs everything without broadcasting.

Step 3 is the interesting one: the withdrawal was signed in step 1, so nothing
signs it at broadcast time.

### TON (testnet)

Uses the CLI documented above:

```bash
npm install
OWNER_MNEMONIC="..." npm run authorize -- --allowance 5 --max-per 1
npm run withdraw -- --withdrawer <WALLET> --amount 0.5 --receiver <ADDRESS>
```

Faucet: [@testgiver_ton_bot](https://t.me/testgiver_ton_bot). Needs ~2 test TON.

To mint funding addresses for all three chains at once: `npm run testnet:addresses`.


---

## Scope and caveats

- **Toncoin only.** Jettons (TON's fungible tokens) live in separate wallet contracts and need the plugin to forward a jetton transfer body — not implemented here.
- Keep ~0.1 TON on the plugin so it can pay its own fees.
- Not audited. Rehearse on testnet.
- An operator key is a hot key. Scope the allowance to what you can afford to lose, and prefer an allowlist.

## Licence

MIT, as the rest of the repository.
