// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Effective policy resolution (directory-object-model.md §3.1). Pure; the console's effective-policy viewer,
 * the registry handler and the password policy reconciler all call it, so they can't disagree.
 *
 * GPO semantics: walk from the object's container up to the domain head and collect the enabled links.
 * - A closer link beats a more distant one,
 * - except that an enforced link beats everything below it; among enforced links the higher one wins.
 * - Within one level, the lower `priority` wins (then the policy name, for a stable order).
 * Settings merge per key (each key from the winning policy that sets it); policy types whose settings only make
 * sense together (password policies become one PSO) use the winner as a whole.
 */

export interface PolicyLink {
  /** objectGUID of an OU, a container or the domain head */
  targetGuid: string;
  enforced: boolean;
  enabled: boolean;
}

export interface PolicyFilter {
  /** applies only to members (transitive) of one of these groups */
  groupGuids?: string[] | undefined;
  /** applies only to nodes with one of these roles */
  nodeRoles?: string[] | undefined;
}

export interface ResolvablePolicy {
  id: string;
  name: string;
  type: string;
  priority: number;
  links: PolicyLink[];
  filter?: PolicyFilter;
  settings: Record<string, unknown>;
}

/** A container on the path from the object to the domain head (nearest first, domain head last). */
export interface ChainLevel {
  guid: string;
  dn: string;
}

export interface Subject {
  /** the object's containers, nearest first, ending with the domain head */
  chain: ChainLevel[];
  /** objectGUIDs of the groups the object is a (transitive) member of */
  groupGuids?: string[];
  /** for nodes */
  nodeRole?: string;
}

export interface AppliedPolicy<P extends ResolvablePolicy = ResolvablePolicy> {
  policy: P;
  /** where the winning link sits */
  level: ChainLevel;
  /** 0 = the object's own container */
  depth: number;
  enforced: boolean;
}

export interface EffectiveSetting<P extends ResolvablePolicy = ResolvablePolicy> {
  value: unknown;
  source: AppliedPolicy<P>;
}

const lower = (s: string): string => s.toLowerCase();

function applies(p: ResolvablePolicy, s: Subject): boolean {
  const f = p.filter;
  if (!f) return true;
  if (f.groupGuids?.length) {
    const mine = new Set((s.groupGuids ?? []).map(lower));
    if (!f.groupGuids.some((g) => mine.has(lower(g)))) return false;
  }
  if (f.nodeRoles?.length && (!s.nodeRole || !f.nodeRoles.includes(s.nodeRole))) return false;
  return true;
}

/** The policies of `type` that apply to the subject, winner first. A policy linked at several levels counts once. */
export function applicablePolicies<P extends ResolvablePolicy>(
  subject: Subject,
  policies: readonly P[],
  type: string,
): AppliedPolicy<P>[] {
  const depthOf = new Map(subject.chain.map((l, i) => [lower(l.guid), i]));
  const best = new Map<string, AppliedPolicy<P>>();
  for (const p of policies) {
    if (p.type !== type || !applies(p, subject)) continue;
    for (const link of p.links) {
      if (!link.enabled) continue;
      const depth = depthOf.get(lower(link.targetGuid));
      if (depth === undefined) continue;
      const level = subject.chain[depth];
      if (!level) continue;
      const cand: AppliedPolicy<P> = { policy: p, level, depth, enforced: link.enforced };
      const cur = best.get(p.id);
      if (!cur || compare(cand, cur) < 0) best.set(p.id, cand);
    }
  }
  return [...best.values()].sort(compare);
}

/** Negative when `a` beats `b`. */
export function compare(a: AppliedPolicy, b: AppliedPolicy): number {
  if (a.enforced !== b.enforced) return a.enforced ? -1 : 1;
  // enforced: the higher (more distant) link wins; otherwise the closer one
  if (a.depth !== b.depth) return a.enforced ? b.depth - a.depth : a.depth - b.depth;
  if (a.policy.priority !== b.policy.priority) return a.policy.priority - b.policy.priority;
  return a.policy.name.localeCompare(b.policy.name) || a.policy.id.localeCompare(b.policy.id);
}

/** Per-key merge: each key takes its value from the first applicable policy (winner first) that sets it. */
export function effectiveSettings<P extends ResolvablePolicy>(
  applied: readonly AppliedPolicy<P>[],
): Record<string, EffectiveSetting<P>> {
  const out: Record<string, EffectiveSetting<P>> = {};
  for (const a of applied) {
    for (const [key, value] of Object.entries(a.policy.settings)) {
      if (value === undefined || key in out) continue;
      out[key] = { value, source: a };
    }
  }
  return out;
}

/** The containers of a DN up to (and including) the domain head, nearest first; GUIDs come from `guidOf`. */
export function chainOf(dn: string, domainDn: string, guidOf: (dn: string) => string | undefined): ChainLevel[] {
  const parts = splitDn(dn);
  const head = lower(domainDn);
  const out: ChainLevel[] = [];
  for (let i = 1; i < parts.length; i++) {
    const container = parts.slice(i).join(',');
    const guid = guidOf(container);
    if (guid) out.push({ guid, dn: container });
    if (lower(container) === head) break;
  }
  return out;
}

/** Splits a DN into RDNs, respecting escaped commas. */
export function splitDn(dn: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < dn.length; i++) {
    const c = dn[i] ?? '';
    if (c === '\\' && i + 1 < dn.length) {
      cur += c + (dn[i + 1] ?? '');
      i++;
    } else if (c === ',') {
      out.push(cur.trim());
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
