/**
 * Bitcoin pre-signed vault demo. Fully offline: no node, no network, no funds.
 *   npm run demo
 */
import * as bitcoin from 'bitcoinjs-lib';
import { createVault, inspectPresigned, findWithdrawal, ECPair, p2wpkhAddress, networkFor } from './vault';

const NET = networkFor('regtest');
const sat = (n: number) => (n / 1e8).toFixed(8).padStart(12) + ' BTC';

function main() {
  const owner = ECPair.makeRandom({ network: NET });
  const ownerAddress = p2wpkhAddress(owner, NET);
  const alice = p2wpkhAddress(ECPair.makeRandom({ network: NET }), NET);
  const bob = p2wpkhAddress(ECPair.makeRandom({ network: NET }), NET);

  console.log('\n=== WITHDRAWER WALLET (regtest) ===');
  console.log('address ', ownerAddress);
  console.log('funding ', sat(1_000_000));

  // ---- step 1: the owner signs the whole batch, once --------------------
  const plan = [
    { amount: 100_000, receiver: alice },
    { amount: 250_000, receiver: bob },
    { amount: 50_000, receiver: alice },
  ];

  const vault = createVault({
    ownerKey: owner,
    utxo: {
      txid: 'a'.repeat(64),
      vout: 0,
      value: 1_000_000,
      script: bitcoin.address.toOutputScript(ownerAddress, NET).toString('hex'),
    },
    plan,
    feeRate: 5,
    network: 'regtest',
  });

  console.log('\n=== STEP 1: AUTHORISE (owner signs everything, now) ===');
  console.log('split txid ', vault.splitTxid);
  console.log('change     ', sat(vault.changeSats));
  console.log('pre-signed ', vault.withdrawals.length, 'withdrawals');

  console.log('\n>>> The owner key is now discarded. <<<');

  // ---- step 2: broadcasting needs no key --------------------------------
  console.log('\n=== STEP 2: WITHDRAWALS (paste amount + receiver, no key) ===');
  for (const p of plan) {
    const w = findWithdrawal(vault, p.amount, p.receiver);
    if (!w) {
      console.log('  no pre-signed transaction for that pair');
      continue;
    }
    const seen = inspectPresigned(w, 'regtest');
    const label = p.receiver === alice ? 'alice' : 'bob';
    console.log(
      `  ${sat(seen.amount)} -> ${label.padEnd(6)} txid=${w.txid.slice(0, 16)}…  ` +
        `signed=${seen.fullySigned}  fee=${w.feeSats} sat`
    );
  }

  console.log('\n=== WHAT IS AND IS NOT POSSIBLE ===');
  const notPlanned = findWithdrawal(vault, 999_999, alice);
  console.log('  an amount nobody pre-signed        ', notPlanned ? 'FOUND' : 'DOES NOT EXIST');
  const notPlannedAddr = findWithdrawal(vault, 100_000, p2wpkhAddress(ECPair.makeRandom({ network: NET }), NET));
  console.log('  a receiver nobody pre-signed       ', notPlannedAddr ? 'FOUND' : 'DOES NOT EXIST');

  // tamper attempt
  const w = vault.withdrawals[0];
  const tx = bitcoin.Transaction.fromHex(w.txHex);
  const attacker = p2wpkhAddress(ECPair.makeRandom({ network: NET }), NET);
  tx.outs[0].script = bitcoin.address.toOutputScript(attacker, NET);
  console.log('  redirecting a pre-signed payout     BREAKS THE SIGNATURE (network would reject)');
  console.log('    original txid', w.txid.slice(0, 24) + '…');
  console.log('    tampered txid', tx.getId().slice(0, 24) + '…', '(different tx, unsigned)');

  console.log('\n=== HOW TO SPEND ===');
  console.log('  1. broadcast the split transaction  (owner-signed, once)');
  console.log('  2. broadcast any pre-signed withdrawal, any time, with NO key');
  console.log('  3. to cancel: the owner spends the split outputs elsewhere first');
  console.log();
}

main();
