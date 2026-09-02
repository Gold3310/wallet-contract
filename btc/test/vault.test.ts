import { expect } from 'chai';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import { createVault, inspectPresigned, findWithdrawal, ECPair, p2wpkhAddress, networkFor, Utxo } from '../src/vault';

const NET = networkFor('regtest');

function makeOwner() {
  const key = ECPair.makeRandom({ network: NET });
  return { key, address: p2wpkhAddress(key, NET) };
}
function fakeUtxo(address: string, value: number): Utxo {
  return {
    txid: 'a'.repeat(64),
    vout: 0,
    value,
    script: bitcoin.address.toOutputScript(address, NET).toString('hex'),
  };
}
function randomAddress(): string {
  return p2wpkhAddress(ECPair.makeRandom({ network: NET }), NET);
}

describe('Bitcoin pre-signed vault', () => {
  it('pre-signs withdrawals that anyone can broadcast with NO key', () => {
    const owner = makeOwner();
    const alice = randomAddress();
    const bob = randomAddress();

    const vault = createVault({
      ownerKey: owner.key,
      utxo: fakeUtxo(owner.address, 1_000_000),
      plan: [
        { amount: 100_000, receiver: alice },
        { amount: 250_000, receiver: bob },
      ],
      feeRate: 5,
      network: 'regtest',
    });

    expect(vault.withdrawals).to.have.length(2);

    for (const w of vault.withdrawals) {
      const seen = inspectPresigned(w, 'regtest');
      // fully signed already -- no key is needed to broadcast
      expect(seen.fullySigned).to.equal(true);
      expect(seen.receiver).to.equal(w.receiver);
      expect(seen.amount).to.equal(w.amount);
    }

    // the receiver gets EXACTLY the planned amount
    expect(inspectPresigned(vault.withdrawals[0], 'regtest').amount).to.equal(100_000);
    expect(inspectPresigned(vault.withdrawals[1], 'regtest').amount).to.equal(250_000);
  });

  it('the pre-signed transactions spend DISTINCT outputs, so none conflict', () => {
    const owner = makeOwner();
    const vault = createVault({
      ownerKey: owner.key,
      utxo: fakeUtxo(owner.address, 2_000_000),
      plan: [
        { amount: 50_000, receiver: randomAddress() },
        { amount: 60_000, receiver: randomAddress() },
        { amount: 70_000, receiver: randomAddress() },
      ],
      feeRate: 3,
      network: 'regtest',
    });

    const spent = vault.withdrawals.map((w) => inspectPresigned(w, 'regtest').spends);
    expect(new Set(spent).size).to.equal(3); // no double-spends of each other
    for (const s of spent) expect(s.split(':')[0]).to.equal(vault.splitTxid);
  });

  it('every signature actually verifies against the owner key', () => {
    const owner = makeOwner();
    const vault = createVault({
      ownerKey: owner.key,
      utxo: fakeUtxo(owner.address, 500_000),
      plan: [{ amount: 100_000, receiver: randomAddress() }],
      feeRate: 4,
      network: 'regtest',
    });

    const w = vault.withdrawals[0];
    const tx = bitcoin.Transaction.fromHex(w.txHex);
    const [sigWithHashType, pubkey] = tx.ins[0].witness;

    expect(Buffer.from(pubkey).toString('hex')).to.equal(
      Buffer.from(owner.key.publicKey).toString('hex')
    );

    const hashType = sigWithHashType[sigWithHashType.length - 1];
    const sig = bitcoin.script.signature.decode(Buffer.from(sigWithHashType)).signature;
    const script = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubkey) }).output!;
    const sighash = tx.hashForWitnessV0(0, script, w.input.value, hashType);

    expect(ecc.verify(sighash, Buffer.from(pubkey), sig)).to.equal(true);
  });

  it('tampering with the receiver invalidates the signature', () => {
    const owner = makeOwner();
    const attacker = randomAddress();
    const vault = createVault({
      ownerKey: owner.key,
      utxo: fakeUtxo(owner.address, 500_000),
      plan: [{ amount: 100_000, receiver: randomAddress() }],
      feeRate: 4,
      network: 'regtest',
    });

    const w = vault.withdrawals[0];
    const tx = bitcoin.Transaction.fromHex(w.txHex);
    const [sigWithHashType, pubkey] = tx.ins[0].witness;

    // redirect the payment to the attacker
    tx.outs[0].script = bitcoin.address.toOutputScript(attacker, NET);

    const hashType = sigWithHashType[sigWithHashType.length - 1];
    const sig = bitcoin.script.signature.decode(Buffer.from(sigWithHashType)).signature;
    const script = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubkey) }).output!;
    const tamperedSighash = tx.hashForWitnessV0(0, script, w.input.value, hashType);

    // the pre-existing signature no longer covers this transaction
    expect(ecc.verify(tamperedSighash, Buffer.from(pubkey), sig)).to.equal(false);
  });

  it('tampering with the amount invalidates the signature', () => {
    const owner = makeOwner();
    const vault = createVault({
      ownerKey: owner.key,
      utxo: fakeUtxo(owner.address, 500_000),
      plan: [{ amount: 100_000, receiver: randomAddress() }],
      feeRate: 4,
      network: 'regtest',
    });

    const w = vault.withdrawals[0];
    const tx = bitcoin.Transaction.fromHex(w.txHex);
    const [sigWithHashType, pubkey] = tx.ins[0].witness;

    tx.outs[0].value = 199_000; // grab more

    const hashType = sigWithHashType[sigWithHashType.length - 1];
    const sig = bitcoin.script.signature.decode(Buffer.from(sigWithHashType)).signature;
    const script = bitcoin.payments.p2pkh({ pubkey: Buffer.from(pubkey) }).output!;
    expect(
      ecc.verify(tx.hashForWitnessV0(0, script, w.input.value, hashType), Buffer.from(pubkey), sig)
    ).to.equal(false);
  });

  it('looks up a pre-signed transaction from a paste of amount + receiver', () => {
    const owner = makeOwner();
    const alice = randomAddress();
    const vault = createVault({
      ownerKey: owner.key,
      utxo: fakeUtxo(owner.address, 1_000_000),
      plan: [{ amount: 100_000, receiver: alice }],
      feeRate: 5,
      network: 'regtest',
    });

    expect(findWithdrawal(vault, 100_000, alice)).to.not.equal(undefined);
    // anything the owner did not pre-sign simply does not exist
    expect(findWithdrawal(vault, 100_001, alice)).to.equal(undefined);
    expect(findWithdrawal(vault, 100_000, randomAddress())).to.equal(undefined);
  });

  it('refuses a plan the funding UTXO cannot cover', () => {
    const owner = makeOwner();
    expect(() =>
      createVault({
        ownerKey: owner.key,
        utxo: fakeUtxo(owner.address, 50_000),
        plan: [{ amount: 100_000, receiver: randomAddress() }],
        feeRate: 5,
        network: 'regtest',
      })
    ).to.throw(/needs/);
  });

  it('rejects dust amounts and malformed addresses', () => {
    const owner = makeOwner();
    expect(() =>
      createVault({
        ownerKey: owner.key,
        utxo: fakeUtxo(owner.address, 1_000_000),
        plan: [{ amount: 100, receiver: randomAddress() }],
        feeRate: 5,
        network: 'regtest',
      })
    ).to.throw(/dust/);

    expect(() =>
      createVault({
        ownerKey: owner.key,
        utxo: fakeUtxo(owner.address, 1_000_000),
        plan: [{ amount: 100_000, receiver: 'not-an-address' }],
        feeRate: 5,
        network: 'regtest',
      })
    ).to.throw(/not a valid address/);
  });

  it('the receiver is credited exactly, with the fee taken from the bucket', () => {
    const owner = makeOwner();
    const alice = randomAddress();
    const vault = createVault({
      ownerKey: owner.key,
      utxo: fakeUtxo(owner.address, 1_000_000),
      plan: [{ amount: 100_000, receiver: alice }],
      feeRate: 10,
      network: 'regtest',
    });
    const w = vault.withdrawals[0];
    expect(w.input.value - inspectPresigned(w, 'regtest').amount).to.equal(w.feeSats);
    expect(inspectPresigned(w, 'regtest').amount).to.equal(100_000);
  });
});
