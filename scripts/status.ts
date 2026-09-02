/**
 * Shows every withdrawer you have authorised and its live on-chain state.
 *
 *   npm run status
 *   npm run status -- --withdrawer <WALLET>
 */
import { Address, fromNano } from '@ton/core';
import { WithdrawerPlugin } from '../src/WithdrawerPlugin';
import { WalletV4, WALLET_V4R2_CODE } from '../src/WalletV4';
import { args, loadStore, makeClient, parseNetwork, explorer } from './lib/net';

async function main() {
  const a = args();
  const network = parseNetwork(a);
  let records = loadStore().filter((r) => r.network === network);

  if (a.withdrawer) {
    const want = Address.parse(a.withdrawer).toRawString();
    records = records.filter((r) => Address.parse(r.wallet).toRawString() === want);
  }

  if (records.length === 0) {
    console.log(`\nNo withdrawers authorised on ${network}.\n`);
    return;
  }

  const client = makeClient(network);

  for (const r of records) {
    console.log('\n' + '='.repeat(64));
    console.log('withdrawer  ', r.wallet);
    console.log('plugin      ', r.plugin);
    console.log('mode        ', r.operatorPublicKey ? 'operator key' : 'permissionless');
    console.log('authorised  ', r.createdAt);

    const pluginAddr = Address.parse(r.plugin);
    const state = await client.getContractState(pluginAddr);
    if (state.state !== 'active') {
      console.log('status       REVOKED / not deployed (' + state.state + ')');
      continue;
    }

    const plugin = client.open(WithdrawerPlugin.createFromAddress(pluginAddr));
    const [data, remaining] = await Promise.all([plugin.getData(), plugin.getRemainingAllowance()]);

    const wallet = client.open(
      new WalletV4(Address.parse(r.wallet), { code: WALLET_V4R2_CODE, data: WALLET_V4R2_CODE })
    );
    let installed = false;
    try {
      installed = await wallet.getIsPluginInstalled(pluginAddr);
    } catch {
      /* wallet may be a different revision */
    }

    const now = Math.floor(Date.now() / 1000);
    const readyIn = Math.max(0, data.lastWithdrawal + data.cooldown - now);

    console.log('installed   ', installed);
    console.log('allowance   ', fromNano(remaining), 'TON remaining');
    console.log('max per pull', fromNano(data.maxPerWithdrawal), 'TON');
    console.log('cooldown    ', data.cooldown, 's', readyIn ? `(ready in ${readyIn}s)` : '(ready)');
    console.log('nonce       ', data.seqno);
    console.log('plugin bal  ', fromNano(state.balance), 'TON');
    console.log('receivers   ', r.receivers.length ? r.receivers.join('\n             ') : 'any');
    console.log('explorer    ', explorer(network, pluginAddr));
  }
  console.log();
}

main().catch((e) => {
  console.error('\n' + (e?.message ?? e) + '\n');
  process.exit(1);
});
