// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Managed file writes shared by all Linux adapters (SECURITY.md §7 "Paths"): the parent's realpath must be
 * inside a managed root, the final component is opened with O_NOFOLLOW, writes are atomic and keep the
 * previous version as `<path>.opendc-prev`.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm, copyFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { PlatformError } from '@opendc/shared';
import type { FileActions, WriteResult } from '../types.ts';

const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
export const PREV_SUFFIX = '.opendc-prev';

function inside(path: string, root: string): boolean {
  const r = root.endsWith(sep) ? root : root + sep;
  return path === root || path.startsWith(r);
}

export class PosixFileActions implements FileActions {
  readonly #roots: readonly string[];

  constructor(managedRoots: readonly string[]) {
    this.#roots = managedRoots.map((r) => resolve(r));
  }

  /** Validates `path` and returns its canonical location (real parent dir + basename). */
  async #check(path: string, createParent: boolean): Promise<string> {
    const abs = resolve(path);
    const root = this.#roots.find((r) => inside(abs, r));
    if (!root || abs === root) throw new PlatformError('os.path-outside-roots', { path, roots: this.#roots.join(', ') });
    const parent = dirname(abs);
    if (createParent) await mkdir(parent, { recursive: true, mode: 0o755 });
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch {
      throw new PlatformError('os.path-outside-roots', { path, roots: this.#roots.join(', ') });
    }
    const realRoots = await Promise.all(this.#roots.map((r) => realpath(r).catch(() => r)));
    if (!realRoots.some((r) => inside(realParent, r))) {
      throw new PlatformError('os.path-outside-roots', { path, roots: this.#roots.join(', ') });
    }
    const target = join(realParent, basename(abs));
    const st = await lstat(target).catch(() => null);
    if (st?.isSymbolicLink()) throw new PlatformError('os.path-outside-roots', { path, roots: this.#roots.join(', ') });
    return target;
  }

  async readManaged(path: string): Promise<{ content: string; sha256: string } | null> {
    const target = await this.#check(path, false).catch((e: unknown) => {
      if (e instanceof PlatformError) throw e;
      return null;
    });
    if (!target) return null;
    let fh;
    try {
      fh = await open(target, constants.O_RDONLY | O_NOFOLLOW);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
    try {
      const buf = await fh.readFile();
      return { content: buf.toString('utf8'), sha256: sha256(buf) };
    } finally {
      await fh.close();
    }
  }

  async writeManaged(path: string, content: string, owner: { uid: number; gid: number } | null, mode: number): Promise<WriteResult> {
    const target = await this.#check(path, true);
    const next = sha256(content);
    const prev = await this.readManaged(target);
    if (prev && prev.sha256 === next) {
      await this.#applyMeta(target, owner, mode);
      return { changed: false, sha256: next, previousSha256: prev.sha256 };
    }
    const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      await fh.writeFile(content, 'utf8');
      if (owner && process.getuid) await fh.chown(owner.uid, owner.gid);
      await fh.chmod(mode);
      await fh.sync();
    } catch (e) {
      await fh.close();
      await rm(tmp, { force: true });
      throw e;
    }
    await fh.close();
    if (prev) await copyFile(target, target + PREV_SUFFIX);
    await rename(tmp, target);
    await this.#syncDir(dirname(target));
    return { changed: true, sha256: next, previousSha256: prev?.sha256 ?? null };
  }

  async restorePrevious(path: string): Promise<{ restored: boolean; sha256: string | null }> {
    const target = await this.#check(path, false);
    const backup = target + PREV_SUFFIX;
    const st = await lstat(backup).catch(() => null);
    if (!st || !st.isFile()) return { restored: false, sha256: (await this.readManaged(target))?.sha256 ?? null };
    await rename(backup, target);
    await this.#syncDir(dirname(target));
    return { restored: true, sha256: sha256(await readFile(target)) };
  }

  async #applyMeta(target: string, owner: { uid: number; gid: number } | null, mode: number): Promise<void> {
    const fh = await open(target, constants.O_RDONLY | O_NOFOLLOW);
    try {
      if (owner && process.getuid) await fh.chown(owner.uid, owner.gid);
      await fh.chmod(mode);
    } finally {
      await fh.close();
    }
  }

  async #syncDir(dir: string): Promise<void> {
    if (process.platform === 'win32') return;
    const fh = await open(dir, constants.O_RDONLY);
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
}
