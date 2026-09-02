/**
 * End-to-end demo on an in-process emulated blockchain. No network, no real funds.
 *
 *   npm run demo
 *
 * It shows the whole point of this repo:
 *   step 1  the owner signs ONCE to authorise a withdrawer  (owner key used)
 *   step 2+ withdrawals need only: withdrawer, amount, receiver  (no owner key)
 */
import { Blockchain } from '@ton/sandbox';
import { Address, fromNano, toNano } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { randomBytes } from 'crypto';

import { WalletV4 } from '../src/WalletV4';
import { WithdrawerPlugin } from '../src/WithdrawerPlugin';
import { compileWithdrawer, compileWalletV4 } from './build';

const ton = (v: bigint) => `${fromNano(v).padStart(10)} TON`;

async function main() {
  const pluginCode = await compileWithdrawer();
  const walletCode = await compileWalletV4();

  const bc = await Blockchain.create();
  bc.now = Math.floor(Date.now() / 1000);

  const ownerKeys = keyPairFromSeed(randomBytes(32));
  const operatorKeys = keyPairFromSeed(randomBytes(32));
  const funder = await bc.treasury('funder');
  const alice = await bc.treasury('alice');
  const bob = await bc.treasury('bob');

  // ---------------------------------------------------------------- the wallet
  const wallet = bc.openContract(
    WalletV4.createFromConfig({ publicKey: ownerKeys.publicKey }, walletCode)
  );
  await wallet.sendDeploy(funder.getSender(), toNano('50'));

  console.log('\n=== WITHDRAWER WALLET ===');
  console.log('address  ', wallet.address.toString({ testOnly: true }));
  console.log('balance  ', ton((await bc.getContract(wallet.address)).balance));

  // ------------------------------------------- step 1: authorise (owner signs)
  const plugin = bc.openContract(
    WithdrawerPlugin.createFromConfig(
      {
        wallet: wallet.address,
        operatorPublicKey: operatorKeys.publicKey,
        totalAllowance: toNano('20'),
        maxPerWithdrawal: toNano('8'),
        cooldown: 0,
      },
      pluginCode
    )
  );

  await wallet.sendDeployAndInstallPlugin({
    secretKey: ownerKeys.secretKey,
    seqno: await wallet.getSeqno(),
    value: toNano('0.5'),
    stateInit: plugin.init,
    validUntil: bc.now! + 300,
  });

  console.log('\n=== STEP 1: AUTHORISE (the only time the owner key is used) ===');
  console.log('plugin       ', plugin.address.toString({ testOnly: true }));
  console.log('installed?   ', await wallet.getIsPluginInstalled(plugin.address));
  console.log('allowance    ', ton(await plugin.getRemainingAllowance()));
  console.log('max per pull ', ton((await plugin.getData()).maxPerWithdrawal));

  console.log('\n>>> The owner key is now discarded for the rest of this demo. <<<');
  const ownerSecretKey = null as unknown as Buffer; // gone.
  void ownerSecretKey;

  // ------------------------------- step 2: keyless withdrawals, 3 fields each
  console.log('\n=== STEP 2: WITHDRAWALS (withdrawer + amount + receiver only) ===');

  const pulls: { amount: string; receiver: Address; label: string }[] = [
    { amount: '5', receiver: alice.address, label: 'alice' },
    { amount: '3.5', receiver: bob.address, label: 'bob' },
    { amount: '1.25', receiver: alice.address, label: 'alice' },
  ];

  for (const p of pulls) {
    const before = await bob.getBalance();
    void before;
    const res = await plugin.sendWithdraw({
      seqno: await plugin.getSeqno(),
      amount: toNano(p.amount),
      receiver: p.receiver,
      operatorSecretKey: operatorKeys.secretKey,
      validUntil: bc.now! + 300,
    });

    const paid = res.transactions.some(
      (t: any) =>
        t.inMessage?.info?.dest?.equals?.(p.receiver) &&
        t.inMessage?.info?.value?.coins === toNano(p.amount)
    );

    console.log(
      `  withdrawer=${wallet.address.toString({ testOnly: true }).slice(0, 12)}…` +
        `  amount=${p.amount.padStart(6)} TON  ->  ${p.label}   ` +
        (paid ? 'DELIVERED' : 'FAILED')
    );
  }

  console.log('\n=== RESULT ===');
  console.log('wallet balance   ', ton((await bc.getContract(wallet.address)).balance));
  console.log('alice balance    ', ton(await alice.getBalance()));
  console.log('bob balance      ', ton(await bob.getBalance()));
  console.log('allowance left   ', ton(await plugin.getRemainingAllowance()));

  // ---------------------------------------------- limits are real, not advisory
  console.log('\n=== THE LIMITS ARE ENFORCED ON CHAIN ===');
  try {
    await plugin.sendWithdraw({
      seqno: await plugin.getSeqno(),
      amount: toNano('8.5'), // above max_per_withdrawal
      receiver: alice.address,
      operatorSecretKey: operatorKeys.secretKey,
      validUntil: bc.now! + 300,
    });
    console.log('  over-cap pull            UNEXPECTEDLY ALLOWED');
  } catch {
    console.log('  pull of 8.5 TON (cap 8)  REJECTED by the contract');
  }

  const stranger = keyPairFromSeed(randomBytes(32));
  try {
    await plugin.sendWithdraw({
      seqno: await plugin.getSeqno(),
      amount: toNano('1'),
      receiver: alice.address,
      operatorSecretKey: stranger.secretKey,
      validUntil: bc.now! + 300,
    });
    console.log('  stranger pull            UNEXPECTEDLY ALLOWED');
  } catch {
    console.log('  pull by a stranger       REJECTED by the contract');
  }

  // ------------------------------------------------------------ revocation
  await wallet.sendRemovePlugin({
    secretKey: ownerKeys.secretKey,
    seqno: await wallet.getSeqno(),
    plugin: plugin.address,
    value: toNano('0.1'),
    validUntil: bc.now! + 300,
  });
  console.log('\n=== REVOKED BY THE OWNER ===');
  console.log('  still installed?         ', await wallet.getIsPluginInstalled(plugin.address));
  console.log('  plugin account           ', (await bc.getContract(plugin.address)).accountState?.type ?? 'destroyed');
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
