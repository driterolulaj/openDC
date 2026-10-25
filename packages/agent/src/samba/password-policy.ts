// SPDX-License-Identifier: AGPL-3.0-only
/**
 * samba.passwordPolicy.show / .set: the domain default password policy (attributes on the domain head) and
 * PSOs (CN=Password Settings Container). Neither is readable or writable by the delegated API account, so
 * they are read from the local sam.ldb and written with `samba-tool domain passwordsettings` (tier 0).
 */
import { PlatformError } from '@opendc/shared';
import type { OpParsedArgs, OpResult } from '@opendc/shared/agent';
import type { PasswordSettings } from '@opendc/shared/domain';
import { childDn, eq, guidBase } from '@opendc/shared/ldap';
import { first, type LdifEntry } from './ldif.ts';
import type { SambaLocal } from './local.ts';

const DAY = 864_000_000_000n; // 100 ns intervals
const MINUTE = 600_000_000n;
const NEVER = -9223372036854775808n;

/** AD intervals are negative 100-ns counts; "never" is the most negative value (or 0 for some). */
export function intervalTo(v: string | null, unit: bigint): number {
  if (!v || !/^-?\d+$/.test(v)) return 0;
  const n = BigInt(v);
  if (n === NEVER || n === 0n) return 0;
  const abs = n < 0n ? -n : n;
  return Number((abs + unit / 2n) / unit);
}

const num = (v: string | null): number => (v && /^-?\d+$/.test(v) ? Number(v) : 0);

export function defaultFrom(e: LdifEntry | null): PasswordSettings {
  return {
    complexity: (num(first(e, 'pwdProperties')) & 1) === 1,
    minLength: num(first(e, 'minPwdLength')),
    historyLength: num(first(e, 'pwdHistoryLength')),
    minAgeDays: intervalTo(first(e, 'minPwdAge'), DAY),
    maxAgeDays: intervalTo(first(e, 'maxPwdAge'), DAY),
    lockoutThreshold: num(first(e, 'lockoutThreshold')),
    lockoutDurationMinutes: intervalTo(first(e, 'lockoutDuration'), MINUTE),
    lockoutWindowMinutes: intervalTo(first(e, 'lockOutObservationWindow'), MINUTE),
  };
}

export function psoSettingsFrom(e: LdifEntry): PasswordSettings {
  return {
    complexity: (first(e, 'msDS-PasswordComplexityEnabled') ?? '').toUpperCase() === 'TRUE',
    minLength: num(first(e, 'msDS-MinimumPasswordLength')),
    historyLength: num(first(e, 'msDS-PasswordHistoryLength')),
    minAgeDays: intervalTo(first(e, 'msDS-MinimumPasswordAge'), DAY),
    maxAgeDays: intervalTo(first(e, 'msDS-MaximumPasswordAge'), DAY),
    lockoutThreshold: num(first(e, 'msDS-LockoutThreshold')),
    lockoutDurationMinutes: intervalTo(first(e, 'msDS-LockoutDuration'), MINUTE),
    lockoutWindowMinutes: intervalTo(first(e, 'msDS-LockoutObservationWindow'), MINUTE),
  };
}

/** samba-tool options for a settings object (same names for the default policy and PSOs). */
export function settingsArgs(s: PasswordSettings): string[] {
  return [
    `--complexity=${s.complexity ? 'on' : 'off'}`,
    '--store-plaintext=off',
    `--history-length=${String(s.historyLength)}`,
    `--min-pwd-length=${String(s.minLength)}`,
    `--min-pwd-age=${String(s.minAgeDays)}`,
    `--max-pwd-age=${String(s.maxAgeDays)}`,
    `--account-lockout-duration=${String(s.lockoutDurationMinutes)}`,
    `--account-lockout-threshold=${String(s.lockoutThreshold)}`,
    `--reset-account-lockout-after=${String(s.lockoutWindowMinutes)}`,
  ];
}

const PSO_ATTRS = [
  'name',
  'objectGUID',
  'msDS-PasswordSettingsPrecedence',
  'msDS-PasswordComplexityEnabled',
  'msDS-MinimumPasswordLength',
  'msDS-PasswordHistoryLength',
  'msDS-MinimumPasswordAge',
  'msDS-MaximumPasswordAge',
  'msDS-LockoutThreshold',
  'msDS-LockoutDuration',
  'msDS-LockoutObservationWindow',
  'msDS-PSOAppliesTo',
];

