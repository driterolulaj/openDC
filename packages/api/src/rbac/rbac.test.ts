// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RbacEngine, type Assignment, type PermissionMeta, type Role } from './engine.ts';
import { BUILTIN_ROLES, builtinAssignments, isProtected } from './builtin.ts';
import { permissions as catalogue } from '@opendc/shared';

const DOM = 'S-1-5-21-1-2-3';
const perms: PermissionMeta[] = [
  { name: 'users.user.read', scope: 'ou' },
  { name: 'users.user.write', scope: 'ou', implies: ['users.user.read'] },
  { name: 'users.user.resetPassword', scope: 'ou' },
  { name: 'domain.fsmo.seize', scope: 'global', tier0: true },
  { name: 'nodes.node.restart', scope: 'node' },
  { name: 'core.console.access', scope: 'global' },
];
const roles: Role[] = [
  { id: 'admin', name: 'Admin', permissions: ['*'], tier0: true, builtin: true },
  { id: 'helpdesk', name: 'Helpdesk', permissions: ['users.user.write', 'users.user.resetPassword', 'core.console.access'], tier0: false, builtin: false },
  // tries to grant a tier-0 permission without being a tier-0 role: must not work
  { id: 'sneaky', name: 'Sneaky', permissions: ['domain.fsmo.seize'], tier0: false, builtin: false },
  { id: 'ops', name: 'Ops', permissions: ['nodes.node.restart'], tier0: false, builtin: false },
];
const assignments: Assignment[] = [
  { id: 'a-admin', roleId: 'admin', principals: [`${DOM}-512`], scopes: [{ kind: 'domain' }] },
  { id: 'a-help', roleId: 'helpdesk', principals: [`${DOM}-1105`], scopes: [{ kind: 'subtree', dn: 'OU=Staff,DC=example,DC=com' }] },
  { id: 'a-sneaky', roleId: 'sneaky', principals: [`${DOM}-1106`], scopes: [{ kind: 'domain' }] },
  { id: 'a-ops', roleId: 'ops', principals: [`${DOM}-1107`], scopes: [{ kind: 'node', nodeGuid: 'AAAA-1' }] },
];
const engine = new RbacEngine(perms, roles, assignments);

const helpdesk = { sid: `${DOM}-2001`, groupSids: [`${DOM}-513`, `${DOM}-1105`] };
const admin = { sid: `${DOM}-500`, groupSids: [`${DOM}-512`] };
const alice = 'CN=alice,OU=Staff,DC=example,DC=com';

test('helpdesk: allowed in scope, 403 outside it (acceptance Phase 2.3 logic)', () => {
  assert.deepEqual(engine.can(helpdesk, 'users.user.resetPassword', { dn: alice }), { allow: true, via: ['a-help'] });
  assert.deepEqual(engine.can(helpdesk, 'users.user.resetPassword', { dn: 'CN=bob,OU=Sales,DC=example,DC=com' }), { allow: false, reason: 'out-of-scope' });
  assert.deepEqual(engine.can(helpdesk, 'users.user.resetPassword', { dn: 'cn=ALICE,ou=staff,dc=Example,dc=com' }).allow, true);
  assert.equal(engine.can(helpdesk, 'users.user.resetPassword', { dn: 'CN=x,OU=Staff2,DC=example,DC=com' }).allow, false);
  assert.equal(engine.can(helpdesk, 'users.user.resetPassword').allow, true);
});

test('tier-0 guard: a Domain Admin inside the helpdesk OU stays out of reach', () => {
  const da = { dn: 'CN=root,OU=Staff,DC=example,DC=com', protected: true };
  assert.deepEqual(engine.can(helpdesk, 'users.user.resetPassword', da), { allow: false, reason: 'tier0' });
  assert.equal(engine.can(admin, 'users.user.resetPassword', da).allow, true);
});

