/**
 * STEP 2 -- the keyless withdrawal. Paste three things and it is done.
 *
 *   npm run withdraw -- --withdrawer <WALLET> --amount 1.5 --receiver <ADDRESS>
 *
 * No wallet owner key, no mnemonic, no seed phrase is involved or accepted here.
 * The wallet was authorised once with `npm run authorize`; this just exercises
 * that standing permission, within the limits the owner burned into the chain.
 *
 * Options
 *   --withdrawer ADDR   wallet to pull FROM   (required)
 *   --amount N          TON to move           (required)
 *   --receiver ADDR     where it lands        (required)
 *   --network testnet|mainnet                 (default testnet)
 *   --dry-run           validate everything, broadcast nothing
 */
import { Address, fromNano, toNano } from '@ton/core';

import { WithdrawerPlugin, PLUGIN_ERRORS } from '../src/WithdrawerPlugin';
import {
  args,
  findRecord,
  makeClient,
  parseNetwork,
  requireArg,
  sendExternal,
  explorer,
} from './lib/net';

async function main() {
  const a = args();
  const network = parseNetwork(a);

  const withdrawerArg = requireArg(
    a,
    'withdrawer',
    'the wallet to pull funds FROM, e.g. --withdrawer EQAbc...'
  );
  const amountArg = requireArg(a, 'amount', 'how much TON to move, e.g. --amount 1.5');
  const receiverArg = requireArg(
    a,
    'receiver',
    'where the funds should land, e.g. --receiver EQXyz...'
  );

  let withdrawer: Address;
  let receiver: Address;
  try {
    withdrawer = Address.parse(withdrawerArg);
  } catch {
    console.error(`\n"${withdrawerArg}" is not a valid TON address.\n`);
    process.exit(1);
  }
  try {
    receiver = Address.parse(receiverArg);
  } catch {
    console.error(`\n"${receiverArg}" is not a valid TON address.\n`);
    process.exit(1);
  }

  const amount = toNano(amountArg);
  if (amount <= 0n) {
    console.error('\n--amount must be greater than zero.\n');
    process.exit(1);
  }

  const rec = findRecord(withdrawer.toString(), network);
  if (!rec) {
    console.error(
      `\nNo authorisation on record for ${withdrawerArg} on ${network}.\n\n` +
        'This is the whole security model: a wallet can only be drained by a\n' +
        'withdrawer its owner installed. Nothing here can move funds out of a\n' +
        'wallet that never granted permission.\n\n' +
        'If you own this wallet, authorise it once:\n' +
        '  OWNER_MNEMONIC="..." npm run authorize -- --allowance 10 --max-per 2\n'
    );
    process.exit(1);
  }

  const client = makeClient(network);
  const plugin = client.open(WithdrawerPlugin.createFromAddress(Address.parse(rec.plugin)));

  // --- pre-flight, so failures cost nothing and explain themselves ---
  const [seqno, remaining, data] = await Promise.all([
    plugin.getSeqno(),
    plugin.getRemainingAllowance(),
    plugin.getData(),
  ]);

  console.log('\n=== WITHDRAWAL ===');
  console.log('network    ', network);
  console.log('withdrawer ', withdrawer.toString({ testOnly: network === 'testnet' }));
  console.log('amount     ', fromNano(amount), 'TON');
  console.log('receiver   ', receiver.toString({ testOnly: network === 'testnet' }));
  console.log('via plugin ', rec.plugin);
  console.log('nonce      ', seqno);

  const problems: string[] = [];
  if (amount > data.maxPerWithdrawal)
    problems.push(
      `amount exceeds the per-withdrawal cap of ${fromNano(data.maxPerWithdrawal)} TON`
    );
  if (amount > remaining)
    problems.push(`amount exceeds the remaining allowance of ${fromNano(remaining)} TON`);

  const now = Math.floor(Date.now() / 1000);
  const readyAt = data.lastWithdrawal + data.cooldown;
  if (now < readyAt) problems.push(`cooldown active for another ${readyAt - now}s`);

  if (!(await plugin.getIsReceiverAllowed(receiver)))
    problems.push('receiver is not on the allowlist the owner configured');

  const walletState = await client.getContractState(withdrawer);
  if (walletState.balance < amount + toNano('0.1'))
    problems.push(
      `withdrawer wallet holds only ${fromNano(walletState.balance)} TON`
    );

  if (problems.length) {
    console.error('\nRefusing to broadcast:');
    for (const p of problems) console.error('  - ' + p);
    console.error('\n(These same rules are enforced on chain, not just here.)\n');
    process.exit(1);
  }

  console.log('remaining  ', fromNano(remaining), 'TON before this pull');

  if (a['dry-run'] === 'true') {
    console.log('\nDry run: all checks passed, nothing broadcast.\n');
    return;
  }

  const body = WithdrawerPlugin.buildWithdrawBody({
    seqno,
    amount,
    receiver,
    validUntil: now + 300,
    operatorSecretKey: rec.operatorSecretKey
      ? Buffer.from(rec.operatorSecretKey, 'hex')
      : null,
  });

  try {
    await sendExternal(client, Address.parse(rec.plugin), body);
  } catch (e: any) {
    const code = /exit code (\d+)/.exec(e?.message ?? '')?.[1];
    const known = code ? PLUGIN_ERRORS[parseInt(code, 10)] : undefined;
    console.error('\nBroadcast failed: ' + (known ?? e?.message ?? e) + '\n');
    process.exit(1);
  }

  console.log('\nSent. Waiting for the nonce to advance...');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    let current: number;
    try {
      current = await plugin.getSeqno();
    } catch {
      continue;
    }
    if (current > seqno) {
      const left = await plugin.getRemainingAllowance();
      console.log('\nDone.');
      console.log('  moved      ', fromNano(amount), 'TON');
      console.log('  to         ', receiver.toString({ testOnly: network === 'testnet' }));
      console.log('  allowance  ', fromNano(left), 'TON left');
      console.log('  explorer   ', explorer(network, receiver), '\n');
      return;
    }
    process.stdout.write('.');
  }

  console.log(
    '\n\nStill pending. Check ' + explorer(network, Address.parse(rec.plugin)) + '\n'
  );
}

main().catch((e) => {
  console.error('\n' + (e?.message ?? e) + '\n');
  process.exit(1);
});
