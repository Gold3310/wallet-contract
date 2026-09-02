/**
 * Bitcoin keyless withdrawals via a PRE-SIGNED VAULT.
 *
 * WHY THIS LOOKS DIFFERENT FROM TON AND EVM
 *   Bitcoin has no accounts, no `approve`, and no on-chain programmability that
 *   can enforce a spending limit. Anything that can sign can sign away the whole
 *   UTXO. So "grant a capped allowance to a hot key" is NOT expressible on
 *   Bitcoin the way it is on TON or Ethereum.
 *
 *   The one construction that is genuinely keyless at withdrawal time is a
 *   pre-signed transaction. The owner signs a batch of withdrawals IN ADVANCE.
 *   Broadcasting one later requires no key from anybody -- the signatures
 *   already exist. The "limits" are absolute, because the only spends that can
 *   ever happen are the ones the owner already signed.
 *
 * THE TRADE-OFF, STATED PLAINLY
 *   Amount and receiver are fixed when the vault is created, not when you
 *   withdraw. You cannot paste an arbitrary amount to an arbitrary address the
 *   way you can on the other two chains. If you need that on Bitcoin, the only
 *   option is a hot key that holds the coins outright, with limits enforced by
 *   your software rather than by the network -- which is custody, not a vault.
 *
 * HOW IT WORKS
 *   1. SPLIT   one owner-signed transaction fans the funding UTXO out into one
 *              dedicated output per planned withdrawal, plus change.
 *   2. PRESIGN for each of those outputs the owner signs a withdrawal spending
 *              it to the planned receiver. Distinct inputs, so these are not
 *              double-spends of each other and can be broadcast independently,
 *              in any order, or never.
 *   3. SPEND   broadcasting a pre-signed transaction needs no key at all.
 */
import * as bitcoin from 'bitcoinjs-lib';
import { ECPairFactory, ECPairInterface } from 'ecpair';
import * as ecc from 'tiny-secp256k1';

export const ECPair = ECPairFactory(ecc);
bitcoin.initEccLib(ecc);

/** Rough vsize of a 1-in / 1-out P2WPKH spend. */
export const WITHDRAWAL_VSIZE = 110;

export type Utxo = {
  txid: string;
  vout: number;
  value: number; // satoshis
  /** scriptPubKey hex of the output being spent (P2WPKH). */
  script: string;
};

export type PlannedWithdrawal = {
  /** Exact satoshis the receiver will get. */
  amount: number;
  /** Destination address. Fixed at authorisation time -- see the note above. */
  receiver: string;
};

export type PresignedWithdrawal = PlannedWithdrawal & {
  /** Fully signed, ready to broadcast by anyone, with no key. */
  txHex: string;
  txid: string;
  /** The dedicated split output this spends. */
  input: { txid: string; vout: number; value: number };
  feeSats: number;
};

export type Vault = {
  network: 'bitcoin' | 'testnet' | 'regtest';
  ownerAddress: string;
  /** Owner-signed transaction that must be broadcast FIRST. */
  splitTxHex: string;
  splitTxid: string;
  withdrawals: PresignedWithdrawal[];
  changeSats: number;
  createdAt: string;
};

export function networkFor(name: Vault['network']): bitcoin.Network {
  if (name === 'bitcoin') return bitcoin.networks.bitcoin;
  if (name === 'testnet') return bitcoin.networks.testnet;
  return bitcoin.networks.regtest;
}

export function p2wpkhAddress(keyPair: ECPairInterface, network: bitcoin.Network): string {
  const { address } = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network,
  });
  if (!address) throw new Error('could not derive a P2WPKH address');
  return address;
}

/** Very rough size model for the split transaction: 1 input, n+1 outputs. */
function splitVsize(numOutputs: number): number {
  return 68 + 31 * numOutputs + 11;
}

/**
 * STEP 1 + 2. The only moment the owner's key is used.
 *
 * Produces a split transaction plus one pre-signed withdrawal per plan entry.
 * Nothing here touches the network; broadcasting is a separate, keyless step.
 */
