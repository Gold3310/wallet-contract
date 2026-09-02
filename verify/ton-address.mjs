#!/usr/bin/env node
/**
 * TON address decoder / comparator — offline, dependency-free.
 *
 * What it does:
 *   - decodes TON user-friendly addresses (EQ.../UQ...) and raw addresses (0:.../-1:...)
 *   - validates the CRC16 (catches typos / corrupted copies)
 *   - shows the hidden fields: bounceable flag, testnet-only flag, workchain, account id
 *   - compares addresses and tells you whether they are the SAME on-chain account
 *     (just a different spelling) or genuinely DIFFERENT accounts
 *
 * SECURITY: addresses are public information. This tool never asks for and never
 * needs your seed phrase or private key. Never paste a seed/key into any tool
 * or website to "verify" an address.
 *
 * Usage:
 *   node ton-address.mjs compare <addr1> <addr2> [addr3...]   compare addresses
 *   node ton-address.mjs info <addr>                          decode one address
 *   node ton-address.mjs convert <addr>                       show all spellings
 *   node ton-address.mjs                                      help
 *
 * Exit codes:
 *   0 - all compared addresses are the same on-chain account
 *   1 - compared addresses are different on-chain accounts
 *   2 - malformed input (bad base64, CRC mismatch, unknown form)
 */

// ---------------------------------------------------------------- crc16 xmodem

function crc16xmodem(buf) {
  let crc = 0x0000;
  for (const byte of buf) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc >>> 0;
}

// ---------------------------------------------------------------- parsing

/**
 * User-friendly form: 36 bytes, base64 (48 chars, no padding):
 *   byte 0      flags: 0x11 bounceable / 0x51 non-bounceable; |0x80 = testnet-only
 *   byte 1      workchain id (0x00 = basechain, 0xff = masterchain -1)
 *   bytes 2-33  32-byte account id = hash of the account's initial state
 *   bytes 34-35 CRC16-XMODEM of bytes 0..33, big-endian
 */
function parseFriendly(addr) {
  let s = String(addr || '').trim();
  // Accept URL-safe base64 variants too.
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  if (s.length !== 48 || !/^[A-Za-z0-9+/]{48}$/.test(s)) {
    throw new Error(
      `"${addr}" is not a 48-char base64 TON address (and not raw 0:... form).`
    );
  }
  const data = Buffer.from(s, 'base64');
  if (data.length !== 36) throw new Error('Decoded length is not 36 bytes.');

  const crcStored = data.readUInt16BE(34);
  const crcCalced = crc16xmodem(data.subarray(0, 34));
  if (crcStored !== crcCalced) {
    throw new Error(
      `"${addr}": CRC16 mismatch — the address is mistyped or corrupted.`
    );
  }

  const tag = data[0];
  const knownTags = [0x11, 0x51, 0x91, 0xd1];
  const tagWarning = knownTags.includes(tag)
    ? null
    : `unusual flag byte 0x${tag.toString(16).padStart(2, '0')}`;

  const wcByte = data[1];
  return {
    input: addr,
    form: 'friendly',
    bounceable: (tag & 0x40) === 0,
    testOnly: (tag & 0x80) !== 0,
    workchain: wcByte > 127 ? wcByte - 256 : wcByte,
    accountId: data.subarray(2, 34),
    tagWarning,
  };
}

/** Raw form: "<workchain>:<64 hex chars>". No flags encoded here. */
function parseRaw(addr) {
  const m = String(addr || '').trim().match(/^(-?\d+):([0-9a-fA-F]{64})$/);
  if (!m) throw new Error(`"${addr}" is not a raw 0:<64-hex> TON address.`);
  return {
    input: addr,
    form: 'raw',
    bounceable: null, // not encoded in raw form
    testOnly: false,
    workchain: parseInt(m[1], 10),
    accountId: Buffer.from(m[2], 'hex'),
    tagWarning: null,
  };
}

function parseAny(addr) {
  return String(addr).includes(':') ? parseRaw(addr) : parseFriendly(addr);
}

// ---------------------------------------------------------------- encoding

function encodeFriendly(accountId, workchain, { bounceable = true, testOnly = false } = {}) {
  const tag = (bounceable ? 0x11 : 0x51) | (testOnly ? 0x80 : 0);
  const head = Buffer.from([tag, workchain & 0xff]);
  const body = Buffer.concat([head, accountId]);
  const crc = crc16xmodem(body);
  return Buffer.concat([body, Buffer.from([(crc >> 8) & 0xff, crc & 0xff])]).toString('base64');
}

function hex(accountId) {
  return accountId.toString('hex').replace(/(.{8})/g, '$1 ').trim();
}

// ---------------------------------------------------------------- commands

