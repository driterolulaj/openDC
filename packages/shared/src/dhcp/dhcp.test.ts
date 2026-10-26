// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dhcpReservation,
  dhcpSubnet,
  inSubnet,
  intToIp,
  ipToInt,
  keaApplyArgs,
  keaSubnetId,
  parseCidr,
  renderKea4,
} from './index.ts';

const SVC = '6f9619ff-8b86-4011-b42d-00c04fc964ff';
const paths = {
  hooksDir: '/usr/lib/kea/hooks',
  leaseFile: '/var/lib/kea/l4.csv',
  controlSocket: '/run/kea/s4',
  tls: null,
};

test('address arithmetic', () => {
  assert.equal(ipToInt('10.97.10.1'), 0x0a610a01);
  assert.equal(intToIp(0x0a610a01), '10.97.10.1');
  assert.deepEqual(parseCidr('10.97.10.0/24'), {
    network: 0x0a610a00,
    prefix: 24,
    first: 0x0a610a01,
    last: 0x0a610afe,
  });
  assert.throws(() => parseCidr('10.97.10.5/24'), /not a network address \(try 10.97.10.0\/24\)/);
  assert.throws(() => parseCidr('10.0.0.0/31'), /not an IPv4 subnet/);
  assert.throws(() => ipToInt('10.0.0.300'), /not an IPv4/);
  assert.ok(inSubnet('10.97.10.0/24', '10.97.10.200'));
  assert.ok(!inSubnet('10.97.10.0/24', '10.97.10.255'), 'broadcast');
  assert.ok(!inSubnet('10.97.10.0/24', '10.97.11.1'));
});

test('subnets: pools and routers inside, network address; reservations: MAC normalised', () => {
  const ok = dhcpSubnet.safeParse({
    serviceId: SVC,
    cidr: '10.97.10.0/24',
    pools: [{ from: '10.97.10.200', to: '10.97.10.220' }],
    routers: ['10.97.10.1'],
  });
  assert.ok(ok.success);
  assert.ok(
    !dhcpSubnet.safeParse({
      serviceId: SVC,
      cidr: '10.97.10.0/24',
      pools: [{ from: '10.97.10.220', to: '10.97.10.200' }],
    }).success,
  );
  assert.ok(
    !dhcpSubnet.safeParse({
      serviceId: SVC,
      cidr: '10.97.10.0/24',
      pools: [{ from: '10.97.10.200', to: '10.97.11.5' }],
    }).success,
  );
  assert.ok(!dhcpSubnet.safeParse({ serviceId: SVC, cidr: '10.97.10.0/24', routers: ['10.0.0.1'] }).success);
  assert.ok(!dhcpSubnet.safeParse({ serviceId: SVC, cidr: '10.97.10.7/24' }).success);
  const r = dhcpReservation.parse({ subnetId: SVC, mac: 'AA-BB-CC-00-11-22', ip: '10.97.10.50', hostname: 'printer' });
  assert.equal(r.mac, 'aa:bb:cc:00:11:22');
  assert.ok(!dhcpReservation.safeParse({ subnetId: SVC, mac: 'aa:bb', ip: '10.97.10.50' }).success);
  assert.equal(keaSubnetId(SVC), keaSubnetId(SVC));
  assert.ok(keaSubnetId(SVC) >= 1 && keaSubnetId(SVC) <= 2_147_483_647);
  assert.equal(keaSubnetId('ffffffff-0000-4000-8000-000000000000'), (0xffffffff % 2_147_483_646) + 1);
});

test('Kea rendering: options, pools, sorted reservations, lease cmds, HA over TLS', () => {
  const a = keaApplyArgs.parse({
    enabled: true,
    interfaces: ['eth0'],
    leaseSeconds: 3600,
    globals: { dnsServers: ['10.97.10.11'], domainName: 'standard.opendc.test' },
    subnets: [
      {
        id: 7,
        cidr: '10.97.10.0/24',
        pools: [{ from: '10.97.10.200', to: '10.97.10.220' }],
        routers: ['10.97.10.1'],
        dnsServers: [],
        domainName: null,
        ntpServers: ['10.97.10.11'],
        reservations: [
          { mac: '00:00:00:00:00:02', ip: '10.97.10.60', hostname: null },
          { mac: '00:00:00:00:00:01', ip: '10.97.10.50', hostname: 'printer' },
        ],
      },
    ],
  });
  const c = renderKea4(a, paths) as { Dhcp4: Record<string, unknown> };
  const d = c.Dhcp4 as {
    'valid-lifetime': number;
    'hooks-libraries': { library: string }[];
    'option-data': { name: string; data: string }[];
    subnet4: {
      id: number;
      pools: { pool: string }[];
      'option-data': { name: string }[];
      reservations: { 'ip-address': string; hostname?: string }[];
    }[];
    'multi-threading'?: unknown;
  };
  assert.equal(d['valid-lifetime'], 3600);
  assert.deepEqual(d['hooks-libraries'], [{ library: '/usr/lib/kea/hooks/libdhcp_lease_cmds.so' }]);
  assert.deepEqual(
    d['option-data'].map((o) => o.name),
    ['domain-name-servers', 'domain-name'],
  );
  assert.equal(d.subnet4[0]?.pools[0]?.pool, '10.97.10.200 - 10.97.10.220');
  assert.deepEqual(
    d.subnet4[0]?.['option-data'].map((o) => o.name),
    ['routers', 'ntp-servers'],
  );
  assert.deepEqual(
    d.subnet4[0]?.reservations.map((r) => r['ip-address']),
    ['10.97.10.50', '10.97.10.60'],
  );
  assert.equal(d.subnet4[0]?.reservations[0]?.hostname, 'printer');
  assert.equal(d['multi-threading'], undefined);

  const ha = keaApplyArgs.parse({
    ...a,
    ha: {
      mode: 'hot-standby',
      thisServer: 'm1',
      peers: [
        { name: 'm1', address: '10.0.0.1', role: 'primary' },
        { name: 'm2', address: '10.0.0.2', role: 'standby' },
      ],
    },
  });
  const tls = { cert: '/n.pem', key: '/n.key', ca: '/ca.pem' };
  const h = (
    renderKea4(ha, { ...paths, tls }) as {
      Dhcp4: {
        'hooks-libraries': {
          library: string;
          parameters?: { 'high-availability': { peers: { url: string }[]; 'require-client-certs'?: boolean }[] };
        }[];
      };
    }
  ).Dhcp4['hooks-libraries'][1];
  assert.equal(h?.library, '/usr/lib/kea/hooks/libdhcp_ha.so');
  assert.equal(h?.parameters?.['high-availability'][0]?.peers[1]?.url, 'https://10.0.0.2:8000/');
  assert.equal(h?.parameters?.['high-availability'][0]?.['require-client-certs'], true);
  const plain = (
    renderKea4(ha, paths) as {
      Dhcp4: { 'hooks-libraries': { parameters?: { 'high-availability': { peers: { url: string }[] }[] } }[] };
    }
  ).Dhcp4['hooks-libraries'][1];
  assert.equal(plain?.parameters?.['high-availability'][0]?.peers[0]?.url, 'http://10.0.0.1:8000/');
  assert.throws(() => renderKea4({ ...ha, ha: { ...ha.ha!, thisServer: 'x' } }, paths), /not one of the peers/);
});
