/**
 * End-to-end EVM demo on an in-process chain. No network, no real funds.
 *   npx hardhat run scripts/demo.ts
 */
import { ethers } from 'hardhat';
import { ZeroAddress } from 'ethers';

const fmt = (v: bigint) => ethers.formatEther(v).padStart(10);

async function main() {
  const [owner, alice, bob, relayer] = await ethers.getSigners();
  const operator = ethers.Wallet.createRandom();

  const withdrawer = await (await ethers.getContractFactory('Withdrawer')).deploy();
  const token = await (await ethers.getContractFactory('MockERC20')).deploy();
  const tokenAddr = await token.getAddress();
  await token.mint(await owner.getAddress(), ethers.parseEther('1000'));

  console.log('\n=== CONTRACTS ===');
  console.log('withdrawer ', await withdrawer.getAddress());
  console.log('token      ', tokenAddr);
  console.log('owner      ', await owner.getAddress());

  // ---- step 1: the one owner-signed setup -------------------------------
  await token.connect(owner).approve(await withdrawer.getAddress(), ethers.parseEther('100'));
  await withdrawer
    .connect(owner)
    .authorize(tokenAddr, operator.address, ethers.parseEther('50'), ethers.parseEther('20'), 0, []);

  console.log('\n=== STEP 1: AUTHORISE (owner signs twice: approve + authorize) ===');
  console.log('operator   ', operator.address, '(a hot key, NOT the wallet key)');
  const p0 = await withdrawer.policyOf(await owner.getAddress(), tokenAddr);
  console.log('allowance  ', fmt(p0.allowance), 'MOCK');
  console.log('max per    ', fmt(p0.maxPerWithdrawal), 'MOCK');
  console.log('\n>>> The owner is now offline for the rest of this demo. <<<');

  // ---- step 2: keyless pulls --------------------------------------------
  const { chainId } = await ethers.provider.getNetwork();
  const domain = {
    name: 'Withdrawer',
    version: '1',
    chainId,
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

  console.log('\n=== STEP 2: WITHDRAWALS (withdrawer + amount + receiver) ===');
  for (const [amt, to, label] of [
    ['12', alice, 'alice'],
    ['8', bob, 'bob'],
    ['15', alice, 'alice'],
  ] as const) {
    const args = {
      owner: await owner.getAddress(),
      token: tokenAddr,
      amount: ethers.parseEther(amt),
      receiver: await to.getAddress(),
      nonce: await withdrawer.nonces(await owner.getAddress(), tokenAddr),
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    const sig = await operator.signTypedData(domain, types, args);
    // broadcast by an unrelated relayer, who also pays the gas
    await withdrawer
      .connect(relayer)
      .withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig);
    console.log(`  amount=${amt.padStart(4)} MOCK -> ${label}   DELIVERED (gas paid by relayer)`);
  }

  console.log('\n=== RESULT ===');
  console.log('owner   ', fmt(await token.balanceOf(await owner.getAddress())), 'MOCK');
  console.log('alice   ', fmt(await token.balanceOf(await alice.getAddress())), 'MOCK');
  console.log('bob     ', fmt(await token.balanceOf(await bob.getAddress())), 'MOCK');
  const p1 = await withdrawer.policyOf(await owner.getAddress(), tokenAddr);
  console.log('left    ', fmt(p1.allowance), 'MOCK allowance');

  console.log('\n=== LIMITS ARE ENFORCED ON CHAIN ===');
  const bad = {
    owner: await owner.getAddress(),
    token: tokenAddr,
    amount: ethers.parseEther('25'),
    receiver: await alice.getAddress(),
    nonce: await withdrawer.nonces(await owner.getAddress(), tokenAddr),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  };
  const [, why] = await withdrawer.canWithdraw(bad.owner, bad.token, bad.amount, bad.receiver);
  console.log('  25 MOCK (cap 20)         REJECTED:', why);

  const impostor = ethers.Wallet.createRandom();
  const badSig = await impostor.signTypedData(domain, types, { ...bad, amount: ethers.parseEther('1') });
  try {
    await withdrawer.withdraw(bad.owner, bad.token, ethers.parseEther('1'), bad.receiver, bad.deadline, badSig);
    console.log('  stranger key             UNEXPECTEDLY ALLOWED');
  } catch {
    console.log('  stranger key             REJECTED by the contract');
  }

  const victim = await bob.getAddress();
  try {
    await withdrawer.withdraw(victim, tokenAddr, ethers.parseEther('1'), await alice.getAddress(), bad.deadline, '0x');
    console.log('  wallet that never opted in  UNEXPECTEDLY ALLOWED');
  } catch {
    console.log('  wallet that never opted in  REJECTED (NoPolicy)');
  }

  await withdrawer.connect(owner).revoke(tokenAddr);
  const p2 = await withdrawer.policyOf(await owner.getAddress(), tokenAddr);
  console.log('\n=== REVOKED ===');
  console.log('  policy exists?           ', p2.exists);
  console.log();
}

main().catch((e) => { console.error(e); process.exit(1); });
