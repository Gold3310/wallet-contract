import {
  Address,
  beginCell,
  Cell,
  Contract,
  contractAddress,
  ContractProvider,
  Dictionary,
  Sender,
  toNano,
} from '@ton/core';
import { sign } from '@ton/crypto';

export const OP = {
  PAYMENT_REQUEST: 0x706c7567, // "plug"
  DESTRUCT: 0x64737472, // "dstr"
  NOTE: 0x6e6f7465, // "note"
  WITHDRAWAL: 0x77746864, // "wthd"
  TOPUP: 0x746f7075, // "topu"
  SET_LIMITS: 0x6c696d74, // "limt"
  SET_RECEIVER: 0x72637672, // "rcvr"
  SET_OPERATOR: 0x6f707261, // "opra"
} as const;

/** Exit codes thrown by the plugin, mapped to something a human can act on. */
/** Discriminator on external messages sent to the plugin. */
export const EXT_OP = { WITHDRAW: 0, RECLAIM: 1 } as const;

/** Seconds a pending payout must be stuck before anyone may reclaim it. */
export const RECLAIM_TIMEOUT = 3600;

export const PLUGIN_ERRORS: Record<number, string> = {
  30: 'Bad operator signature',
  33: 'Wrong seqno (replay or stale nonce)',
  34: 'Request expired (valid_until in the past)',
  35: 'Amount exceeds max_per_withdrawal',
  36: 'Amount exceeds the remaining allowance',
  37: 'Cooldown has not elapsed yet',
  38: 'Receiver is not on the allowlist',
  39: 'Amount must be greater than zero',
  40: 'Sender is not the paired wallet',
  41: 'Permissionless mode requires a non-empty receiver allowlist',
  42: 'No pending payout with that query id',
  43: 'Pending payout is not stale enough to reclaim yet',
  44: 'Unknown external op',
  71: 'Could not read gas/forward prices from network config',
};

export type WithdrawerConfig = {
  /** The wallet funds are pulled FROM. This is the "withdrawer". */
  wallet: Address;
  /**
   * Public key allowed to authorise pulls. Pass `null` for permissionless mode,
   * in which case `receivers` must be non-empty.
   */
  operatorPublicKey?: Buffer | null;
  seqno?: number;
  /** Lifetime budget. Every pull decrements this. */
  totalAllowance: bigint;
  /** Ceiling for a single pull. */
  maxPerWithdrawal: bigint;
  /** Minimum seconds between pulls. */
  cooldown?: number;
  lastWithdrawal?: number;
  /** Salt, so the same owner can have several independent withdrawers. */
  pluginId?: number;
  /** Addresses funds may be sent to. Empty + an operator key = any receiver. */
  receivers?: Address[];
};

function addrKeyHash(addr: Address): bigint {
  const key = beginCell().storeInt(addr.workChain, 8).storeBuffer(addr.hash, 32).endCell();
  return BigInt('0x' + key.hash().toString('hex'));
}

export function buildReceiverDict(receivers: Address[] | undefined): Cell | null {
  if (!receivers || receivers.length === 0) return null;
  const d = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  for (const r of receivers) d.set(addrKeyHash(r), beginCell().endCell());
  return beginCell().storeDictDirect(d).endCell();
}

export function withdrawerConfigToCell(cfg: WithdrawerConfig): Cell {
  const receivers = buildReceiverDict(cfg.receivers);
  const operatorKey = cfg.operatorPublicKey
    ? BigInt('0x' + cfg.operatorPublicKey.toString('hex'))
    : 0n;

  if (operatorKey === 0n && receivers === null) {
    throw new Error(
      'Refusing to build a permissionless withdrawer with no receiver allowlist: ' +
        'anyone could then send funds anywhere. Supply `receivers` or an `operatorPublicKey`.'
    );
  }

  return beginCell()
    .storeAddress(cfg.wallet)
    .storeUint(operatorKey, 256)
    .storeUint(cfg.seqno ?? 0, 32)
    .storeCoins(cfg.totalAllowance)
    .storeCoins(cfg.maxPerWithdrawal)
    .storeUint(cfg.cooldown ?? 0, 32)
    .storeUint(cfg.lastWithdrawal ?? 0, 32)
    .storeUint(cfg.pluginId ?? 0, 32)
    .storeMaybeRef(receivers)
    .storeMaybeRef(null) // pending
    .endCell();
}

export class WithdrawerPlugin implements Contract {
  constructor(
    readonly address: Address,
    readonly init: { code: Cell; data: Cell }
  ) {}

  static createFromConfig(cfg: WithdrawerConfig, code: Cell, workchain = 0) {
    const data = withdrawerConfigToCell(cfg);
    const init = { code, data };
    return new WithdrawerPlugin(contractAddress(workchain, init), init);
  }

  static createFromAddress(address: Address) {
    return new WithdrawerPlugin(address, { code: Cell.EMPTY, data: Cell.EMPTY });
  }

