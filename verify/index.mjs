#!/usr/bin/env node
/**
 * Offline verifier for the Dextools "Verify your account" message (EVM/Rabby).
 *
 * SECURITY NOTE:
 *   This script NEVER asks for or stores your private key.
 *   Signing is done by your wallet (Rabby / MetaMask / etc.) in YOUR browser,
 *   because the private key never leaves that wallet. This script only takes
 *   the safe public inputs (message + address + signature) and checks that
 *   the signature was produced by the address being verified.
 *
 * Usage:
 *   node index.mjs verify <address> <signature>
 *   node index.mjs verify <address> <signature> --message-file message.txt
 *   MESSAGE="..." ADDRESS="0x..." SIGNATURE="0x..." node index.mjs verify
 *
 * The default message is the Dextools challenge:
 *   "Verify your account in Dextools.io\nVerification token 8cb9f47a53ebf75efb3b3aa2beb9d381315f72d0"
 *
 * The signature must be the 65-byte hex string (0x + 130 hex chars) returned
 * by Rabby/MetaMask from `personal_sign` / `signMessage`.
 */
import { readFileSync } from 'node:fs';
import { verifyMessage } from 'ethers';

const DEFAULT_MESSAGE = [
  'Verify your account in Dextools.io',
  'Verification token 8cb9f47a53ebf75efb3b3aa2beb9d381315f72d0',
].join('\n');

function readFile(path) {
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
}

function normalizeSignature(sig) {
  let s = (sig || '').trim();
  if (s.startsWith('0x')) s = s.slice(2);
  if (s.length !== 130) {
    throw new Error(
      `Signature must be exactly 65 bytes / 130 hex chars (with 0x), got ${s.length}.`
    );
  }
  return '0x' + s;
}

function normalizeAddress(addr) {
  return (addr || '').trim().toLowerCase();
}

function printHelp() {
  console.log(`Dextools EVM signature verifier

Usage:
  node index.mjs verify <address> <signature>
  node index.mjs verify <address> <signature> --message-file message.txt
  MESSAGE="..." ADDRESS="0x..." SIGNATURE="0x..." node index.mjs verify

Options:
  --message-file <path>  Read the signed message from a file instead of the default.
  --help, -h             Show this help.

The signature should be the 65-byte hex returned by Rabby/MetaMask
("Ethereum Signed Message" / personal_sign). The script recovers the signer
address locally and compares it to the address you provide.
`);
}

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    return;
  }

  let command = null;
  let address = null;
  let signature = null;
  let manifest = 'arg';
  let message = DEFAULT_MESSAGE;

  // Parse simple positional + --message-file pattern.
  if (argv[0] === 'verify') {
    command = 'verify';
    const rest = argv.slice(1);
    const fileIndex = rest.indexOf('--message-file');
    if (fileIndex !== -1) {
      const filePath = rest[fileIndex + 1];
      if (!filePath) {
        console.error('--message-file requires a path.');
        process.exit(2);
      }
      message = readFile(filePath);
      const remaining = [
        ...rest.slice(0, fileIndex),
        ...rest.slice(fileIndex + 2),
      ];
      address = remaining[0] || process.env.ADDRESS || '';
      signature = remaining[1] || process.env.SIGNATURE || '';
    } else {
      address = rest[0] || process.env.ADDRESS || '';
      signature = rest[1] || process.env.SIGNATURE || '';
    }
  }

  // Allow fully env-driven invocation (no positional args).
  if (!command) {
    command = process.env.COMMAND || 'verify';
    address = process.env.ADDRESS || '';
    signature = process.env.SIGNATURE || '';
    message = process.env.MESSAGE || DEFAULT_MESSAGE;
  }

  if (command !== 'verify') {
    console.error(`Unknown command "${command}". Only "verify" is supported.`);
    process.exit(2);
  }

  if (!address) {
    console.error('Missing address. Pass it as <address> or set ADDRESS env var.');
    process.exit(2);
  }
  if (!signature) {
    console.error('Missing signature. Pass it as <signature> or set SIGNATURE env var.');
    process.exit(2);
  }
  if (process.env.MESSAGE) {
    message = process.env.MESSAGE;
  }

  let normalizedSig;
  try {
    normalizedSig = normalizeSignature(signature);
  } catch (err) {
    console.error(`Invalid signature: ${err.message}`);
    process.exit(2);
  }

  let recovered;
  try {
    recovered = verifyMessage(message, normalizedSig).toLowerCase();
  } catch (err) {
    console.error(`Could not recover signer from signature: ${err.message}`);
    process.exit(1);
  }

  const expected = normalizeAddress(address);
  const ok = recovered === expected;

  if (ok) {
    console.log('VERIFIED: signature is valid for this address.');
    console.log(`  message   : ${JSON.stringify(message)}`);
    console.log(`  expected  : ${expected}`);
    console.log(`  recovered : ${recovered}`);
    process.exit(0);
  } else {
    console.log('NOT VERIFIED: recovered signer does not match the address.');
    console.log(`  message   : ${JSON.stringify(message)}`);
    console.log(`  expected  : ${expected}`);
    console.log(`  recovered : ${recovered}`);
    process.exit(1);
  }
}

main();
