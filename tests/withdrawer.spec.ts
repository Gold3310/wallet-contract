import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, Cell, toNano } from '@ton/core';
import { KeyPair, keyPairFromSeed } from '@ton/crypto';
import '@ton/test-utils';
import { randomBytes } from 'crypto';

import { WalletV4 } from '../src/WalletV4';
import {
  WithdrawerPlugin,
  withdrawerConfigToCell,
  RECLAIM_TIMEOUT,
} from '../src/WithdrawerPlugin';
import { compileWithdrawer, compileWalletV4 } from '../scripts/build';

/** 0x706c7567 | 0x80000000 as an UNSIGNED 32-bit op, the way the VM reports it. */
const OP_PAYMENT_RESPONSE = (0x706c7567 | 0x80000000) >>> 0;

describe('Wallet v4 keyless withdrawer plugin', () => {
  let pluginCode: Cell;
  let walletCode: Cell;

  let blockchain: Blockchain;
  let ownerKeys: KeyPair;
  let operatorKeys: KeyPair;
  let wallet: SandboxContract<WalletV4>;
  let deployer: SandboxContract<TreasuryContract>;
  let receiver: SandboxContract<TreasuryContract>;
  let otherReceiver: SandboxContract<TreasuryContract>;

  beforeAll(async () => {
    pluginCode = await compileWithdrawer();
    walletCode = await compileWalletV4();
  });

  beforeEach(async () => {
    blockchain = await Blockchain.create();
    blockchain.now = 1_800_000_000;

    ownerKeys = keyPairFromSeed(randomBytes(32));
    operatorKeys = keyPairFromSeed(randomBytes(32));

    deployer = await blockchain.treasury('deployer');
    receiver = await blockchain.treasury('receiver');
    otherReceiver = await blockchain.treasury('otherReceiver');

    wallet = blockchain.openContract(
      WalletV4.createFromConfig({ publicKey: ownerKeys.publicKey }, walletCode)
    );
    await wallet.sendDeploy(deployer.getSender(), toNano('100'));
  });

  /** Owner signs ONCE here. Every later withdrawal uses no owner key at all. */
  async function authorize(cfg: {
    operatorPublicKey?: Buffer | null;
    totalAllowance?: bigint;
    maxPerWithdrawal?: bigint;
    cooldown?: number;
    receivers?: Address[];
    pluginId?: number;
  }) {
    const plugin = blockchain.openContract(
      WithdrawerPlugin.createFromConfig(
        {
          wallet: wallet.address,
          operatorPublicKey:
            'operatorPublicKey' in cfg ? cfg.operatorPublicKey : operatorKeys.publicKey,
          totalAllowance: cfg.totalAllowance ?? toNano('10'),
          maxPerWithdrawal: cfg.maxPerWithdrawal ?? toNano('5'),
          cooldown: cfg.cooldown ?? 0,
          receivers: cfg.receivers,
          pluginId: cfg.pluginId ?? 0,
        },
        pluginCode
      )
    );

    const res = await wallet.sendDeployAndInstallPlugin({
      secretKey: ownerKeys.secretKey,
      seqno: await wallet.getSeqno(),
      value: toNano('0.5'),
      stateInit: plugin.init,
      validUntil: blockchain.now! + 300,
    });

    expect(res.transactions).toHaveTransaction({
      from: wallet.address,
      to: plugin.address,
      deploy: true,
      success: true,
    });
    expect(await wallet.getIsPluginInstalled(plugin.address)).toBe(true);
    return plugin;
  }

  it('installs the plugin with a single owner signature', async () => {
    const plugin = await authorize({});
    expect(await plugin.getSeqno()).toBe(0);
    expect(await plugin.getRemainingAllowance()).toBe(toNano('10'));
    expect((await plugin.getWallet()).toString()).toBe(wallet.address.toString());
    expect(await wallet.getPluginList()).toHaveLength(1);
  });

  it('moves funds with NO owner key: withdrawer + amount + receiver only', async () => {
    const plugin = await authorize({});

    const before = await receiver.getBalance();
    const amount = toNano('3');

    // The only secret used is the operator key. The owner key is not touched.
    const res = await plugin.sendWithdraw({
      seqno: await plugin.getSeqno(),
      amount,
      receiver: receiver.address,
      operatorSecretKey: operatorKeys.secretKey,
      validUntil: blockchain.now! + 300,
    });

    // plugin asks the wallet for money ...
    expect(res.transactions).toHaveTransaction({
      from: plugin.address,
      to: wallet.address,
      op: 0x706c7567,
      success: true,
    });
    // ... wallet pays the plugin ...
    expect(res.transactions).toHaveTransaction({
      from: wallet.address,
      to: plugin.address,
      op: OP_PAYMENT_RESPONSE,
      success: true,
    });
    // ... plugin forwards EXACTLY `amount` to the receiver (mode 1: the plugin
    // pays the forward fee out of its own balance, so nothing is skimmed).
    expect(res.transactions).toHaveTransaction({
      from: plugin.address,
      to: receiver.address,
      op: 0x77746864,
      value: amount,
      success: true,
    });

    // The receiver's own balance grows by `amount` minus the gas its account
    // burns accepting the message -- that fee is paid by the receiver, not us.
    const delta = (await receiver.getBalance()) - before;
    expect(delta).toBeLessThanOrEqual(amount);
    expect(delta).toBeGreaterThan(amount - toNano('0.01'));
    expect(await plugin.getSeqno()).toBe(1);
    expect(await plugin.getRemainingAllowance()).toBe(toNano('7'));
  });

  it('works fully permissionlessly (no key whatsoever) when receivers are allowlisted', async () => {
    const plugin = await authorize({
      operatorPublicKey: null,
      receivers: [receiver.address],
    });

    const res = await plugin.sendWithdraw({
      seqno: 0,
      amount: toNano('2'),
      receiver: receiver.address,
      operatorSecretKey: null, // <- literally no signature in the message
      validUntil: blockchain.now! + 300,
    });

    expect(res.transactions).toHaveTransaction({
      from: plugin.address,
      to: receiver.address,
      op: 0x77746864,
      value: toNano('2'),
      success: true,
    });
    expect(await plugin.getRemainingAllowance()).toBe(toNano('8'));
  });

  it('refuses a non-allowlisted receiver in permissionless mode', async () => {
    const plugin = await authorize({
      operatorPublicKey: null,
      receivers: [receiver.address],
    });

    await expect(
      plugin.sendWithdraw({
        seqno: 0,
        amount: toNano('1'),
        receiver: otherReceiver.address, // attacker's own address
        operatorSecretKey: null,
        validUntil: blockchain.now! + 300,
      })
    ).rejects.toThrow();

    expect(await plugin.getRemainingAllowance()).toBe(toNano('10'));
  });

  it('rejects a wrong operator signature', async () => {
    const plugin = await authorize({});
    const impostor = keyPairFromSeed(randomBytes(32));

    await expect(
      plugin.sendWithdraw({
        seqno: 0,
        amount: toNano('1'),
        receiver: receiver.address,
        operatorSecretKey: impostor.secretKey,
        validUntil: blockchain.now! + 300,
      })
    ).rejects.toThrow();
  });

  it('enforces max_per_withdrawal, total allowance and cooldown', async () => {
    const plugin = await authorize({
      totalAllowance: toNano('6'),
      maxPerWithdrawal: toNano('4'),
      cooldown: 3600,
    });
    const sk = operatorKeys.secretKey;
    const vu = () => blockchain.now! + 300;

    // over the per-tx cap
    await expect(
      plugin.sendWithdraw({ seqno: 0, amount: toNano('5'), receiver: receiver.address, operatorSecretKey: sk, validUntil: vu() })
    ).rejects.toThrow();

    // ok
    await plugin.sendWithdraw({ seqno: 0, amount: toNano('4'), receiver: receiver.address, operatorSecretKey: sk, validUntil: vu() });
    expect(await plugin.getRemainingAllowance()).toBe(toNano('2'));

    // cooldown still active
    await expect(
      plugin.sendWithdraw({ seqno: 1, amount: toNano('1'), receiver: receiver.address, operatorSecretKey: sk, validUntil: vu() })
    ).rejects.toThrow();

    blockchain.now! += 3601;

    // over the remaining budget
    await expect(
      plugin.sendWithdraw({ seqno: 1, amount: toNano('3'), receiver: receiver.address, operatorSecretKey: sk, validUntil: vu() })
    ).rejects.toThrow();

    // within budget
    await plugin.sendWithdraw({ seqno: 1, amount: toNano('2'), receiver: receiver.address, operatorSecretKey: sk, validUntil: vu() });
    expect(await plugin.getRemainingAllowance()).toBe(0n);
  });

  it('rejects replayed and expired requests', async () => {
    const plugin = await authorize({});
    const body = WithdrawerPlugin.buildWithdrawBody({
      seqno: 0,
      amount: toNano('1'),
      receiver: receiver.address,
      operatorSecretKey: operatorKeys.secretKey,
      validUntil: blockchain.now! + 300,
    });

    await blockchain.sendMessage({
      info: { type: 'external-in', dest: plugin.address, importFee: 0n },
      body,
    } as any);
    expect(await plugin.getSeqno()).toBe(1);

    // exact same message again -> seqno mismatch
    await expect(
      blockchain.sendMessage({
        info: { type: 'external-in', dest: plugin.address, importFee: 0n },
        body,
      } as any)
    ).rejects.toThrow();

    // expired
    await expect(
      plugin.sendWithdraw({
        seqno: 1,
        amount: toNano('1'),
        receiver: receiver.address,
        operatorSecretKey: operatorKeys.secretKey,
        validUntil: blockchain.now! - 1,
      })
    ).rejects.toThrow();
  });

  it('CANNOT touch a wallet that never installed it', async () => {
    const victimKeys = keyPairFromSeed(randomBytes(32));
    const victim = blockchain.openContract(
      WalletV4.createFromConfig({ publicKey: victimKeys.publicKey }, walletCode)
    );
    await victim.sendDeploy(deployer.getSender(), toNano('100'));

    // A plugin pointed at the victim, deployed and funded by the attacker.
    const rogue = blockchain.openContract(
      WithdrawerPlugin.createFromConfig(
        {
          wallet: victim.address,
          operatorPublicKey: operatorKeys.publicKey,
          totalAllowance: toNano('50'),
          maxPerWithdrawal: toNano('50'),
        },
        pluginCode
      )
    );
    await deployer.send({
      to: rogue.address,
      value: toNano('1'),
      init: rogue.init,
      bounce: false,
    });

    const victimBefore = (await blockchain.getContract(victim.address)).balance;
    const attackerBefore = await otherReceiver.getBalance();

    const res = await rogue.sendWithdraw({
      seqno: 0,
      amount: toNano('40'),
      receiver: otherReceiver.address,
      operatorSecretKey: operatorKeys.secretKey,
      validUntil: blockchain.now! + 300,
    });

    // The victim wallet ignores the request: not in its plugin dictionary.
    expect(res.transactions).not.toHaveTransaction({
      from: victim.address,
      to: rogue.address,
      op: OP_PAYMENT_RESPONSE,
    });
    expect(await otherReceiver.getBalance()).toBe(attackerBefore);
    const victimAfter = (await blockchain.getContract(victim.address)).balance;
    expect(victimAfter).toBeGreaterThan(victimBefore - toNano('0.1'));
  });

  it('restores the allowance when the wallet cannot pay (bounce)', async () => {
    const poorKeys = keyPairFromSeed(randomBytes(32));
    const poor = blockchain.openContract(
      WalletV4.createFromConfig({ publicKey: poorKeys.publicKey }, walletCode)
    );
    await poor.sendDeploy(deployer.getSender(), toNano('1'));

    const plugin = blockchain.openContract(
      WithdrawerPlugin.createFromConfig(
        {
          wallet: poor.address,
          operatorPublicKey: operatorKeys.publicKey,
          totalAllowance: toNano('100'),
          maxPerWithdrawal: toNano('100'),
        },
        pluginCode
      )
    );
    await poor.sendDeployAndInstallPlugin({
      secretKey: poorKeys.secretKey,
      seqno: await poor.getSeqno(),
      value: toNano('0.3'),
      stateInit: plugin.init,
      validUntil: blockchain.now! + 300,
    });

    await plugin.sendWithdraw({
      seqno: 0,
      amount: toNano('90'), // far more than the wallet holds
      receiver: receiver.address,
      operatorSecretKey: operatorKeys.secretKey,
      validUntil: blockchain.now! + 300,
    });

    // budget rolled back by the bounce handler
    expect(await plugin.getRemainingAllowance()).toBe(toNano('100'));
  });

  it('lets the owner revoke the plugin, which tears it down and refunds the wallet', async () => {
    const plugin = await authorize({});

    await plugin.sendWithdraw({
      seqno: 0,
      amount: toNano('1'),
      receiver: receiver.address,
      operatorSecretKey: operatorKeys.secretKey,
      validUntil: blockchain.now! + 300,
    });
    expect(await plugin.getRemainingAllowance()).toBe(toNano('9'));

    const res = await wallet.sendRemovePlugin({
      secretKey: ownerKeys.secretKey,
      seqno: await wallet.getSeqno(),
      plugin: plugin.address,
      value: toNano('0.1'),
      validUntil: blockchain.now! + 300,
    });

    // the wallet forgets the allowance ...
    expect(await wallet.getIsPluginInstalled(plugin.address)).toBe(false);
    expect(await wallet.getPluginList()).toHaveLength(0);

    // ... and the plugin returns everything it held and self-destructs.
    expect(res.transactions).toHaveTransaction({
      from: wallet.address,
      to: plugin.address,
      op: 0x64737472,
      destroyed: true,
      success: true,
    });
    const state = await blockchain.getContract(plugin.address);
    expect(state.accountState?.type).not.toBe('active');
    expect(state.balance).toBe(0n);
  });

  it('a revoked-but-still-alive plugin can no longer pull anything', async () => {
    const plugin = await authorize({});

    // Remove the plugin from the wallet's dictionary WITHOUT notifying it,
    // by installing a second withdrawer and revoking the first via op 3 with
    // zero value so it never runs its destruct handler.
    await wallet.sendTransfer({
      secretKey: ownerKeys.secretKey,
      seqno: await wallet.getSeqno(),
      validUntil: blockchain.now! + 300,
      messages: [{ to: plugin.address, value: toNano('0.2'), bounce: false }],
    });
    await wallet.sendRemovePlugin({
      secretKey: ownerKeys.secretKey,
      seqno: await wallet.getSeqno(),
      plugin: plugin.address,
      value: 0n,
      validUntil: blockchain.now! + 300,
    });
    expect(await wallet.getIsPluginInstalled(plugin.address)).toBe(false);

    const before = await receiver.getBalance();
    const res = await plugin.sendWithdraw({
      seqno: await plugin.getSeqno(),
      amount: toNano('1'),
      receiver: receiver.address,
      operatorSecretKey: operatorKeys.secretKey,
      validUntil: blockchain.now! + 300,
    });

    // the wallet silently ignores a request from an unknown plugin
    expect(res.transactions).not.toHaveTransaction({
      from: wallet.address,
      to: plugin.address,
      op: OP_PAYMENT_RESPONSE,
    });
    expect(await receiver.getBalance()).toBe(before);
  });

  it('reclaims allowance when the wallet silently ignores the plugin', async () => {
    const plugin = await authorize({});

    // Fund the plugin, then de-register it WITHOUT letting it self-destruct, so
    // it stays alive pointing at a wallet that will now ignore it entirely.
    await wallet.sendTransfer({
      secretKey: ownerKeys.secretKey,
      seqno: await wallet.getSeqno(),
      validUntil: blockchain.now! + 300,
      messages: [{ to: plugin.address, value: toNano('0.5'), bounce: false }],
    });
    await wallet.sendRemovePlugin({
      secretKey: ownerKeys.secretKey,
      seqno: await wallet.getSeqno(),
      plugin: plugin.address,
      value: 0n,
      validUntil: blockchain.now! + 300,
    });

    // Three pulls that go nowhere: the wallet neither pays nor bounces.
    const before = await receiver.getBalance();
    for (let i = 0; i < 3; i++) {
      await plugin.sendWithdraw({
        seqno: await plugin.getSeqno(),
        amount: toNano('1'),
        receiver: receiver.address,
        operatorSecretKey: operatorKeys.secretKey,
        validUntil: blockchain.now! + 300,
      });
    }
    expect(await receiver.getBalance()).toBe(before); // nothing was delivered
    expect(await plugin.getRemainingAllowance()).toBe(toNano('7')); // but budget is held

    // Too early to reclaim.
    await expect(plugin.sendReclaim(0)).rejects.toThrow();

    blockchain.now! += RECLAIM_TIMEOUT + 1;

    // Anyone may now clean up each stuck entry; the budget comes back.
    await plugin.sendReclaim(0);
    expect(await plugin.getRemainingAllowance()).toBe(toNano('8'));
    await plugin.sendReclaim(1);
    await plugin.sendReclaim(2);
    expect(await plugin.getRemainingAllowance()).toBe(toNano('10'));

    // Reclaiming the same entry twice does nothing.
    await expect(plugin.sendReclaim(0)).rejects.toThrow();
  });

  it('does not let reclaim touch a payout that actually succeeded', async () => {
    const plugin = await authorize({});
    await plugin.sendWithdraw({
      seqno: 0,
      amount: toNano('2'),
      receiver: receiver.address,
      operatorSecretKey: operatorKeys.secretKey,
      validUntil: blockchain.now! + 300,
    });
    expect(await plugin.getRemainingAllowance()).toBe(toNano('8'));

    blockchain.now! += RECLAIM_TIMEOUT + 1;
    // the entry was cleared on delivery, so there is nothing to reclaim
    await expect(plugin.sendReclaim(0)).rejects.toThrow();
    expect(await plugin.getRemainingAllowance()).toBe(toNano('8'));
  });

  it('lets the owner retune limits and the allowlist through the wallet', async () => {
    const plugin = await authorize({ totalAllowance: toNano('1'), maxPerWithdrawal: toNano('1') });

    await wallet.sendTransfer({
      secretKey: ownerKeys.secretKey,
      seqno: await wallet.getSeqno(),
      validUntil: blockchain.now! + 300,
      messages: [
        {
          to: plugin.address,
          value: toNano('0.05'),
          body: WithdrawerPlugin.buildSetLimitsBody({
            totalAllowance: toNano('20'),
            maxPerWithdrawal: toNano('9'),
            cooldown: 0,
          }),
        },
      ],
    });

    expect(await plugin.getRemainingAllowance()).toBe(toNano('20'));

    await wallet.sendTransfer({
      secretKey: ownerKeys.secretKey,
      seqno: await wallet.getSeqno(),
      validUntil: blockchain.now! + 300,
      messages: [
        {
          to: plugin.address,
          value: toNano('0.05'),
          body: WithdrawerPlugin.buildSetReceiverBody({
            receiver: receiver.address,
            allow: true,
          }),
        },
      ],
    });

    expect(await plugin.getIsReceiverAllowed(receiver.address)).toBe(true);
    expect(await plugin.getIsReceiverAllowed(otherReceiver.address)).toBe(false);
  });

  it('ignores admin ops that do not come from the paired wallet', async () => {
    const plugin = await authorize({ totalAllowance: toNano('1'), maxPerWithdrawal: toNano('1') });

    const res = await deployer.send({
      to: plugin.address,
      value: toNano('0.1'),
      body: WithdrawerPlugin.buildSetLimitsBody({
        totalAllowance: toNano('999'),
        maxPerWithdrawal: toNano('999'),
        cooldown: 0,
      }),
    });

    expect(res.transactions).toHaveTransaction({
      to: plugin.address,
      exitCode: 40,
    });
    expect(await plugin.getRemainingAllowance()).toBe(toNano('1'));
  });

  it('refuses to build a permissionless config with no allowlist', () => {
    expect(() =>
      withdrawerConfigToCell({
        wallet: wallet.address,
        operatorPublicKey: null,
        totalAllowance: toNano('1'),
        maxPerWithdrawal: toNano('1'),
      })
    ).toThrow(/allowlist/i);
  });
});
