/**
 * STEP 1 -- the one and only time the wallet owner's key is used.
 *
 * Installs a withdrawer plugin on your wallet v4 with hard, on-chain limits.
 * After this you can withdraw forever with `npm run withdraw`, no owner key.
 *
 *   OWNER_MNEMONIC="word1 word2 ... word24" \
 *   npm run authorize -- --allowance 10 --max-per 2 --cooldown 60
 *
 * Options
 *   --allowance N        lifetime budget in TON            (required)
 *   --max-per N          ceiling for a single withdrawal   (required)
 *   --cooldown SECONDS   minimum gap between withdrawals   (default 0)
 *   --receivers A,B,C    allowlist of destinations         (default: any)
 *   --permissionless     no operator key at all; requires --receivers
 *   --plugin-id N        salt, to run several withdrawers  (default 0)
 *   --network testnet|mainnet                              (default testnet)
 *   --deposit N          TON to seed the plugin with       (default 0.3)
 */
import { Address, fromNano, toNano } from '@ton/core';
import { mnemonicToPrivateKey, keyPairFromSeed } from '@ton/crypto';
import { randomBytes } from 'crypto';

import { WalletV4, WALLET_V4R2_CODE } from '../src/WalletV4';
import { WithdrawerPlugin } from '../src/WithdrawerPlugin';
import { compileWithdrawer } from './build';
import {
  args,
  makeClient,
  parseNetwork,
  requireArg,
  saveRecord,
  explorer,
  STORE_PATH,
} from './lib/net';

async function main() {
  const a = args();
  const network = parseNetwork(a);

  const mnemonic = process.env.OWNER_MNEMONIC;
  if (!mnemonic) {
    console.error(
      '\nSet OWNER_MNEMONIC to the 24 words of the wallet you want to authorise.\n' +
        'It is used once here, in this process, and never written to disk.\n'
    );
    process.exit(1);
  }

  const allowance = toNano(requireArg(a, 'allowance', 'lifetime budget in TON, e.g. --allowance 10'));
  const maxPer = toNano(requireArg(a, 'max-per', 'per-withdrawal cap in TON, e.g. --max-per 2'));
  const cooldown = parseInt(a.cooldown ?? '0', 10);
  const pluginId = parseInt(a['plugin-id'] ?? '0', 10);
  const deposit = toNano(a.deposit ?? '0.3');
  const permissionless = a.permissionless === 'true';
  const receivers = (a.receivers ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Address.parse(s));

  if (permissionless && receivers.length === 0) {
    console.error(
      '\n--permissionless means ANYONE can trigger a withdrawal with no key.\n' +
        'That is only safe if the destination is fixed, so --receivers is required.\n'
    );
    process.exit(1);
  }
  if (maxPer > allowance) {
    console.error('\n--max-per cannot exceed --allowance.\n');
    process.exit(1);
  }

  const keys = await mnemonicToPrivateKey(mnemonic.trim().split(/\s+/));
  const client = makeClient(network);
  const pluginCode = await compileWithdrawer();

  const wallet = client.open(
    WalletV4.createFromConfig({ publicKey: keys.publicKey }, WALLET_V4R2_CODE)
  );

  const state = await client.getContractState(wallet.address);
  if (state.state !== 'active') {
    console.error(
      `\nWallet ${wallet.address.toString({ testOnly: network === 'testnet' })} is not active.\n` +
        'Fund and deploy it first.\n'
    );
    process.exit(1);
  }

  const operator = permissionless ? null : keyPairFromSeed(randomBytes(32));

  const plugin = WithdrawerPlugin.createFromConfig(
    {
      wallet: wallet.address,
      operatorPublicKey: operator?.publicKey ?? null,
      totalAllowance: allowance,
      maxPerWithdrawal: maxPer,
      cooldown,
      pluginId,
      receivers,
    },
    pluginCode
  );

  console.log('\n=== AUTHORISING A WITHDRAWER ===');
  console.log('network        ', network);
  console.log('wallet         ', wallet.address.toString({ testOnly: network === 'testnet' }));
  console.log('plugin         ', plugin.address.toString({ testOnly: network === 'testnet' }));
  console.log('mode           ', permissionless ? 'permissionless (no key)' : 'operator key');
  console.log('allowance      ', fromNano(allowance), 'TON');
  console.log('max per pull   ', fromNano(maxPer), 'TON');
  console.log('cooldown       ', cooldown, 's');
  console.log('receivers      ', receivers.length ? receivers.map(String).join(', ') : 'any');
  console.log('\nSigning with the owner key (this is the last time it is needed)...');

  const seqno = await wallet.getSeqno();
  await wallet.sendDeployAndInstallPlugin({
    secretKey: keys.secretKey,
    seqno,
    value: deposit,
    stateInit: plugin.init,
  });

  // wait for the seqno to advance so we know it landed
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if ((await wallet.getSeqno()) > seqno) break;
    process.stdout.write('.');
  }

  saveRecord({
    network,
    wallet: wallet.address.toString({ testOnly: network === 'testnet' }),
    plugin: plugin.address.toString({ testOnly: network === 'testnet' }),
    operatorPublicKey: operator ? operator.publicKey.toString('hex') : null,
    operatorSecretKey: operator ? operator.secretKey.toString('hex') : null,
    totalAllowance: allowance.toString(),
    maxPerWithdrawal: maxPer.toString(),
    cooldown,
    receivers: receivers.map((r) => r.toString({ testOnly: network === 'testnet' })),
    createdAt: new Date().toISOString(),
  });

  console.log('\n\nAuthorised.');
  console.log('saved to  ', STORE_PATH, '(gitignored, chmod 600)');
  console.log('explorer  ', explorer(network, plugin.address));
  console.log('\nFrom now on, no owner key. Withdraw with:\n');
  console.log(
    `  npm run withdraw -- --withdrawer ${wallet.address.toString({
      testOnly: network === 'testnet',
    })} --amount 1 --receiver <ADDRESS>\n`
  );
  console.log('Revoke at any time with:  npm run revoke -- --withdrawer <WALLET>\n');
}

main().catch((e) => {
  console.error('\n' + (e?.message ?? e) + '\n');
  process.exit(1);
});
