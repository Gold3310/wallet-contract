# Dextools signature verifier (EVM / Rabby)

This small tool verifies the Dextools wallet-ownership signature offline.

It never asks for, reads, stores, or transmits your private key. It only takes
the three public values:

- the plaintext **message**
- the EVM **address** you are verifying
- the 65-byte **signature** produced by Rabby/MetaMask

It recovers the signer from the signature and compares it to your address.

## Message used by default

```
Verify your account in Dextools.io
Verification token 8cb9f47a53ebf75efb3b3aa2beb9d381315f72d0
```

## How it works / browser signer

`sign.html` is a safe local helper that:

1. detects and auto-connects to Rabby (still gated by Rabby's own account chooser)
2. shows the exact message to sign
3. waits for **you** to click "Sign message" and then **approve in Rabby**
4. recovers the signer locally and reports VERIFIED / NOT VERIFIED
5. copies the verified signature to your clipboard

## Why there is no auto-sign / auto-broadcast

Dextools account verification uses a **message signature**, not an on-chain
transaction. There is nothing to broadcast: the signature is sent to Dextools'
server and verified against your address. No gas fee, token allowance, contract
call, or funds transfer is required.

Consequently this tool intentionally does **not**:

- auto-sign messages without a wallet prompt
- sign a transaction
- broadcast, submit, or forward anything on-chain
- request or store the private key / seed phrase

Automatically signing and broadcasting without confirmation is how wallets are
drained, so it is deliberately out of scope.

If a prompt asks you to broadcast a transaction or approve a token to "verify"
your account, **do not sign** — that is not the normal Dextools flow.

## Install

```bash
cd verify
npm install
```

## Verify a signature

```bash
node index.mjs verify 0xYOUR_ADDRESS 0xSIGNATURE
```

Or with environment variables / a message file:

```bash
ADDRESS=0xYOUR_ADDRESS SIGNATURE=0xSIGNATURE node index.mjs verify
node index.mjs verify 0xYOUR_ADDRESS 0xSIGNATURE --message-file message.txt
```

## Exit codes

- `0`  – signature is valid for the given address
- `1`  – signature could not be verified against the address
- `2`  – missing/malformed input

## Where to get the signature

Sign the message from the **Rabby** browser extension (or MetaMask /
WalletConnect) during the Dextools verification flow. Rabby returns the
signature as `0x`-prefixed hex (130 hex characters, 65 bytes) after you approve
in the wallet prompt. Paste that hex into the command above.

Do not send your seed phrase, private key, or backup phrase to anyone.
