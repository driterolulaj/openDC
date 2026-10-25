// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Local Samba access for agent operations (ADR-0006 §4: no generic samba-tool; every invocation is built
 * here from validated values). The local sam.ldb is opened directly with the ldb tools, which on a DC is
 * the database itself (root = system session). Secrets travel on stdin (LDIF) or in the environment
 * (PASSWD for -U), never in argv.
 */
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { LdapFilter } from '@opendc/shared/ldap';
import type { ExecOptions, OsActions } from '@opendc/os';
import { first, parseLdif, type LdifEntry } from './ldif.ts';

export type Scope = 'base' | 'one' | 'sub';

export class SambaLocal {
  readonly #os: OsActions;

  constructor(os: OsActions) {
    this.#os = os;
  }

  get paths(): ReturnType<OsActions['facts']['samba']['paths']> {
    return this.#os.facts.samba.paths();
  }

  get samDb(): string {
    return `${this.paths.privateDir}/sam.ldb`;
  }

  async provisioned(): Promise<boolean> {
    return access(this.samDb, constants.F_OK).then(
      () => true,
      () => false,
    );
  }

  async #run(
    bin: 'samba-tool' | 'ldbsearch' | 'ldbadd' | 'ldbmodify',
    argv: string[],
    opts: ExecOptions = {},
  ): Promise<string> {
    const path = await this.#os.facts.binaries.resolve(bin);
    const r = await this.#os.exec(path, argv, { timeoutMs: 120_000, ...opts });
    return r.stdout;
  }

  /** samba-tool with an argv the caller built from validated values. */
  tool(argv: string[], opts: ExecOptions = {}): Promise<string> {
    return this.#run('samba-tool', argv, opts);
  }

  async search(
    base: string,
    scope: Scope,
    filter: LdapFilter | null,
    attrs: string[],
    url = this.samDb,
  ): Promise<LdifEntry[]> {
    const argv = ['-H', url, '-s', scope, '-b', base, '--show-binary'];
    if (filter) argv.push(filter.text);
    argv.push(...attrs);
    const out = await this.#run('ldbsearch', argv, { okExitCodes: [0] });
    return parseLdif(out);
  }

  /** Base-scope read; null when the object doesn't exist. */
  async get(dn: string, attrs: string[]): Promise<LdifEntry | null> {
    try {
      return (await this.search(dn, 'base', null, attrs))[0] ?? null;
    } catch (e) {
      // ldbsearch exits non-zero with "No such object" for a missing base
      if (/no such object|32/i.test((e as Error).message)) return null;
      throw e;
    }
  }

  async exists(dn: string): Promise<boolean> {
    return (await this.get(dn, ['objectClass'])) !== null;
  }

  async add(ldif: string): Promise<void> {
    await this.#run('ldbadd', ['-H', this.samDb], { stdin: ldif });
  }

  async modify(ldif: string): Promise<void> {
    await this.#run('ldbmodify', ['-H', this.samDb], { stdin: ldif });
  }

  async rootDse(url = this.samDb): Promise<LdifEntry | undefined> {
    return (
      await this.search(
        '',
        'base',
        null,
        [
          'defaultNamingContext',
          'configurationNamingContext',
          'dnsHostName',
          'domainFunctionality',
          'forestFunctionality',
          'domainControllerFunctionality',
          'serverName',
        ],
        url,
      )
    )[0];
  }

  async domainDn(): Promise<string> {
    const dn = first(await this.rootDse(), 'defaultNamingContext');
    if (!dn) throw new Error('rootDSE has no defaultNamingContext');
    return dn;
  }
}
