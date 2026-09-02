import { Address, Cell, beginCell, storeMessage } from '@ton/core';
import { TonClient } from '@ton/ton';
import * as fs from 'fs';
import * as path from 'path';

export const ROOT = path.resolve(__dirname, '..', '..');
export const STORE_PATH = path.join(ROOT, '.withdrawers.json');

export type Network = 'testnet' | 'mainnet';

/** A saved authorization. This is the ONLY thing a withdrawal needs afterwards. */
export type WithdrawerRecord = {
  network: Network;
  /** The wallet funds are pulled from -- what you paste as `--withdrawer`. */
  wallet: string;
  plugin: string;
  /** Hex operator public key, or null for permissionless mode. */
  operatorPublicKey: string | null;
  /**
   * Hex operator SECRET key. A hot key that can only pull within the on-chain
   * limits -- it is NOT the wallet owner key and cannot move anything else.
   * Null in permissionless mode.
   */
  operatorSecretKey: string | null;
  totalAllowance: string;
  maxPerWithdrawal: string;
  cooldown: number;
  receivers: string[];
  createdAt: string;
};

export function loadStore(): WithdrawerRecord[] {
  if (!fs.existsSync(STORE_PATH)) return [];
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}

export function saveRecord(rec: WithdrawerRecord) {
  const all = loadStore().filter(
    (r) => !(r.wallet === rec.wallet && r.network === rec.network)
  );
  all.push(rec);
  fs.writeFileSync(STORE_PATH, JSON.stringify(all, null, 2));
  fs.chmodSync(STORE_PATH, 0o600);
}

export function findRecord(wallet: string, network: Network): WithdrawerRecord | undefined {
  const want = Address.parse(wallet).toRawString();
  return loadStore().find(
    (r) => r.network === network && Address.parse(r.wallet).toRawString() === want
  );
}

export function endpoint(network: Network): string {
  const custom = process.env.TON_ENDPOINT;
  if (custom) return custom;
  return network === 'mainnet'
    ? 'https://toncenter.com/api/v2/jsonRPC'
    : 'https://testnet.toncenter.com/api/v2/jsonRPC';
}

export function makeClient(network: Network): TonClient {
  return new TonClient({
    endpoint: endpoint(network),
    apiKey: process.env.TONCENTER_API_KEY,
  });
}

/** Wraps a body into an external-in message addressed to `dest` and broadcasts it. */
export async function sendExternal(client: TonClient, dest: Address, body: Cell) {
  const msg = beginCell()
    .store(
      storeMessage({
        info: { type: 'external-in', src: undefined, dest, importFee: 0n },
        body,
      })
    )
    .endCell();
  await client.sendFile(msg.toBoc());
}

/** Minimal `--flag value` parser. */
export function args(argv: string[] = process.argv.slice(2)): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = 'true';
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export function requireArg(a: Record<string, string>, name: string, hint: string): string {
  if (!a[name]) {
    console.error(`\nMissing --${name}\n  ${hint}\n`);
    process.exit(1);
  }
  return a[name];
}

export function parseNetwork(a: Record<string, string>): Network {
  const n = (a.network ?? process.env.TON_NETWORK ?? 'testnet').toLowerCase();
  if (n !== 'testnet' && n !== 'mainnet') {
    console.error(`Unknown network "${n}". Use testnet or mainnet.`);
    process.exit(1);
  }
  if (n === 'mainnet' && a.yes !== 'true') {
    console.error(
      '\nRefusing to touch mainnet without --yes.\n' +
        'Real funds are at stake. Rehearse on testnet first.\n'
    );
    process.exit(1);
  }
  return n;
}

export function explorer(network: Network, addr: Address): string {
  const base = network === 'mainnet' ? 'https://tonviewer.com' : 'https://testnet.tonviewer.com';
  return `${base}/${addr.toString({ testOnly: network === 'testnet' })}`;
}
