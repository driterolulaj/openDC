// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Account security (SECURITY.md §4, ADR-0020): TOTP enrolment, re-authentication for tier-0 actions, API
 * tokens. Everything here acts on the caller's own account, except the second-factor reset for a lost
 * device, which needs domain.rbac.write (tier 0).
 */
import { PlatformError } from '@opendc/shared';
import {
  apiTokenCreated,
  apiTokenInput,
  apiTokens,
  empty,
  idParams,
  reauthRequest,
  sidParams,
  totpBegin,
  totpCode,
  totpConfirmed,
  totpStatus,
} from '@opendc/shared/api';
import type { AuditLog } from '../audit.ts';
import type { AuthenticatedUser } from '../directory.ts';
import type { RouteContext, RouteTable } from '../http/route.ts';
import type { TotpStore } from '../mfa.ts';
import type { RbacEngine } from '../rbac/engine.ts';
import type { SessionStore } from '../sessions.ts';
import type { TokenStore } from '../tokens.ts';

type Ctx = RouteContext<unknown, unknown, unknown>;

export interface AccountDeps {
  sessions: SessionStore;
  audit: AuditLog;
  totp: Pick<TotpStore, 'enrolled' | 'begin' | 'confirm' | 'check' | 'remove'>;
  tokens: Pick<TokenStore, 'create' | 'verify' | 'listFor' | 'revoke'>;
  directory: { authenticate(username: string, password: string): Promise<AuthenticatedUser> };
  engineFor(domainSid: string): RbacEngine;
}

