// SPDX-License-Identifier: AGPL-3.0-only
/**
 * User templates (CN=UserTemplates,CN=OpenDC,CN=System): default attributes with {firstname}/{lastname}/
 * {sam}/{domain} placeholders, a target OU, groups and account flags, applied by user creation and imports.
 */
import { userTemplateInput } from '@opendc/shared/api';
import { domainFromDn } from '@opendc/shared/ldap';
import { PlatformObjects } from './platform-objects.ts';
import type { DirectoryService } from './service.ts';
import { expand, type TemplateLike } from './import.ts';

export class UserTemplates {
  readonly store: PlatformObjects<typeof userTemplateInput>;
  readonly #dir: () => DirectoryService;

  constructor(dir: () => DirectoryService) {
    this.#dir = dir;
    this.store = new PlatformObjects({
      dir,
      path: ['UserTemplates'],
      kind: 'userTemplate',
      schemaVersion: 1,
      data: userTemplateInput,
      name: (x) => x.name,
    });
  }

  /** The template as creation defaults, with group GUIDs resolved to DNs. */
  async resolve(id: string): Promise<{ t: TemplateLike; parent: string | null }> {
    const s = await this.store.get(id);
    const dir = this.#dir();
    const groups: string[] = [];
    for (const g of s.data.groups) groups.push((await dir.entryByGuid(g, ['objectGUID'])).dn);
    return {
      t: { defaults: s.data.defaults, groups, mustChangePassword: s.data.mustChangePassword, enabled: s.data.enabled },
      parent: s.data.parent,
    };
  }

  /** Template defaults for one new user (placeholders expanded); the caller's own values win. */
  expandFor(
    t: TemplateLike,
    user: { givenName?: string | null | undefined; sn?: string | null | undefined; sam: string },
  ): Record<string, string> {
    const vars = {
      firstname: user.givenName ?? '',
      lastname: user.sn ?? '',
      sam: user.sam,
      domain: domainFromDn(this.#dir().domainDn),
    };
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(t.defaults)) {
      if (v) out[k] = expand(v, vars, k === 'mail' || k === 'userPrincipalName');
    }
    return out;
  }
}
