/**
 * Generates one funding address per chain for a live testnet run, and saves the
 * secrets to .testnet-keys.json (gitignored, chmod 600).
 *
 *   npx ts-node scripts/testnet-addresses.ts
 *
 * These are FRESH, THROWAWAY keys for TESTNET ONLY. Never send mainnet value to
 * them and never reuse them for anything that matters.
 */
import * as fs from 'fs';
import * as path from 'path';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.testnet-keys.json');

async function main() {
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : null;
  if (existing) {
    print(existing);
    console.log('(existing keys reused from .testnet-keys.json)\n');
    return;
  }

  // ---- TON testnet (wallet v4r2) ----
  const tonMnemonic = await mnemonicNew();
  const tonKeys = await mnemonicToPrivateKey(tonMnemonic);
  const tonWallet = WalletContractV4.create({ workchain: 0, publicKey: tonKeys.publicKey });
  const tonAddress = tonWallet.address.toString({ testOnly: true, bounceable: false });

  // ---- Ethereum Sepolia ----
  const { ethers } = require('../evm/node_modules/ethers');
  const evm = ethers.Wallet.createRandom();

  // ---- Bitcoin signet ----
  const btcLib = '../btc/node_modules/';
  const bitcoin = require(btcLib + 'bitcoinjs-lib');
  const ecc = require(btcLib + 'tiny-secp256k1');
  const { ECPairFactory } = require(btcLib + 'ecpair');
  const ECPair = ECPairFactory(ecc);
  const btcNet = bitcoin.networks.testnet; // signet shares testnet params
  const btcKey = ECPair.makeRandom({ network: btcNet });
  const btcAddress = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(btcKey.publicKey),
    network: btcNet,
  }).address;

  const rec = {
    warning: 'TESTNET THROWAWAY KEYS. Never send mainnet value here.',
    createdAt: new Date().toISOString(),
    ton: { network: 'testnet', address: tonAddress, mnemonic: tonMnemonic.join(' ') },
    ethereum: { network: 'sepolia', address: evm.address, privateKey: evm.privateKey },
    bitcoin: { network: 'signet', address: btcAddress, wif: btcKey.toWIF() },
  };

  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2));
  fs.chmodSync(OUT, 0o600);
  print(rec);
  console.log('Secrets saved to .testnet-keys.json (gitignored, chmod 600)\n');
}

function print(r: any) {
  console.log('\n================= FUND THESE ADDRESSES (TESTNET ONLY) =================\n');
  console.log('  TON  (testnet)');
  console.log('    ' + r.ton.address);
  console.log('    faucet: t.me/testgiver_ton_bot          need ~2 TON\n');
  console.log('  ETHEREUM (sepolia)');
  console.log('    ' + r.ethereum.address);
  console.log('    faucet: sepoliafaucet.com / google cloud faucet   need ~0.1 ETH\n');
  console.log('  BITCOIN (signet)');
  console.log('    ' + r.bitcoin.address);
  console.log('    faucet: signetfaucet.com               need ~0.001 sBTC\n');
  console.log('=======================================================================');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
