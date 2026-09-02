/**
 * Kill switch. Removes the withdrawer from the wallet's plugin dictionary and
 * tears the plugin down, returning its balance. Needs the owner key -- granting
 * and revoking are the two things only the owner can ever do.
 *
 *   OWNER_MNEMONIC="..." npm run revoke -- --withdrawer <WALLET>
 */
import { Address, toNano } from '@ton/core';
import { mnemonicToPrivateKey } from '@ton/crypto';

import { WalletV4, WALLET_V4R2_CODE } from '../src/WalletV4';
import { args, findRecord, makeClient, parseNetwork, requireArg, explorer } from './lib/net';

async function main() {
  const a = args();
  const network = parseNetwork(a);
  const withdrawerArg = requireArg(a, 'withdrawer', 'the wallet whose allowance you want to cancel');

  const mnemonic = process.env.OWNER_MNEMONIC;
  if (!mnemonic) {
    console.error('\nSet OWNER_MNEMONIC to the 24 words of the wallet being revoked.\n');
    process.exit(1);
  }

  const withdrawer = Address.parse(withdrawerArg);
  const rec = findRecord(withdrawer.toString(), network);
  const pluginAddr = a.plugin ? Address.parse(a.plugin) : rec && Address.parse(rec.plugin);
  if (!pluginAddr) {
    console.error(
      `\nNo withdrawer on record for ${withdrawerArg} on ${network}.\n` +
        'Pass --plugin <ADDRESS> explicitly if you know it.\n'
    );
    process.exit(1);
  }

  const keys = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  const client = makeClient(network);
  const wallet = client.open(
    WalletV4.createFromConfig({ publicKey: keys.publicKey }, WALLET_V4R2_CODE)
  );

  if (!wallet.address.equals(withdrawer)) {
    console.error(
      `\nOWNER_MNEMONIC belongs to ${wallet.address.toString({
        testOnly: network === 'testnet',
      })}, not ${withdrawerArg}.\n`
    );
    process.exit(1);
  }

  if (!(await wallet.getIsPluginInstalled(pluginAddr))) {
    console.log('\nAlready revoked: that plugin is not installed on this wallet.\n');
    return;
  }

  const seqno = await wallet.getSeqno();
  await wallet.sendRemovePlugin({
    secretKey: keys.secretKey,
    seqno,
    plugin: pluginAddr,
    value: toNano('0.05'),
  });

  console.log('\nRevoking...');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if ((await wallet.getSeqno()) > seqno) break;
    process.stdout.write('.');
  }

  const still = await wallet.getIsPluginInstalled(pluginAddr);
  console.log(
    '\n' + (still ? 'Still installed, retry.' : 'Revoked. That withdrawer can never pull again.')
  );
  console.log('explorer  ', explorer(network, pluginAddr), '\n');
}

main().catch((e) => {
  console.error('\n' + (e?.message ?? e) + '\n');
  process.exit(1);
});
