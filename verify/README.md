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