export function createVault(args: {
  ownerKey: ECPairInterface;
  utxo: Utxo;
  plan: PlannedWithdrawal[];
  feeRate: number; // sat/vB
  network?: Vault['network'];
}): Vault {
  const netName = args.network ?? 'regtest';
  const network = networkFor(netName);
  const owner = args.ownerKey;
  const ownerAddress = p2wpkhAddress(owner, network);

  if (args.plan.length === 0) throw new Error('the plan must contain at least one withdrawal');
  for (const p of args.plan) {
    if (!Number.isInteger(p.amount) || p.amount <= 0) {
      throw new Error(`amount must be a positive whole number of satoshis, got ${p.amount}`);
    }
    // Reject anything the network would treat as dust.
    if (p.amount < 330) throw new Error(`amount ${p.amount} sat is below the dust limit`);
    try {
      bitcoin.address.toOutputScript(p.receiver, network);
    } catch {
      throw new Error(`"${p.receiver}" is not a valid address on ${netName}`);
    }
  }

  const withdrawalFee = Math.ceil(WITHDRAWAL_VSIZE * args.feeRate);
  const splitFee = Math.ceil(splitVsize(args.plan.length) * args.feeRate);

  // Each split output must cover its withdrawal amount plus that withdrawal's fee.
  const bucketValues = args.plan.map((p) => p.amount + withdrawalFee);
  const needed = bucketValues.reduce((a, b) => a + b, 0) + splitFee;
  if (args.utxo.value < needed) {
    throw new Error(
      `funding UTXO holds ${args.utxo.value} sat but the plan needs ${needed} sat ` +
        `(${bucketValues.reduce((a, b) => a + b, 0)} for withdrawals + ${splitFee} split fee)`
    );
  }
  const change = args.utxo.value - needed;

  // ---- the split transaction ------------------------------------------------
  const split = new bitcoin.Psbt({ network });
  split.addInput({
    hash: args.utxo.txid,
    index: args.utxo.vout,
    witnessUtxo: { script: Buffer.from(args.utxo.script, 'hex'), value: args.utxo.value },
  });
  for (const v of bucketValues) split.addOutput({ address: ownerAddress, value: v });
  if (change >= 330) split.addOutput({ address: ownerAddress, value: change });

  split.signInput(0, owner);
  split.finalizeAllInputs();
  const splitTx = split.extractTransaction();
  const splitTxid = splitTx.getId();

  const ownerScript = bitcoin.address.toOutputScript(ownerAddress, network);

  // ---- one pre-signed withdrawal per bucket ---------------------------------
  const withdrawals: PresignedWithdrawal[] = args.plan.map((p, i) => {
    const psbt = new bitcoin.Psbt({ network });
    psbt.addInput({
      hash: splitTxid,
      index: i,
      witnessUtxo: { script: ownerScript, value: bucketValues[i] },
    });
    psbt.addOutput({ address: p.receiver, value: p.amount });
    psbt.signInput(0, owner);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();

    return {
      amount: p.amount,
      receiver: p.receiver,
      txHex: tx.toHex(),
      txid: tx.getId(),
      input: { txid: splitTxid, vout: i, value: bucketValues[i] },
      feeSats: withdrawalFee,
    };
  });

  return {
    network: netName,
    ownerAddress,
    splitTxHex: splitTx.toHex(),
    splitTxid,
    withdrawals,
    changeSats: change >= 330 ? change : 0,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Independently re-derive what a pre-signed transaction actually does, so the
 * holder never has to trust the metadata sitting next to it in a JSON file.
 */
export function inspectPresigned(
  w: PresignedWithdrawal,
  netName: Vault['network']
): { receiver: string; amount: number; spends: string; fullySigned: boolean } {
  const network = networkFor(netName);
  const tx = bitcoin.Transaction.fromHex(w.txHex);

  if (tx.outs.length !== 1) throw new Error('expected exactly one output');
  const out = tx.outs[0];
  const receiver = bitcoin.address.fromOutputScript(out.script, network);
  const input = tx.ins[0];
  // txids are displayed byte-reversed relative to their wire encoding
  const spends = Buffer.from(input.hash).reverse().toString('hex') + ':' + input.index;

  return {
    receiver,
    amount: out.value,
    spends,
    fullySigned: tx.ins.every((i) => i.witness && i.witness.length > 0),
  };
}

/** Find the pre-signed transaction matching a paste of amount + receiver. */
export function findWithdrawal(
  vault: Vault,
  amountSats: number,
  receiver: string
): PresignedWithdrawal | undefined {
  return vault.withdrawals.find((w) => w.amount === amountSats && w.receiver === receiver);
}
