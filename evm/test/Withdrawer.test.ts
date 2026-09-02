import { expect } from 'chai';
import { ethers } from 'hardhat';
import { time } from '@nomicfoundation/hardhat-network-helpers';
import { HDNodeWallet, Signer, ZeroAddress } from 'ethers';

const NATIVE = ZeroAddress;

async function signWithdraw(
  withdrawer: any,
  operator: HDNodeWallet,
  args: {
    owner: string;
    token: string;
    amount: bigint;
    receiver: string;
    nonce: bigint;
    deadline: bigint;
  }
) {
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
  return operator.signTypedData(domain, types, args);
}

describe('Withdrawer (EVM)', () => {
  let withdrawer: any;
  let token: any;
  let owner: Signer, ownerAddr: string;
  let receiver: Signer, receiverAddr: string;
  let stranger: Signer, strangerAddr: string;
  let operator: HDNodeWallet;
  let impostor: HDNodeWallet;

  const ONE = ethers.parseEther('1');
  const deadline = async () => BigInt((await time.latest()) + 3600);

  beforeEach(async () => {
    [owner, receiver, stranger] = await ethers.getSigners();
    ownerAddr = await owner.getAddress();
    receiverAddr = await receiver.getAddress();
    strangerAddr = await stranger.getAddress();

    operator = ethers.Wallet.createRandom();
    impostor = ethers.Wallet.createRandom();

    withdrawer = await (await ethers.getContractFactory('Withdrawer')).deploy();
    token = await (await ethers.getContractFactory('MockERC20')).deploy();
    await token.mint(ownerAddr, ethers.parseEther('1000'));
  });

  // ------------------------------------------------------------ ERC-20 path

  describe('ERC-20', () => {
    beforeEach(async () => {
      // The ONE owner-signed setup: approve + authorize.
      await token.connect(owner).approve(await withdrawer.getAddress(), ethers.parseEther('100'));
      await withdrawer
        .connect(owner)
        .authorize(await token.getAddress(), operator.address, ethers.parseEther('50'), ethers.parseEther('10'), 0, [], 0);
    });

    it('moves tokens with NO owner key: withdrawer + amount + receiver', async () => {
      const tokenAddr = await token.getAddress();
      const before = await token.balanceOf(receiverAddr);

      const args = {
        owner: ownerAddr,
        token: tokenAddr,
        amount: ONE * 5n,
        receiver: receiverAddr,
        nonce: await withdrawer.nonces(ownerAddr, tokenAddr),
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, operator, args);

      // Broadcast by a completely unrelated account. The owner is not involved.
      await expect(
        withdrawer
          .connect(stranger)
          .withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig)
      )
        .to.emit(withdrawer, 'Withdrawn')
        .withArgs(ownerAddr, tokenAddr, receiverAddr, ONE * 5n, 0n, strangerAddr);

      expect(await token.balanceOf(receiverAddr)).to.equal(before + ONE * 5n);
      const p = await withdrawer.policyOf(ownerAddr, tokenAddr);
      expect(p.allowance).to.equal(ethers.parseEther('45'));
    });

    it('rejects a signature from the wrong key', async () => {
      const tokenAddr = await token.getAddress();
      const args = {
        owner: ownerAddr,
        token: tokenAddr,
        amount: ONE,
        receiver: receiverAddr,
        nonce: 0n,
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, impostor, args);
      await expect(
        withdrawer.withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig)
      ).to.be.revertedWithCustomError(withdrawer, 'BadSignature');
    });

    it('cannot be replayed', async () => {
      const tokenAddr = await token.getAddress();
      const args = {
        owner: ownerAddr,
        token: tokenAddr,
        amount: ONE,
        receiver: receiverAddr,
        nonce: 0n,
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, operator, args);
      await withdrawer.withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig);
      await expect(
        withdrawer.withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig)
      ).to.be.revertedWithCustomError(withdrawer, 'BadSignature'); // nonce moved, digest no longer matches
    });

    it('enforces the per-withdrawal cap, the allowance and the cooldown', async () => {
      const tokenAddr = await token.getAddress();
      await withdrawer.connect(owner).setLimits(tokenAddr, ethers.parseEther('12'), ethers.parseEther('8'), 3600);

      const pull = async (amount: bigint) => {
        const args = {
          owner: ownerAddr,
          token: tokenAddr,
          amount,
          receiver: receiverAddr,
          nonce: await withdrawer.nonces(ownerAddr, tokenAddr),
          deadline: await deadline(),
        };
        const sig = await signWithdraw(withdrawer, operator, args);
        return withdrawer.withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig);
      };

      await expect(pull(ethers.parseEther('9'))).to.be.revertedWithCustomError(
        withdrawer,
        'OverPerWithdrawalCap'
      );

      await pull(ethers.parseEther('8'));
      await expect(pull(ONE)).to.be.revertedWithCustomError(withdrawer, 'CooldownActive');

      await time.increase(3601);
      await expect(pull(ethers.parseEther('5'))).to.be.revertedWithCustomError(
        withdrawer,
        'OverAllowance'
      );
      await pull(ethers.parseEther('4'));

      const p = await withdrawer.policyOf(ownerAddr, tokenAddr);
      expect(p.allowance).to.equal(0n);
    });

    it('honours an expired deadline', async () => {
      const tokenAddr = await token.getAddress();
      const past = BigInt((await time.latest()) - 1);
      const args = {
        owner: ownerAddr,
        token: tokenAddr,
        amount: ONE,
        receiver: receiverAddr,
        nonce: 0n,
        deadline: past,
      };
      const sig = await signWithdraw(withdrawer, operator, args);
      await expect(
        withdrawer.withdraw(args.owner, args.token, args.amount, args.receiver, past, sig)
      ).to.be.revertedWithCustomError(withdrawer, 'Expired');
    });

    it('CANNOT touch a wallet that never authorised it', async () => {
      const tokenAddr = await token.getAddress();
      const victim = stranger;
      const victimAddr = strangerAddr;
      await token.mint(victimAddr, ethers.parseEther('500'));

      const args = {
        owner: victimAddr,
        token: tokenAddr,
        amount: ethers.parseEther('100'),
        receiver: receiverAddr,
        nonce: 0n,
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, operator, args);

      await expect(
        withdrawer.withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig)
      ).to.be.revertedWithCustomError(withdrawer, 'NoPolicy');
      expect(await token.balanceOf(victimAddr)).to.equal(ethers.parseEther('500'));
      void victim;
    });

    it('cannot exceed the ERC-20 approve, even within the policy allowance', async () => {
      const tokenAddr = await token.getAddress();
      // Owner shrinks the ERC-20 approval behind the policy's back.
      await token.connect(owner).approve(await withdrawer.getAddress(), ONE);

      const args = {
        owner: ownerAddr,
        token: tokenAddr,
        amount: ONE * 5n,
        receiver: receiverAddr,
        nonce: 0n,
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, operator, args);
      await expect(
        withdrawer.withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig)
      ).to.be.reverted; // the ERC-20 itself refuses
    });

    it('revoking stops everything', async () => {
      const tokenAddr = await token.getAddress();
      await withdrawer.connect(owner).revoke(tokenAddr);

      const args = {
        owner: ownerAddr,
        token: tokenAddr,
        amount: ONE,
        receiver: receiverAddr,
        nonce: 0n,
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, operator, args);
      await expect(
        withdrawer.withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig)
      ).to.be.revertedWithCustomError(withdrawer, 'NoPolicy');
    });

    it('canWithdraw explains failures without spending gas', async () => {
      const tokenAddr = await token.getAddress();
      let [ok, reason] = await withdrawer.canWithdraw(ownerAddr, tokenAddr, ONE * 5n, receiverAddr);
      expect(ok).to.equal(true);
      expect(reason).to.equal('');

      [ok, reason] = await withdrawer.canWithdraw(ownerAddr, tokenAddr, ONE * 50n, receiverAddr);
      expect(ok).to.equal(false);
      expect(reason).to.equal('amount exceeds the per-withdrawal cap');

      [ok, reason] = await withdrawer.canWithdraw(strangerAddr, tokenAddr, ONE, receiverAddr);
      expect(reason).to.equal('no authorisation on record for this wallet');
    });
  });

  // ------------------------------------------------- permissionless ERC-20

  describe('permissionless mode', () => {
    it('works with no signature at all, to an allowlisted receiver', async () => {
      const tokenAddr = await token.getAddress();
      await token.connect(owner).approve(await withdrawer.getAddress(), ethers.parseEther('100'));
      await withdrawer
        .connect(owner)
        .authorize(tokenAddr, ZeroAddress, ethers.parseEther('50'), ethers.parseEther('10'), 0, [
          receiverAddr,
        ], 0);

      const before = await token.balanceOf(receiverAddr);
      // stranger triggers, empty signature
      await withdrawer
        .connect(stranger)
        .withdraw(ownerAddr, tokenAddr, ONE * 3n, receiverAddr, await deadline(), '0x');
      expect(await token.balanceOf(receiverAddr)).to.equal(before + ONE * 3n);
    });

    it('refuses a receiver that is not allowlisted', async () => {
      const tokenAddr = await token.getAddress();
      await token.connect(owner).approve(await withdrawer.getAddress(), ethers.parseEther('100'));
      await withdrawer
        .connect(owner)
        .authorize(tokenAddr, ZeroAddress, ethers.parseEther('50'), ethers.parseEther('10'), 0, [
          receiverAddr,
        ], 0);

      await expect(
        withdrawer
          .connect(stranger)
          .withdraw(ownerAddr, tokenAddr, ONE, strangerAddr, await deadline(), '0x')
      ).to.be.revertedWithCustomError(withdrawer, 'ReceiverNotAllowed');
    });

    it('refuses to authorise permissionless with an empty allowlist', async () => {
      const tokenAddr = await token.getAddress();
      await expect(
        withdrawer.connect(owner).authorize(tokenAddr, ZeroAddress, ONE, ONE, 0, [], 0)
      ).to.be.revertedWithCustomError(withdrawer, 'PermissionlessNeedsAllowlist');
    });
  });

  // ------------------------------------------------------------ native ETH

  describe('native ETH', () => {
    it('pulls ETH from the owner vault with no owner key', async () => {
      await withdrawer
        .connect(owner)
        .authorize(NATIVE, operator.address, ethers.parseEther('5'), ethers.parseEther('2'), 0, [], 0, {
          value: ethers.parseEther('5'),
        });

      expect(await withdrawer.ethVault(ownerAddr)).to.equal(ethers.parseEther('5'));

      const args = {
        owner: ownerAddr,
        token: NATIVE,
        amount: ethers.parseEther('2'),
        receiver: receiverAddr,
        nonce: 0n,
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, operator, args);

      await expect(
        withdrawer
          .connect(stranger)
          .withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig)
      ).to.changeEtherBalance(receiver, ethers.parseEther('2'));

      expect(await withdrawer.ethVault(ownerAddr)).to.equal(ethers.parseEther('3'));
    });

    it('lets the owner take their ETH back at any time', async () => {
      await withdrawer
        .connect(owner)
        .authorize(NATIVE, operator.address, ethers.parseEther('5'), ethers.parseEther('2'), 0, [], 0, {
          value: ethers.parseEther('5'),
        });
      await expect(
        withdrawer.connect(owner).withdrawEth(ethers.parseEther('5'))
      ).to.changeEtherBalance(owner, ethers.parseEther('5'));
      expect(await withdrawer.ethVault(ownerAddr)).to.equal(0n);
    });

    it('cannot pull more ETH than the vault holds', async () => {
      await withdrawer
        .connect(owner)
        .authorize(NATIVE, operator.address, ethers.parseEther('50'), ethers.parseEther('50'), 0, [], 0, {
          value: ethers.parseEther('1'),
        });
      const args = {
        owner: ownerAddr,
        token: NATIVE,
        amount: ethers.parseEther('10'),
        receiver: receiverAddr,
        nonce: 0n,
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, operator, args);
      await expect(
        withdrawer.withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig)
      ).to.be.revertedWithCustomError(withdrawer, 'InsufficientVault');
    });
  });

  // ----------------------------------------------------------- admin rights

  describe('administration', () => {
    beforeEach(async () => {
      await token.connect(owner).approve(await withdrawer.getAddress(), ethers.parseEther('100'));
      await withdrawer
        .connect(owner)
        .authorize(await token.getAddress(), operator.address, ONE, ONE, 0, [], 0);
    });

    it('only the owner can change their own limits', async () => {
      const tokenAddr = await token.getAddress();
      // A stranger calling setLimits edits their OWN (nonexistent) policy.
      await expect(
        withdrawer.connect(stranger).setLimits(tokenAddr, ONE * 999n, ONE * 999n, 0)
      ).to.be.revertedWithCustomError(withdrawer, 'NoPolicy');

      const p = await withdrawer.policyOf(ownerAddr, tokenAddr);
      expect(p.allowance).to.equal(ONE);
    });

    it('rejects a per-withdrawal cap above the allowance', async () => {
      const tokenAddr = await token.getAddress();
      await expect(
        withdrawer.connect(owner).setLimits(tokenAddr, ONE, ONE * 2n, 0)
      ).to.be.revertedWithCustomError(withdrawer, 'CapAboveAllowance');
    });

    it('will not drop to permissionless without an allowlist', async () => {
      const tokenAddr = await token.getAddress();
      await expect(
        withdrawer.connect(owner).setOperator(tokenAddr, ZeroAddress)
      ).to.be.revertedWithCustomError(withdrawer, 'PermissionlessNeedsAllowlist');
    });
  });

  // ------------------------------------------------- sender pays the gas

  describe('gas paid by the sender wallet', () => {
    const CAP = ethers.parseEther('0.05');

    beforeEach(async () => {
      await token.connect(owner).approve(await withdrawer.getAddress(), ethers.parseEther('100'));
      await withdrawer
        .connect(owner)
        .authorize(
          await token.getAddress(),
          operator.address,
          ethers.parseEther('50'),
          ethers.parseEther('10'),
          0,
          [],
          CAP,
          { value: ethers.parseEther('1') } // funds the gas tank
        );
    });

    const pull = async (amount: bigint, from = stranger) => {
      const tokenAddr = await token.getAddress();
      const args = {
        owner: ownerAddr,
        token: tokenAddr,
        amount,
        receiver: receiverAddr,
        nonce: await withdrawer.nonces(ownerAddr, tokenAddr),
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, operator, args);
      return withdrawer
        .connect(from)
        .withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig);
    };

    it('routes ETH sent with authorize() into the gas tank for token policies', async () => {
      expect(await withdrawer.gasTank(ownerAddr)).to.equal(ethers.parseEther('1'));
      expect(await withdrawer.ethVault(ownerAddr)).to.equal(0n);
    });

    it('leaves the broadcaster whole: the sender wallet bears the cost', async () => {
      const before = await ethers.provider.getBalance(strangerAddr);
      const tankBefore = await withdrawer.gasTank(ownerAddr);

      const tx = await pull(ONE);
      const rcpt = await tx.wait();
      const gasPaid = rcpt!.gasUsed * rcpt!.gasPrice;

      const after = await ethers.provider.getBalance(strangerAddr);
      const tankAfter = await withdrawer.gasTank(ownerAddr);
      const reimbursed = tankBefore - tankAfter;

      expect(reimbursed).to.be.greaterThan(0n);

      // The reimbursement must NEVER exceed the gas actually burned, otherwise
      // a relayer could profit at the sender's expense.
      expect(reimbursed).to.be.lessThanOrEqual(gasPaid);

      // ...and the relayer should be left very close to whole.
      const netCost = before - after;
      expect(netCost).to.be.lessThan(gasPaid);
      expect(netCost * 20n).to.be.lessThan(gasPaid); // under 5% out of pocket
    });

    it('emits GasReimbursed naming the payer and the relayer', async () => {
      await expect(pull(ONE)).to.emit(withdrawer, 'GasReimbursed');
    });

    it('never reimburses more than the owner-set cap', async () => {
      await withdrawer.connect(owner).setGasReimbursement(await token.getAddress(), 1000n); // 1000 wei
      const tankBefore = await withdrawer.gasTank(ownerAddr);
      await pull(ONE);
      expect(tankBefore - (await withdrawer.gasTank(ownerAddr))).to.equal(1000n);
    });

    it('reimburses nothing when the cap is zero', async () => {
      await withdrawer.connect(owner).setGasReimbursement(await token.getAddress(), 0);
      const tankBefore = await withdrawer.gasTank(ownerAddr);
      await pull(ONE);
      expect(await withdrawer.gasTank(ownerAddr)).to.equal(tankBefore);
    });

    it('still completes the withdrawal when the gas tank is empty', async () => {
      await withdrawer.connect(owner).withdrawGas(await withdrawer.gasTank(ownerAddr));
      expect(await withdrawer.gasTank(ownerAddr)).to.equal(0n);

      const before = await token.balanceOf(receiverAddr);
      await pull(ONE); // must not revert; the relayer simply absorbs the gas
      expect(await token.balanceOf(receiverAddr)).to.equal(before + ONE);
    });

    it('caps the drain even if the tank is smaller than the gas cost', async () => {
      await withdrawer.connect(owner).withdrawGas((await withdrawer.gasTank(ownerAddr)) - 500n);
      expect(await withdrawer.gasTank(ownerAddr)).to.equal(500n);
      await pull(ONE);
      expect(await withdrawer.gasTank(ownerAddr)).to.equal(0n); // spent, not overdrawn
    });

    it('a hostile relayer cannot drain the tank via a huge gas price', async () => {
      const tankBefore = await withdrawer.gasTank(ownerAddr);
      const tokenAddr = await token.getAddress();
      const args = {
        owner: ownerAddr,
        token: tokenAddr,
        amount: ONE,
        receiver: receiverAddr,
        nonce: await withdrawer.nonces(ownerAddr, tokenAddr),
        deadline: await deadline(),
      };
      const sig = await signWithdraw(withdrawer, operator, args);
      await withdrawer
        .connect(stranger)
        .withdraw(args.owner, args.token, args.amount, args.receiver, args.deadline, sig, {
          gasPrice: ethers.parseUnits('5000', 'gwei'),
        });

      // bounded by the cap, not by the relayer's chosen gas price
      expect(tankBefore - (await withdrawer.gasTank(ownerAddr))).to.be.lessThanOrEqual(CAP);
    });

    it('lets the owner reclaim unspent gas money at any time', async () => {
      const tank = await withdrawer.gasTank(ownerAddr);
      await expect(withdrawer.connect(owner).withdrawGas(tank)).to.changeEtherBalance(owner, tank);
      expect(await withdrawer.gasTank(ownerAddr)).to.equal(0n);
    });

    it('keeps the gas tank separate from the ETH vault', async () => {
      await withdrawer.connect(owner).depositEth({ value: ethers.parseEther('2') });
      expect(await withdrawer.ethVault(ownerAddr)).to.equal(ethers.parseEther('2'));
      expect(await withdrawer.gasTank(ownerAddr)).to.equal(ethers.parseEther('1'));

      await pull(ONE);
      // paying gas must not touch the principal
      expect(await withdrawer.ethVault(ownerAddr)).to.equal(ethers.parseEther('2'));
    });
  });
});
