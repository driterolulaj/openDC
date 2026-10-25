// SPDX-License-Identifier: AGPL-3.0-only
/**
 * `opendc-agent --init-secrets` (run as root by opendc-secrets-init.service before the API and agent start).
 * Creates the node-local secrets the units load with LoadCredential= when they are missing; never
 * overwrites existing ones:
 *   api-hmac          32 random bytes: session CSRF + typed-confirmation HMAC key (SECURITY.md §8)
 *   tls-cert/tls-key  self-signed console certificate for this host until the internal CA exists (Phase 3)
 *   ldap-ca.pem       the local Samba DC's CA, so the API verifies LDAPS against it (empty on non-DCs)
 *   ldap-svc, ldap-watch  service-account credentials; empty placeholders until setup fills them
 *   setup-token       one-time setup token while the node isn't part of a domain (printed to the journal)
 */
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { exec, type OsActions } from '@opendc/os';
import { ldapCaBundle } from './samba/pki.ts';
import { SetupToken } from './setup/token.ts';
import { NodeStateFile } from './state.ts';

async function exists(p: string): Promise<boolean> {
  return access(p, constants.F_OK).then(
    () => true,
    () => false,
  );
}

async function writeSecret(path: string, data: Buffer | string): Promise<void> {
  const fh = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
}

function hostAddresses(): string[] {
  return (
    Object.values(networkInterfaces())
      .flat()
      .filter((a) => a && !a.internal)
      .map((a) => a?.address ?? '')
      // link-local IPv6 carries a zone id (fe80::1%eth0) that openssl rejects in a SAN
      .filter((a) => a !== '' && !a.toLowerCase().startsWith('fe80:') && !a.includes('%'))
  );
}

export async function initSecrets(
  os: OsActions,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const dir = os.facts.paths.secrets;
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const hmac = join(dir, 'api-hmac');
  if (!(await exists(hmac))) {
    await writeSecret(hmac, randomBytes(32));
    log('created api-hmac');
  }

  const cert = join(dir, 'tls-cert.pem');
  const key = join(dir, 'tls-key.pem');
  if (!(await exists(cert)) || !(await exists(key))) {
    const info = await os.system.info();
    const names = [...new Set([info.fqdn, info.hostname])].filter(Boolean);
    const san = [...names.map((n) => `DNS:${n}`), ...hostAddresses().map((a) => `IP:${a}`)].join(',');
    await rm(cert, { force: true });
    await rm(key, { force: true });
    const openssl = await os.facts.binaries.resolve('openssl');
    await exec(
      openssl,
      [
        'req',
        '-x509',
        '-newkey',
        'ec',
        '-pkeyopt',
        'ec_paramgen_curve:P-256',
        '-nodes',
        '-days',
        '825',
        '-subj',
        `/CN=${info.fqdn}/O=OpenDC (self-signed until the domain CA exists)`,
        '-addext',
        // eslint-disable-next-line opendc/no-raw-ldap -- an openssl -addext argument, not an LDAP DN
        `subjectAltName=${san}`,
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { timeoutMs: 30_000 },
    );
    await chmod(key, 0o600);
    await chmod(cert, 0o644);
    log('created self-signed console certificate', { names, san });
  }

  const ldapCa = join(dir, 'ldap-ca.pem');
  const sambaCa = join(os.facts.samba.paths().tlsDir, 'ca.pem');
  const opendcCas = join(os.facts.paths.etc, 'pki', 'ca-bundle.pem');
  if ((await exists(sambaCa)) || (await exists(opendcCas))) {
    // the OpenDC CAs (once the PKI exists) and Samba's own CA: an upgrade must never drop the OpenDC part
    const current = await readFile(ldapCa, 'utf8').catch(() => null);
    const wanted = ldapCaBundle(
      await readFile(opendcCas, 'utf8').catch(() => null),
      await readFile(sambaCa, 'utf8').catch(() => null),
    );
    if (current !== wanted) {
      await writeFile(ldapCa, wanted, { mode: 0o600 });
      log('installed the CA bundle for LDAPS verification');
    }
  } else if (!(await exists(ldapCa))) {
    // Not a DC (or Samba not provisioned yet): an empty bundle means "system CAs" to the API.
    await writeFile(ldapCa, '', { mode: 0o600 });
  }

  // LoadCredential= fails on a missing file, so the API's credentials exist (empty) before setup
  for (const name of ['ldap-svc', 'ldap-watch', 'pki/node.key', 'pki/node.pem']) {
    const p = join(dir, name);
    await mkdir(dirname(p), { recursive: true, mode: 0o700 });
    if (!(await exists(p))) await writeFile(p, '', { mode: 0o600 });
  }

  if (!(await new NodeStateFile(os.facts.paths.etc).read())) {
    const token = await new SetupToken(dir).ensure();
    const info = await os.system.info();
    // printed on purpose: the console and the journal are how the installing admin receives it
    log(`OpenDC setup token: ${token}`, {
      wizard: `https://${info.fqdn}:8443/console/setup`,
      cli: 'sudo opendc setup',
    });
  }
}

/** Forces a new self-signed console certificate (after setup changed the host name). */
export async function renewConsoleCertificate(
  os: OsActions,
  log: (msg: string, extra?: Record<string, unknown>) => void,
): Promise<void> {
  const dir = os.facts.paths.secrets;
  await rm(join(dir, 'tls-cert.pem'), { force: true });
  await rm(join(dir, 'tls-key.pem'), { force: true });
  await initSecrets(os, log);
}
