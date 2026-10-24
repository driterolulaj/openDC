// SPDX-License-Identifier: AGPL-3.0-only
// Node-side entry. Browser code imports the subpaths `@opendc/shared/api` and `@opendc/shared/errors` only.
export * from './errors.ts';
export * as ldap from './ldap/index.ts';
export * as manifest from './manifest/index.ts';
export * as agent from './agent/index.ts';
export * as db from './db/index.ts';
export { platformVersion } from './version.ts';
export { permissions, type PermissionName } from './generated/permissions.ts';
