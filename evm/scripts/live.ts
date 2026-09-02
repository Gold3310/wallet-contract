/**
 * LIVE end-to-end run against a real JSON-RPC endpoint.
 *
 * Works unchanged against a local node or a public testnet -- only RPC_URL and
 * the funding source differ. Every step is a real broadcast transaction with a
 * real receipt; nothing here is emulated in-process.
 *
 *   # local
 *   RPC_URL=http://127.0.0.1:8545 npx ts-node scripts/live.ts
 *
 *   # sepolia
 *   RPC_URL=https://... OWNER_PRIVATE_KEY=0x... npx ts-node scripts/live.ts
 *
 * If OWNER_PRIVATE_KEY is unset, a throwaway key is generated and saved to
 * .live-key.json (gitignored, chmod 600) and the script prints the address to
 * fund, then exits. Run it again once that address has testnet funds.
 */
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const KEY_FILE = path.join(ROOT, '.live-key.json');

function artifact(name: string) {
  const p = path.join(ROOT, 'artifacts', 'contracts', name);
  if (!fs.existsSync(p)) {
    console.error(
      '\nContracts are not compiled yet. Run:\n\n  npx hardhat compile\n\n' +
        '(`npm run live` does this for you.)\n'
    );
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Sepolia and friends need real confirmations; a dev node mines instantly. */
async function send(label: string, txPromise: Promise<any>, confirmations: number) {
  const tx = await txPromise;
  process.stdout.write(`  ${label.padEnd(12)} ${tx.hash} `);
  const rcpt = await tx.wait(confirmations);
  console.log('ok');
  return rcpt;
}

function loadOrCreateKey(): { privateKey: string; address: string; generated: boolean } {
  if (process.env.OWNER_PRIVATE_KEY) {
    const w = new ethers.Wallet(process.env.OWNER_PRIVATE_KEY);
    return { privateKey: w.privateKey, address: w.address, generated: false };
  }
  if (fs.existsSync(KEY_FILE)) {
    const saved = JSON.parse(fs.readFileSync(KEY_FILE, 'utf8'));
    return { ...saved, generated: false };
  }
  const w = ethers.Wallet.createRandom();
  const rec = { privateKey: w.privateKey, address: w.address };
  fs.writeFileSync(KEY_FILE, JSON.stringify(rec, null, 2));
  fs.chmodSync(KEY_FILE, 0o600);
  return { ...rec, generated: true };
}

const eth = (v: bigint) => ethers.formatEther(v);

async function main() {
  const rpcUrl = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
  // cacheTimeout -1 disables ethers' short-lived response cache, which would
  // otherwise serve a stale balance right after we fund an account.
  const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1 });

  const net = await provider.getNetwork();
  const isLocal = net.chainId === 31337n;
  const confirmations = isLocal ? 0 : 1;
  const explorer =
    net.chainId === 11155111n ? 'https://sepolia.etherscan.io/tx/' : null;

  const key = loadOrCreateKey();
  const owner = new ethers.Wallet(key.privateKey, provider);

  console.log('\n=== NETWORK ===');
  console.log('rpc        ', rpcUrl);
  console.log('chainId    ', net.chainId.toString(), isLocal ? '(local dev node)' : '');
  console.log('block      ', await provider.getBlockNumber());
  console.log('owner      ', owner.address);

  let balance = await provider.getBalance(owner.address);
  console.log('balance    ', eth(balance), 'ETH');

  // On a local node, top the owner up from a prefunded account.
  if (isLocal && balance < ethers.parseEther('1')) {
    const funder = new ethers.Wallet(
      '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      provider
    );
    await (await funder.sendTransaction({ to: owner.address, value: ethers.parseEther('20') })).wait();
    balance = await provider.getBalance(owner.address);
    console.log('funded ->  ', eth(balance), 'ETH');
  }

  const NEEDED = ethers.parseEther('0.08');
  if (balance < NEEDED) {
    console.log('\n---------------------------------------------------------------');
    console.log('THIS ADDRESS NEEDS TESTNET FUNDS BEFORE THE RUN CAN CONTINUE:');
    console.log('\n   ' + owner.address + '\n');
    console.log('It needs about ' + eth(NEEDED) + ' test ETH (7 transactions).');
    console.log('Sepolia faucets: sepoliafaucet.com, cloud.google.com/application/web3/faucet');
    console.log('\nThen run the same command again.');
    if (key.generated) console.log('The private key was saved to ' + KEY_FILE);
    console.log('---------------------------------------------------------------\n');
    process.exit(2);
  }

  // ---- deploy ------------------------------------------------------------
  const wArt = artifact('Withdrawer.sol/Withdrawer.json');
  const tArt = artifact('test/MockERC20.sol/MockERC20.json');

  console.log('\n=== DEPLOY ===');
  const withdrawer = await new ethers.ContractFactory(wArt.abi, wArt.bytecode, owner).deploy();
  await withdrawer.waitForDeployment();
  console.log('Withdrawer ', await withdrawer.getAddress());

  const token = await new ethers.ContractFactory(tArt.abi, tArt.bytecode, owner).deploy();
  await token.waitForDeployment();
  const tokenAddr = await token.getAddress();
  console.log('MockERC20  ', tokenAddr);

  await send('mint', (token as any).mint(owner.address, ethers.parseEther('1000')), confirmations);

  // ---- step 1: authorise once -------------------------------------------
  const operator = ethers.Wallet.createRandom();
  const receiver = ethers.Wallet.createRandom();
  const relayer = ethers.Wallet.createRandom().connect(provider);
  const GAS_CAP = ethers.parseEther('0.02');

  console.log('\n=== STEP 1: AUTHORISE (owner signs; last time) ===');
  await send(
    'approve',
    (token as any).approve(await withdrawer.getAddress(), ethers.parseEther('100')),
    confirmations
  );
  await send(
    'authorize',
    (withdrawer as any).authorize(
      tokenAddr,
      operator.address,
      ethers.parseEther('50'),
      ethers.parseEther('10'),
      0,
      [],
      GAS_CAP,
      { value: ethers.parseEther('0.02') } // gas tank
    ),
    confirmations
  );
  console.log('operator   ', operator.address, '(hot key, not the wallet key)');
  console.log('gas tank   ', eth(await (withdrawer as any).gasTank(owner.address)), 'ETH');

  // Seed the relayer from live fee data rather than a guess: enough to cover
  // one withdrawal at the current gas price, with headroom for a price spike.
  const fee = await provider.getFeeData();
  const gasPriceNow = fee.maxFeePerGas ?? fee.gasPrice ?? ethers.parseUnits('2', 'gwei');
  const seed = gasPriceNow * 200_000n * 3n;
  await send(
    'seed relayer',
    owner.sendTransaction({ to: relayer.address, value: seed }),
    confirmations
  );
  console.log('relayer    ', relayer.address);
  console.log('seeded     ', eth(seed), 'ETH at', ethers.formatUnits(gasPriceNow, 'gwei'), 'gwei');

  // ---- step 2: keyless withdrawal ---------------------------------------
  console.log('\n=== STEP 2: WITHDRAWAL (withdrawer + amount + receiver, no owner key) ===');

  const amount = ethers.parseEther('7');
  const nonce = await (withdrawer as any).nonces(owner.address, tokenAddr);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const domain = {
    name: 'Withdrawer',
    version: '1',
    chainId: net.chainId,
    verifyingContract: await withdrawer.getAddress(),
  };
  const types = {
    Withdraw: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'receiver', type: 'address' },
      { name: 'nonce', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
    ],
  };
  const sig = await operator.signTypedData(domain, types, {
    owner: owner.address,
    token: tokenAddr,
    amount,
    receiver: receiver.address,
    nonce,
    deadline,
  });

  const relayerBefore = await provider.getBalance(relayer.address);
  const tankBefore = await (withdrawer as any).gasTank(owner.address);

  const rcpt = await send(
    'withdraw',
    (withdrawer as any)
      .connect(relayer)
      .withdraw(owner.address, tokenAddr, amount, receiver.address, deadline, sig),
    confirmations
  );
  const wTx = { hash: rcpt.hash };

  const relayerAfter = await provider.getBalance(relayer.address);
  const tankAfter = await (withdrawer as any).gasTank(owner.address);

  const burned = BigInt(rcpt.gasUsed) * BigInt(rcpt.gasPrice);
  const reimbursed = BigInt(tankBefore) - BigInt(tankAfter);
  const relayerNet = BigInt(relayerBefore) - BigInt(relayerAfter);

  console.log('tx         ', wTx.hash);
  if (explorer) console.log('explorer   ', explorer + wTx.hash);
  console.log('gasUsed    ', rcpt.gasUsed.toString());
  console.log('gasPrice   ', ethers.formatUnits(BigInt(rcpt.gasPrice), 'gwei'), 'gwei');
  console.log('delivered  ', eth(await (token as any).balanceOf(receiver.address)), 'MOCK to', receiver.address);

  console.log('\n=== GAS ACCOUNTING (the thing this run exists to validate) ===');
  console.log('  burned by the transaction  ', eth(burned), 'ETH');
  console.log('  reimbursed from sender     ', eth(reimbursed), 'ETH');
  console.log('  relayer net cost           ', eth(relayerNet), 'ETH');
  const pct = burned > 0n ? Number((relayerNet * 10000n) / burned) / 100 : 0;
  console.log('  relayer out of pocket      ', pct.toFixed(2) + '% of gas burned');
  console.log(
    '  reimbursement <= burned?   ',
    reimbursed <= burned ? 'YES (relayer cannot profit)' : 'NO -- BUG'
  );

  console.log('\n=== FINAL STATE ===');
  const p = await (withdrawer as any).policyOf(owner.address, tokenAddr);
  console.log('  allowance left  ', eth(p.allowance), 'MOCK');
  console.log('  gas tank left   ', eth(BigInt(tankAfter)), 'ETH');
  console.log('  nonce           ', (await (withdrawer as any).nonces(owner.address, tokenAddr)).toString());
  console.log();

  if (reimbursed > burned) process.exit(1);
}

main().catch((e) => {
  console.error('\n' + (e?.shortMessage ?? e?.message ?? e) + '\n');
  process.exit(1);
});
