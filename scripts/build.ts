import { compileFunc } from '@ton-community/func-js';
import { Cell } from '@ton/core';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

const cache = new Map<string, Cell>();

async function compile(targets: string[]): Promise<Cell> {
  const key = targets.join('|');
  const hit = cache.get(key);
  if (hit) return hit;

  const result = await compileFunc({
    targets,
    sources: (filename: string) =>
      fs
        .readFileSync(path.join(ROOT, filename))
        .toString()
        // the checked-in sources pin FunC 0.2.0; we build them with a modern compiler
        .replace(/#pragma version\s*=?[^;]*;/g, ''),
  });
  if (result.status === 'error') throw new Error(result.message);

  const code = Cell.fromBoc(Buffer.from(result.codeBoc, 'base64'))[0];
  cache.set(key, code);
  return code;
}

export async function compileWithdrawer(): Promise<Cell> {
  return compile(['func/stdlib.fc', 'contracts/withdrawer-plugin.fc']);
}

/** This repository's own wallet-v4 source, used by the sandbox tests. */
export async function compileWalletV4(): Promise<Cell> {
  return compile(['func/stdlib.fc', 'func/wallet-v4-code.fc']);
}

if (require.main === module) {
  Promise.all([compileWithdrawer(), compileWalletV4()])
    .then(([code, walletCode]) => {
      fs.mkdirSync(path.join(ROOT, 'build'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'build/withdrawer-plugin.boc'), code.toBoc());
      fs.writeFileSync(
        path.join(ROOT, 'build/withdrawer-plugin.compiled.json'),
        JSON.stringify({ hex: code.toBoc().toString('hex') }, null, 2)
      );
      fs.writeFileSync(path.join(ROOT, 'build/wallet-v4-code.boc'), walletCode.toBoc());
      console.log('withdrawer-plugin  code hash =', code.hash().toString('hex'));
      console.log('wallet-v4 (repo)   code hash =', walletCode.hash().toString('hex'));
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