test('implied permissions, wildcard, tier-0 permissions only in tier-0 roles', () => {
  assert.equal(engine.can(helpdesk, 'users.user.read', { dn: alice }).allow, true);
  assert.equal(engine.can(admin, 'domain.fsmo.seize').allow, true);
  assert.deepEqual(engine.can({ sid: 'S-1-5-21-1-2-3-3000', groupSids: [`${DOM}-1106`] }, 'domain.fsmo.seize'), { allow: false, reason: 'no-permission' });
  assert.deepEqual(engine.can({ sid: 'S-1-5-21-9', groupSids: [] }, 'core.console.access'), { allow: false, reason: 'no-permission' });
  assert.throws(() => engine.can(admin, 'nope.x.y'), TypeError);
});

test('node scopes', () => {
  const ops = { sid: 'S-x', groupSids: [`${DOM}-1107`] };
  assert.equal(engine.can(ops, 'nodes.node.restart', { nodeGuid: 'aaaa-1' }).allow, true);
  assert.equal(engine.can(ops, 'nodes.node.restart', { nodeGuid: 'bbbb-2' }).allow, false);
  assert.equal(engine.can(ops, 'nodes.node.restart', {}).allow, false);
  assert.equal(engine.can(admin, 'nodes.node.restart', { nodeGuid: 'bbbb-2' }).allow, true);
  // an OU permission with a node-only target is out of scope for subtree assignments
  assert.equal(engine.can(helpdesk, 'users.user.read', { nodeGuid: 'x' }).allow, false);
});

test('effective permissions list scopes and tier-0 flags', () => {
  const eff = engine.effective(helpdesk);
  assert.deepEqual(
    eff.map((e) => e.permission),
    ['core.console.access', 'users.user.read', 'users.user.resetPassword', 'users.user.write'],
  );
  assert.deepEqual(eff[0]?.scopes, [{ kind: 'subtree', dn: 'OU=Staff,DC=example,DC=com' }]);
  assert.ok(engine.effective(admin).every((e) => e.tier0));
  assert.equal(engine.effective(admin).length, perms.length);
  assert.deepEqual(engine.effective({ sid: 'S-none', groupSids: [] }), []);
});

test('construction rejects unknown permissions and roles', () => {
  assert.throws(() => new RbacEngine(perms, [{ id: 'r', name: 'r', permissions: ['x.y.z'], tier0: false, builtin: false }], []), /unknown permission/);
  assert.throws(() => new RbacEngine(perms, roles, [{ id: 'a', roleId: 'missing', principals: [], scopes: [] }]), /unknown role/);
});

test('built-ins: Domain Admins, Enterprise Admins and BUILTIN\\Administrators get Domain Admin', () => {
  const e = new RbacEngine(catalogue, BUILTIN_ROLES, builtinAssignments(DOM));
  for (const g of [`${DOM}-512`, `${DOM}-519`, 'S-1-5-32-544']) {
    assert.equal(e.can({ sid: `${DOM}-1500`, groupSids: [g] }, 'core.console.access').allow, true, g);
  }
  assert.equal(e.can({ sid: `${DOM}-1500`, groupSids: [`${DOM}-513`] }, 'core.console.access').allow, false);
  assert.equal(e.can({ sid: `${DOM}-1500`, groupSids: ['S-1-5-21-9-9-9-512'] }, 'core.console.access').allow, false, 'another domain');
});

test('protected objects', () => {
  assert.ok(isProtected({ adminCount: 1 }, DOM));
  assert.ok(isProtected({ sid: `${DOM}-500` }, DOM));
  assert.ok(isProtected({ groupSids: [`${DOM}-512`] }, DOM));
  assert.ok(isProtected({ groupSids: ['S-1-5-32-551'] }, DOM));
  assert.ok(!isProtected({ adminCount: 0, sid: `${DOM}-1200`, groupSids: [`${DOM}-513`] }, DOM));
  assert.ok(!isProtected({ adminCount: null, sid: null }, DOM));
});