export function accountRoutes(t: RouteTable, d: AccountDeps): void {
  const audit = (c: Ctx, action: string, after: unknown, result: 'success' | 'failure' = 'success'): void => {
    d.audit.append({
      actor: c.user.username,
      actorSid: c.user.sid,
      sourceIp: c.ip,
      action,
      result,
      targetGuid: c.user.guid,
      after,
      requestId: c.requestId,
    });
  };
  const cookieOnly = (c: Ctx): void => {
    if (c.user.via !== 'cookie') throw new PlatformError('auth.forbidden', { permission: 'core.console.access' });
  };
  const hasTier0 = (c: Ctx): boolean =>
    d
      .engineFor(c.user.domainSid)
      .effective({ sid: c.user.sid, groupSids: c.user.groupSids })
      .some((p) => p.tier0);

  t.add({
    method: 'GET',
    url: '/api/v1/session/totp',
    operationId: 'getTotpStatus',
    summary: 'Whether your account has a second factor, and whether your role requires one',
    tags: ['session'],
    auth: 'session',
    allowDuringMfaSetup: true,
    response: totpStatus,
    handler: async (c) => ({ enrolled: await d.totp.enrolled(c.user.sid), required: hasTier0(c) }),
  });

  t.add({
    method: 'POST',
    url: '/api/v1/session/totp/begin',
    operationId: 'beginTotp',
    summary: 'Start (or restart) authenticator enrolment; the secret is shown once',
    tags: ['session'],
    auth: 'session',
    allowDuringMfaSetup: true,
    response: totpBegin,
    rateLimit: { max: 10, windowSec: 60 },
    handler: async (c) => {
      cookieOnly(c);
      if (await d.totp.enrolled(c.user.sid))
        throw new PlatformError('request.conflict', { what: 'Second factor (already set up; remove it first)' });
      const secret = await d.totp.begin(c.user.sid);
      const label = encodeURIComponent(`OpenDC:${c.user.username}`);
      return {
        secret,
        uri: `otpauth://totp/${label}?secret=${secret}&issuer=OpenDC&algorithm=SHA1&digits=6&period=30`,
      };
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/session/totp/confirm',
    operationId: 'confirmTotp',
    summary: 'Finish enrolment with a first code; returns recovery codes once',
    tags: ['session'],
    auth: 'session',
    allowDuringMfaSetup: true,
    body: totpCode,
    response: totpConfirmed,
    rateLimit: { max: 10, windowSec: 60 },
    handler: async (c) => {
      cookieOnly(c);
      const codes = await d.totp.confirm(c.user.sid, c.body.code);
      if (!codes) throw new PlatformError('auth.totp-invalid');
      d.sessions.mfaEnrolled(c.user.idHash);
      audit(c, 'account.totp.enrol', { recoveryCodes: codes.length });
      return { recoveryCodes: codes };
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/session/totp',
    operationId: 'removeTotp',
    summary: 'Remove your second factor (needs a current code)',
    tags: ['session'],
    auth: 'session',
    body: totpCode,
    response: empty,
    handler: async (c) => {
      cookieOnly(c);
      if (!(await d.totp.check(c.user.sid, c.body.code))) throw new PlatformError('auth.totp-invalid');
      await d.totp.remove(c.user.sid);
      audit(c, 'account.totp.remove', {});
      return {};
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/accounts/:sid/totp',
    operationId: 'resetTotp',
    summary: "Reset another user's second factor (lost device); they enrol again at their next login",
    tags: ['session'],
    auth: { permission: 'domain.rbac.write' },
    params: sidParams,
    response: empty,
    handler: async (c) => {
      c.require('domain.rbac.write', { protected: true, label: c.params.sid });
      await d.totp.remove(c.params.sid);
      d.audit.append({
        actor: c.user.username,
        actorSid: c.user.sid,
        sourceIp: c.ip,
        action: 'account.totp.reset',
        result: 'success',
        after: { sid: c.params.sid },
        requestId: c.requestId,
      });
      return {};
    },
  });

  t.add({
    method: 'POST',
    url: '/api/v1/session/reauth',
    operationId: 'reauthenticate',
    summary: 'Confirm your password (and second factor) before tier-0 actions',
    tags: ['session'],
    auth: 'session',
    body: reauthRequest,
    response: empty,
    rateLimit: { max: 10, windowSec: 60 },
    handler: async (c) => {
      cookieOnly(c);
      let ok: boolean;
      try {
        // the LDAPS bind counts failures against the domain lockout policy, like a login
        const u = await d.directory.authenticate(c.user.username, c.body.password);
        ok = u.sid === c.user.sid;
      } catch {
        ok = false;
      }
      if (ok && (await d.totp.enrolled(c.user.sid))) {
        if (!c.body.totp) throw new PlatformError('auth.totp-required');
        ok = await d.totp.check(c.user.sid, c.body.totp);
      }
      if (!ok) {
        audit(c, 'session.reauth', {}, 'failure');
        throw new PlatformError('auth.invalid-credentials');
      }
      d.sessions.reauthenticated(c.user.idHash);
      audit(c, 'session.reauth', {});
      return {};
    },
  });

  t.add({
    method: 'GET',
    url: '/api/v1/session/tokens',
    operationId: 'listApiTokens',
    summary: 'Your API tokens (without secrets)',
    tags: ['session'],
    auth: 'session',
    response: apiTokens,
    handler: async (c) => ({
      tokens: (await d.tokens.listFor(c.user.sid)).map((x) => ({
        id: x.id,
        name: x.data.name,
        permissions: x.data.permissions,
        createdAt: x.data.createdAt,
        expiresAt: x.data.expiresAt,
      })),
    }),
  });

  t.add({
    method: 'POST',
    url: '/api/v1/session/tokens',
    operationId: 'createApiToken',
    summary: 'Create an API token (shown once); it never carries tier-0 rights',
    tags: ['session'],
    auth: 'session',
    body: apiTokenInput,
    response: apiTokenCreated,
    status: 201,
    rateLimit: { max: 10, windowSec: 60 },
    handler: async (c) => {
      cookieOnly(c);
      const engine = d.engineFor(c.user.domainSid);
      if (c.body.permissions) {
        const mine = new Set(
          engine.effective({ sid: c.user.sid, groupSids: c.user.groupSids }).map((p) => p.permission),
        );
        const extra = c.body.permissions.filter((p) => !mine.has(p));
        if (extra.length)
          throw new PlatformError('validation.invalid', { issues: `permissions you don't hold: ${extra.join(', ')}` });
      }
      const r = await d.tokens.create(c.user, {
        name: c.body.name,
        days: c.body.days,
        permissions: c.body.permissions,
      });
      audit(c, 'account.token.create', {
        id: r.id,
        name: c.body.name,
        days: c.body.days,
        permissions: c.body.permissions,
      });
      return r;
    },
  });

  t.add({
    method: 'DELETE',
    url: '/api/v1/session/tokens/:id',
    operationId: 'revokeApiToken',
    summary: 'Revoke one of your API tokens',
    tags: ['session'],
    auth: 'session',
    params: idParams,
    response: empty,
    handler: async (c) => {
      if (!(await d.tokens.revoke(c.user.sid, c.params.id)))
        throw new PlatformError('request.not-found', { what: `Token ${c.params.id}` });
      audit(c, 'account.token.revoke', { id: c.params.id });
      return {};
    },
  });
}
