// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { RegistryKeyDefinition } from '@opendc/shared/manifest';

const port = z.number().int().min(1).max(65535);

export const keys: RegistryKeyDefinition[] = [
  {
    name: 'core.demo.message',
    schema: z.string().max(200),
    default: 'Managed by OpenDC',
    description: 'core:keys.demo-message',
    policySettable: true,
  },
  {
    name: 'core.demo.enabled',
    schema: z.boolean(),
    default: true,
    description: 'core:keys.demo-enabled',
    policySettable: true,
  },
  {
    name: 'core.api.listenHost',
    schema: z.union([z.ipv4(), z.ipv6(), z.literal('::')]),
    default: '::',
    description: 'core:keys.api-listen-host',
    policySettable: false,
    effect: 'restart',
  },
  {
    name: 'core.api.listenPort',
    schema: port,
    default: 8443,
    description: 'core:keys.api-listen-port',
    policySettable: false,
    effect: 'restart',
  },
  {
    name: 'core.directory.ldapUrls',
    schema: z.array(z.string().regex(/^ldaps?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/)).min(1),
    default: ['ldaps://localhost'],
    description: 'core:keys.directory-ldap-urls',
    policySettable: false,
    effect: 'restart',
  },
  {
    name: 'core.directory.baseDn',
    schema: z.string().max(1024),
    default: '',
    description: 'core:keys.directory-base-dn',
    policySettable: false,
    effect: 'restart',
  },
  {
    name: 'core.directory.tlsServerName',
    schema: z.string().max(255),
    default: '',
    description: 'core:keys.directory-tls-server-name',
    policySettable: false,
    effect: 'restart',
  },
  {
    name: 'core.session.idleMinutes',
    schema: z.number().int().min(5).max(720),
    default: 30,
    description: 'core:keys.session-idle',
    policySettable: true,
  },
  {
    name: 'core.session.absoluteHours',
    schema: z.number().int().min(1).max(72),
    default: 12,
    description: 'core:keys.session-absolute',
    policySettable: true,
  },
  {
    name: 'core.session.requireTotpForTier0',
    schema: z.boolean(),
    default: true,
    description: 'core:keys.session-require-totp',
    policySettable: true,
  },
];
