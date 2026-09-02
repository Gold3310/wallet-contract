/**
 * LIVE Bitcoin signet run.
 *
 *   npm run live
 *
 * With no key present it generates a throwaway signet key, saves it to
 * .live-key.json (gitignored, chmod 600), prints the address to fund and exits.
 * Fund it from https://signetfaucet.com and run the same command again.
 *
 * Then it:
 *   1. reads your UTXOs from mempool.space
 *   2. builds the split transaction and pre-signs the withdrawals   (owner key)
 *   3. broadcasts the split
 *   4. broadcasts one pre-signed withdrawal                          (NO key)
 *
 * RECEIVER=tb1...  send to an address YOU control instead of a generated one.
 *                  Recommended: then the coins stay spendable.
 *
 * Set BROADCAST=0 to do everything except the two broadcasts.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as bitcoin from 'bitcoinjs-lib';
import {
  createVault,
  inspectPresigned,
  ECPair,
  p2wpkhAddress,
  networkFor,
  Utxo,
  Vault,
} from './vault';

const ROOT = path.resolve(__dirname, '..');
const KEY_FILE = path.join(ROOT, '.live-key.json');
const VAULT_FILE = path.join(ROOT, '.live-vault.json');
const API = process.env.BTC_API ?? 'https://mempool.space/signet/api';
const NET = networkFor('testnet'); // signet shares testnet address params

async function api(p: string, init?: RequestInit): Promise<any> {
  const res = await fetch(API + p, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${p} -> ${res.status} ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

function loadOrCreateKey() {
  if (fs.existsSync(KEY_FILE)) {
    const { wif } = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    return ECPair.fromWIF(wif, NET);
  }
  const key = ECPair.makeRandom({ network: NET });
  fs.writeFileSync(KEY_FILE, JSON.stringify({ wif: key.toWIF() }, null, 2));
  fs.chmodSync(KEY_FILE, 0o600);
  return key;
}

const btc = (s: number) => (s / 1e8).toFixed(8) + ' BTC';

async function main() {
  const key = loadOrCreateKey();
  const address = p2wpkhAddress(key, NET);
  const broadcast = process.env.BROADCAST !== '0';

  console.log('\n=== SIGNET ===');
  console.log('api      ', API);
  console.log('address  ', address);

  const utxos: any[] = await api(`/address/${address}/utxo`);
  const confirmed = utxos.filter((u) => u.status?.confirmed);
  const total = confirmed.reduce((a, u) => a + u.value, 0);
  console.log('utxos    ', confirmed.length, 'confirmed, total', btc(total));

  const NEEDED = 60_000;
  if (total < NEEDED) {
    console.log('\n---------------------------------------------------------------');
    console.log('THIS ADDRESS NEEDS SIGNET COINS BEFORE THE RUN CAN CONTINUE:');
    console.log('\n   ' + address + '\n');
    console.log('It needs about ' + btc(NEEDED) + '. Faucet: https://signetfaucet.com');
    console.log('Wait for 1 confirmation, then run the same command again.');
    console.log('---------------------------------------------------------------\n');
    process.exit(2);
  }

  // Largest confirmed UTXO funds the vault.
  const biggest = confirmed.sort((a, b) => b.value - a.value)[0];
  const utxo: Utxo = {
    txid: biggest.txid,
    vout: biggest.vout,
    value: biggest.value,
    script: bitcoin.address.toOutputScript(address, NET).toString('hex'),
  };

  const feeRate = Math.max(1, Math.ceil((await api('/v1/fees/recommended')).halfHourFee ?? 1));
  console.log('fee rate ', feeRate, 'sat/vB');

  // Receiver. If you did not name one, generate it AND PERSIST ITS KEY --
  // otherwise the coins would land at an address nobody can ever spend from.
  let receiver: string;
  if (process.env.RECEIVER) {
    receiver = process.env.RECEIVER;
    bitcoin.address.toOutputScript(receiver, NET); // throws if malformed
  } else {
    const saved = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    if (saved.receiverWif) {
      receiver = p2wpkhAddress(ECPair.fromWIF(saved.receiverWif, NET), NET);
    } else {
      const receiverKey = ECPair.makeRandom({ network: NET });
      receiver = p2wpkhAddress(receiverKey, NET);
      fs.writeFileSync(
        KEY_FILE,
        JSON.stringify({ ...saved, receiverWif: receiverKey.toWIF() }, null, 2)
      );
      fs.chmodSync(KEY_FILE, 0o600);
    }
  }

  const vault: Vault = createVault({
    ownerKey: key,
    utxo,
    plan: [{ amount: 20_000, receiver }],
    feeRate,
    network: 'testnet',
  });
  fs.writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 2));

  console.log('\n=== STEP 1: AUTHORISE (owner signs both, now) ===');
  console.log('split txid ', vault.splitTxid);
  console.log('change     ', btc(vault.changeSats));
  const w = vault.withdrawals[0];
  const seen = inspectPresigned(w, 'testnet');
  console.log(
    'pre-signed ',
    btc(seen.amount),
    '->',
    seen.receiver,
    process.env.RECEIVER ? '(yours)' : '(generated; key in .live-key.json)'
  );
  console.log('  fee      ', w.feeSats, 'sat (pre-funded by the sender)');
  console.log('  signed   ', seen.fullySigned);
  console.log('  txid     ', w.txid);

  if (!broadcast) {
    console.log('\nBROADCAST=0, stopping before any broadcast.');
    console.log('Vault written to', VAULT_FILE, '\n');
    return;
  }

  console.log('\n=== STEP 2: BROADCAST THE SPLIT (owner-signed) ===');
  const splitId = await api('/tx', { method: 'POST', body: vault.splitTxHex });
  console.log('accepted  ', splitId);
  console.log('explorer   https://mempool.space/signet/tx/' + splitId);

  console.log('\nWaiting for the split to be seen by the mempool...');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 4000));
    try {
      await api(`/tx/${splitId}`);
      break;
    } catch {
      process.stdout.write('.');
    }
  }

  console.log('\n=== STEP 3: BROADCAST THE WITHDRAWAL (NO KEY USED) ===');
  console.log('This transaction was signed in step 1. Nothing signs it now.');
  const wid = await api('/tx', { method: 'POST', body: w.txHex });
  console.log('accepted  ', wid);
  console.log('explorer   https://mempool.space/signet/tx/' + wid);

  console.log('\n=== RESULT ===');
  console.log('  delivered ', btc(seen.amount), 'to', seen.receiver);
  console.log('  miner fee ', w.feeSats, 'sat, paid by the sender, not the receiver');
  console.log('  receiver credited in full:', seen.amount === 20_000 ? 'YES' : 'NO');
  console.log();
}

main().catch((e) => {
  console.error('\n' + (e?.message ?? e) + '\n');
  process.exit(1);
});