export async function showPolicies(samba: SambaLocal): Promise<OpResult<'samba.passwordPolicy.show'>> {
  const domainDn = await samba.domainDn();
  const head = await samba.get(domainDn, [
    'pwdProperties',
    'minPwdLength',
    'pwdHistoryLength',
    'minPwdAge',
    'maxPwdAge',
    'lockoutThreshold',
    'lockoutDuration',
    'lockOutObservationWindow',
  ]);
  const container = childDn(childDn(domainDn, 'CN', 'System'), 'CN', 'Password Settings Container');
  const entries = await samba
    .search(container, 'one', eq('objectClass', 'msDS-PasswordSettings'), PSO_ATTRS)
    .catch(() => []);
  const psos = [];
  for (const e of entries) {
    const appliesTo = [];
    for (const dn of e.attrs.get('msds-psoappliesto') ?? []) {
      const t = await samba.get(dn, ['objectGUID', 'name']);
      appliesTo.push({ guid: first(t, 'objectGUID') ?? '', dn, name: first(t, 'name') ?? dn });
    }
    psos.push({
      name: first(e, 'name') ?? '',
      guid: first(e, 'objectGUID') ?? '',
      precedence: num(first(e, 'msDS-PasswordSettingsPrecedence')),
      settings: psoSettingsFrom(e),
      appliesTo,
    });
  }
  psos.sort((a, b) => a.precedence - b.precedence);
  return { default: defaultFrom(head), psos };
}

export async function setPolicy(
  samba: SambaLocal,
  args: OpParsedArgs<'samba.passwordPolicy.set'>,
): Promise<OpResult<'samba.passwordPolicy.set'>> {
  const H = ['-H', samba.samDb];
  if (args.kind === 'default') {
    await samba.tool(['domain', 'passwordsettings', 'set', ...settingsArgs(args.settings), ...H]);
    return showPolicies(samba);
  }
  const current = (await showPolicies(samba)).psos.find((p) => p.name.toLowerCase() === args.name.toLowerCase());
  if (args.kind === 'psoDelete') {
    if (!current) throw new PlatformError('request.not-found', { what: `Password policy ${args.name}` });
    await samba.tool(['domain', 'passwordsettings', 'pso', 'delete', current.name, ...H]);
    return showPolicies(samba);
  }
  if (current) {
    await samba.tool([
      'domain',
      'passwordsettings',
      'pso',
      'set',
      current.name,
      `--precedence=${String(args.precedence)}`,
      ...settingsArgs(args.settings),
      ...H,
    ]);
  } else {
    await samba.tool([
      'domain',
      'passwordsettings',
      'pso',
      'create',
      args.name,
      String(args.precedence),
      ...settingsArgs(args.settings),
      ...H,
    ]);
  }
  // applies-to: users and groups by account name (samba-tool takes names), replacing the current list
  const wanted = new Map<string, string>(); // guid -> sAMAccountName
  for (const g of args.appliesTo) {
    const t = await samba.get(guidBase(g), ['sAMAccountName', 'objectClass']);
    const sam = first(t, 'sAMAccountName');
    if (!sam) throw new PlatformError('validation.invalid', { issues: `appliesTo: ${g} is not a user or group` });
    wanted.set(g.toLowerCase(), sam);
  }
  const have = new Map((current?.appliesTo ?? []).map((a) => [a.guid.toLowerCase(), a.dn]));
  for (const [g, sam] of wanted)
    if (!have.has(g)) await samba.tool(['domain', 'passwordsettings', 'pso', 'apply', args.name, sam, ...H]);
  for (const [g] of have) {
    if (wanted.has(g)) continue;
    const t = await samba.get(guidBase(g), ['sAMAccountName']);
    const sam = first(t, 'sAMAccountName');
    if (sam) await samba.tool(['domain', 'passwordsettings', 'pso', 'unapply', args.name, sam, ...H]);
  }
  return showPolicies(samba);
}