function infoLine(p, i) {
  const net = p.testOnly ? 'TESTNET-ONLY' : 'mainnet-capable';
  const b = p.form === 'raw' ? 'n/a (raw form)' : p.bounceable ? 'bounceable (EQ...)' : 'non-bounceable (UQ...)';
  console.log(
    `${i}) ${p.input}\n` +
      `     form: ${p.form}   network: ${net}   bounceable: ${b}\n` +
      `     workchain: ${p.workchain}   account id: ${hex(p.accountId)}` +
      (p.tagWarning ? `\n     WARNING: ${p.tagWarning}` : '')
  );
}

function sameAccount(a, b) {
  return a.workchain === b.workchain && a.accountId.equals(b.accountId);
}

function cmdInfo(addr) {
  const p = parseAny(addr);
  infoLine(p, 1);
}

function cmdConvert(addr) {
  const p = parseAny(addr);
  console.log(`Input:            ${p.input}`);
  console.log(`Bounceable:       ${encodeFriendly(p.accountId, p.workchain, { bounceable: true })}`);
  console.log(`Non-bounceable:   ${encodeFriendly(p.accountId, p.workchain, { bounceable: false })}`);
  console.log(`Raw:              ${p.workchain}:${p.accountId.toString('hex')}`);
  console.log(`Testnet bounce:   ${encodeFriendly(p.accountId, p.workchain, { bounceable: true, testOnly: true })}`);
  console.log(`Testnet non-bnc:  ${encodeFriendly(p.accountId, p.workchain, { bounceable: false, testOnly: true })}`);
  console.log(
    `\nAll of the lines above are the SAME account on-chain (same key, same wallet),` +
      `\nonly the encoding differs.`
  );
}

function cmdCompare(addrs) {
  const parsed = addrs.map(parseAny);
  parsed.forEach((p, i) => infoLine(p, i + 1));
  console.log('');

  // Group by account identity.
  let allSame = true;
  for (let i = 1; i < parsed.length; i++) {
    if (!sameAccount(parsed[0], parsed[i])) allSame = false;
  }

  if (allSame) {
    const flagsDiffer = parsed.some(
      (p, i) => i > 0 && (p.bounceable !== parsed[0].bounceable || p.testOnly !== parsed[0].testOnly)
    );
    console.log('RESULT: SAME on-chain account.');
    if (flagsDiffer) {
      console.log(
        'These are only different SPELLINGS of one account (bounceable EQ... vs\n' +
          'non-bounceable UQ..., and/or raw form). A transfer to one of them is\n' +
          'visible under all of them; a wallet app that shows the other spelling\n' +
          'still holds the funds.'
      );
    } else {
      console.log('Identical account id — these are the same address.');
    }
    process.exit(0);
  }

  console.log('RESULT: DIFFERENT on-chain accounts.');
  console.log(
    'Different account id means a different contract state. With ONE key this\n' +
      'happens when the wallet contract or its parameters differ, e.g.:\n' +
      '  - wallet v3r1 / v3r2 / v4r2 (different contract code hash)\n' +
      '  - different subwallet_id (stored in the wallet data, see wallet-v4-code.fc)\n' +
      '  - basechain (0:...) vs masterchain (-1:...)\n' +
      'Funds sent to one of them will NOT appear in a wallet app that displays\n' +
      'the other one, even if the same seed phrase is imported. Check the exact\n' +
      'destination on an explorer (tonviewer.com); to move the funds you must\n' +
      'use a wallet configured with the SAME version/subwallet as the destination.'
  );
  process.exit(1);
}

function help() {
  console.log(`TON address decoder / comparator (offline, no dependencies, no keys)

Usage:
  node ton-address.mjs compare <addr1> <addr2> [addr3...]   same account or not?
  node ton-address.mjs info <addr>                          decode hidden fields
  node ton-address.mjs convert <addr>                       all spellings of one account

Accepts user-friendly base64 (EQ.../UQ..., 48 chars) and raw (0:.../-1:...) forms.

Why one key can show two addresses:
  EQ... vs UQ...  -> same account, different bounceable flag bit (spelling only)
  v3 vs v4 code, or different subwallet_id -> different accounts, same key
  mainnet vs testnet -> different networks entirely

Addresses are public — share them freely. NEVER share a seed phrase or private key.`);
}

// ---------------------------------------------------------------- main

const argv = process.argv.slice(2);
const command = argv[0];

try {
  if (command === 'compare' && argv.length >= 3) cmdCompare(argv.slice(1));
  else if (command === 'info' && argv.length === 2) cmdInfo(argv[1]);
  else if (command === 'convert' && argv.length === 2) cmdConvert(argv[1]);
  else if (argv.length === 0 || command === '--help' || command === '-h' || command === 'help') help();
  else if (argv.length >= 2 && !['compare', 'info', 'convert', '--help', '-h', 'help'].includes(command)) {
    // `node ton-address.mjs <addr1> <addr2>` shorthand for compare
    cmdCompare(argv);
  } else help();
} catch (err) {
  console.error(`ERROR: ${err.message}`);
  process.exit(2);
}