  /**
   * THE CORE CALL. Paste withdrawer (set at deploy), amount and receiver.
   * No owner key is involved. `operatorSecretKey` is only needed when the
   * plugin was deployed in operator mode, and it is not the wallet's key.
   */
  static buildWithdrawBody(args: {
    seqno: number;
    amount: bigint;
    receiver: Address;
    validUntil?: number;
    operatorSecretKey?: Buffer | null;
  }): Cell {
    const payload = beginCell()
      .storeUint(args.validUntil ?? Math.floor(Date.now() / 1000) + 300, 32)
      .storeUint(args.seqno, 32)
      .storeCoins(args.amount)
      .storeAddress(args.receiver)
      .endCell();

    if (!args.operatorSecretKey) {
      return beginCell().storeUint(EXT_OP.WITHDRAW, 8).storeBuilder(payload.asBuilder()).endCell();
    }

    return beginCell()
      .storeUint(EXT_OP.WITHDRAW, 8)
      .storeBuffer(sign(payload.hash(), args.operatorSecretKey))
      .storeBuilder(payload.asBuilder())
      .endCell();
  }

  /**
   * Restores allowance for a payout that never landed -- which happens when the
   * wallet silently ignores the plugin (typically after a revoke). Permissionless
   * and only valid once the entry is older than the on-chain reclaim timeout.
   */
  static buildReclaimBody(queryId: number | bigint): Cell {
    return beginCell().storeUint(EXT_OP.RECLAIM, 8).storeUint(queryId, 64).endCell();
  }

  async sendReclaim(provider: ContractProvider, queryId: number | bigint) {
    await provider.external(WithdrawerPlugin.buildReclaimBody(queryId));
  }

  async sendWithdraw(
    provider: ContractProvider,
    args: {
      seqno: number;
      amount: bigint;
      receiver: Address;
      validUntil?: number;
      operatorSecretKey?: Buffer | null;
    }
  ) {
    await provider.external(WithdrawerPlugin.buildWithdrawBody(args));
  }

  async sendTopUp(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, {
      value,
      bounce: false,
      body: beginCell().storeUint(OP.TOPUP, 32).endCell(),
    });
  }

  // ----- owner administration (must be relayed through the wallet) -----

  static buildSetLimitsBody(a: {
    totalAllowance: bigint;
    maxPerWithdrawal: bigint;
    cooldown: number;
    queryId?: bigint;
  }): Cell {
    return beginCell()
      .storeUint(OP.SET_LIMITS, 32)
      .storeUint(a.queryId ?? 0n, 64)
      .storeCoins(a.totalAllowance)
      .storeCoins(a.maxPerWithdrawal)
      .storeUint(a.cooldown, 32)
      .endCell();
  }

  static buildSetReceiverBody(a: {
    receiver: Address;
    allow: boolean;
    queryId?: bigint;
  }): Cell {
    return beginCell()
      .storeUint(OP.SET_RECEIVER, 32)
      .storeUint(a.queryId ?? 0n, 64)
      .storeAddress(a.receiver)
      .storeUint(a.allow ? 1 : 0, 1)
      .endCell();
  }

  static buildSetOperatorBody(a: { publicKey: Buffer | null; queryId?: bigint }): Cell {
    return beginCell()
      .storeUint(OP.SET_OPERATOR, 32)
      .storeUint(a.queryId ?? 0n, 64)
      .storeUint(a.publicKey ? BigInt('0x' + a.publicKey.toString('hex')) : 0n, 256)
      .endCell();
  }

  static buildDestructBody(queryId: bigint = 0n): Cell {
    return beginCell().storeUint(OP.DESTRUCT, 32).storeUint(queryId, 64).endCell();
  }

  // ----- getters -----

  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_withdrawer_data', [])).stack;
    return {
      operatorKey: s.readBigNumber(),
      seqno: s.readNumber(),
      totalAllowance: s.readBigNumber(),
      maxPerWithdrawal: s.readBigNumber(),
      cooldown: s.readNumber(),
      lastWithdrawal: s.readNumber(),
      pluginId: s.readNumber(),
    };
  }

  async getSeqno(provider: ContractProvider): Promise<number> {
    return (await provider.get('get_seqno', [])).stack.readNumber();
  }

  async getRemainingAllowance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_remaining_allowance', [])).stack.readBigNumber();
  }

  async getWallet(provider: ContractProvider): Promise<Address> {
    return (await provider.get('get_wallet', [])).stack.readAddress();
  }

  async getIsReceiverAllowed(provider: ContractProvider, receiver: Address): Promise<boolean> {
    const res = await provider.get('is_receiver_allowed', [
      { type: 'int', value: BigInt(receiver.workChain) },
      { type: 'int', value: BigInt('0x' + receiver.hash.toString('hex')) },
    ]);
    return res.stack.readBoolean();
  }
}

/** Recommended minimum balance to keep on the plugin so it can pay its own fees. */
export const PLUGIN_MIN_BALANCE = toNano('0.1');
