// SPDX-License-Identifier: AGPL-3.0-only
/** Terminal and file input for `opendc setup`: hidden password prompts, questions, root-only secrets. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { SetupIo } from './setup.ts';

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Reads one line from the TTY without echo (raw mode). */
function hiddenLine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (buf: Buffer): void => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          finish();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    const finish = (): void => {
      stdin.off('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write('\n');
    };
    stdin.on('data', onData);
  });
}

export function terminalIo(secretsDir: string): SetupIo {
  return {
    async readSecret(name) {
      return readFile(join(secretsDir, name)).catch(() => null);
    },
    async readPassword(source, prompt) {
      if (source === '-') return (await readStdin()).split('\n')[0] ?? '';
      if (source) return ((await readFile(source, 'utf8')).split('\n')[0] ?? '').replace(/\r$/, '');
      if (!process.stdin.isTTY) throw new Error('No terminal for a password prompt: use --password-file <file>|-');
      const a = await hiddenLine(prompt);
      const b = await hiddenLine(prompt);
      if (a !== b) throw new Error('The passwords did not match.');
      return a;
    },
    async ask(prompt) {
      if (!process.stdin.isTTY) return null;
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  };
}
