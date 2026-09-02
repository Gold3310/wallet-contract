import {
  Address,
  beginCell,
  Cell,
  Contract,
  contractAddress,
  ContractProvider,
  Dictionary,
  Sender,
  SendMode,
  StateInit,
  storeStateInit,
} from '@ton/core';
import { sign } from '@ton/crypto';

import { WalletContractV4 } from '@ton/ton';

/**
 * Canonical wallet-v4 r2 code as deployed on mainnet, taken from @ton/ton so it
 * is always byte-identical to what real wallets run. Use this for testnet/mainnet.
 * For sandbox tests we instead compile `func/wallet-v4-code.fc` from this repo.
 */
export const WALLET_V4R2_CODE: Cell = WalletContractV4.create({
  workchain: 0,
  publicKey: Buffer.alloc(32),
}).init.code;

export type WalletV4Config = {
  publicKey: Buffer;
  subwalletId?: number;
  seqno?: number;
};

export function walletV4ConfigToCell(cfg: WalletV4Config): Cell {
  return beginCell()
    .storeUint(cfg.seqno ?? 0, 32)
    .storeUint(cfg.subwalletId ?? 698983191, 32)
    .storeBuffer(cfg.publicKey, 32)
    .storeDict(null)
    .endCell();
}

/** Encodes an address the way wallet-v4 keys its plugin dictionary: wc:int8 ++ hash:uint256. */
export function addrToWcHash(addr: Address): Cell {
  return beginCell().storeInt(addr.workChain, 8).storeBuffer(addr.hash, 32).endCell();
}

export class WalletV4 implements Contract {
  constructor(
    readonly address: Address,
    readonly init: { code: Cell; data: Cell },
    readonly subwalletId: number = 698983191
  ) {}

  static createFromConfig(cfg: WalletV4Config, code: Cell = WALLET_V4R2_CODE, workchain = 0) {
    const data = walletV4ConfigToCell(cfg);
    const init = { code, data };
    return new WalletV4(contractAddress(workchain, init), init, cfg.subwalletId ?? 698983191);
  }

  /** Signs and sends an external message carrying `body` (already includes the op byte). */
  private async sendExternal(
    provider: ContractProvider,
    secretKey: Buffer,
    body: Cell,
    opts: { seqno: number; validUntil?: number }
  ) {
    const toSign = beginCell()
      .storeUint(this.subwalletId, 32)
      .storeUint(opts.validUntil ?? Math.floor(Date.now() / 1000) + 300, 32)
      .storeUint(opts.seqno, 32)
      .storeBuilder(body.asBuilder())
      .endCell();

    const signature = sign(toSign.hash(), secretKey);

    await provider.external(
      beginCell().storeBuffer(signature).storeBuilder(toSign.asBuilder()).endCell()
    );
  }

  /** op 0 — ordinary transfer, exactly like wallet v1/v2/v3. */
  async sendTransfer(
    provider: ContractProvider,
    args: {
      secretKey: Buffer;
      seqno: number;
      messages: { to: Address; value: bigint; body?: Cell; bounce?: boolean }[];
      sendMode?: SendMode;
      validUntil?: number;
    }
  ) {
    let body = beginCell().storeUint(0, 8);
    for (const m of args.messages) {
      const msg = beginCell()
        .storeUint(m.bounce === false ? 0x10 : 0x18, 6)
        .storeAddress(m.to)
        .storeCoins(m.value)
        .storeUint(0, 1 + 4 + 4 + 64 + 32 + 1 + 1);
      if (m.body) msg.storeBuilder(m.body.asBuilder());
      body = body
        .storeUint(args.sendMode ?? SendMode.PAY_GAS_SEPARATELY, 8)
        .storeRef(msg.endCell());
    }
    await this.sendExternal(provider, args.secretKey, body.endCell(), args);
  }

  /**
   * op 1 — deploy a plugin AND register it in one signed message.
   * This is the single moment the owner key is used to grant the allowance.
   */
  async sendDeployAndInstallPlugin(
    provider: ContractProvider,
    args: {
      secretKey: Buffer;
      seqno: number;
      workchain?: number;
      value: bigint;
      stateInit: StateInit;
      body?: Cell;
      validUntil?: number;
    }
  ) {
    const stateInitCell = beginCell().store(storeStateInit(args.stateInit)).endCell();
    const body = beginCell()
      .storeUint(1, 8)
      .storeInt(args.workchain ?? 0, 8)
      .storeCoins(args.value)
      .storeRef(stateInitCell)
      .storeRef(args.body ?? beginCell().endCell())
      .endCell();
    await this.sendExternal(provider, args.secretKey, body, args);
  }

  /** op 2 — register an already-deployed contract as a plugin. */
  async sendInstallPlugin(
    provider: ContractProvider,
    args: {
      secretKey: Buffer;
      seqno: number;
      plugin: Address;
      value: bigint;
      queryId?: bigint;
      validUntil?: number;
    }
  ) {
    const body = beginCell()
      .storeUint(2, 8)
      .storeSlice(addrToWcHash(args.plugin).beginParse())
      .storeCoins(args.value)
      .storeUint(args.queryId ?? 0n, 64)
      .endCell();
    await this.sendExternal(provider, args.secretKey, body, args);
  }

  /** op 3 — revoke the allowance. After this the plugin can never pull again. */
  async sendRemovePlugin(
    provider: ContractProvider,
    args: {
      secretKey: Buffer;
      seqno: number;
      plugin: Address;
      value: bigint;
      queryId?: bigint;
      validUntil?: number;
    }
  ) {
    const body = beginCell()
      .storeUint(3, 8)
      .storeSlice(addrToWcHash(args.plugin).beginParse())
      .storeCoins(args.value)
      .storeUint(args.queryId ?? 0n, 64)
      .endCell();
    await this.sendExternal(provider, args.secretKey, body, args);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, bounce: false, body: beginCell().endCell() });
  }

  async getSeqno(provider: ContractProvider): Promise<number> {
    const state = await provider.getState();
    if (state.state.type !== 'active') return 0;
    return (await provider.get('seqno', [])).stack.readNumber();
  }

  async getIsPluginInstalled(provider: ContractProvider, plugin: Address): Promise<boolean> {
    const res = await provider.get('is_plugin_installed', [
      { type: 'int', value: BigInt(plugin.workChain) },
      { type: 'int', value: BigInt('0x' + plugin.hash.toString('hex')) },
    ]);
    return res.stack.readBoolean();
  }

  async getPluginList(provider: ContractProvider): Promise<Address[]> {
    const res = await provider.get('get_plugin_list', []);
    const out: Address[] = [];
    let list = res.stack.readTupleOpt();
    while (list !== null && list.remaining > 0) {
      const pair = list.readTuple();
      const wc = pair.readNumber();
      const hash = pair.readBigNumber();
      out.push(
        Address.parse(`${wc}:${hash.toString(16).padStart(64, '0')}`)
      );
      list = list.remaining > 0 ? list.readTupleOpt() : null;
    }
    return out;
  }
}

export { Dictionary };
