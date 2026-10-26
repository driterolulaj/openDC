// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bigToIp6,
  dhcpReservation,
  dhcpReservation6,
  dhcpSubnet,
  dhcpSubnet6,
  inSubnet,
  inSubnet6,
  intToIp,
  ip6ToBig,
  ipToInt,
  keaApplyArgs,
  keaSubnetId,
  parseCidr,
  parseCidr6,
  renderKea4,
  renderKea6,
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
  assert.throws(() => renderKea4(ha, paths), /needs TLS/, 'never plain HTTP');
  assert.throws(
    () => renderKea4({ ...ha, ha: { ...ha.ha!, thisServer: 'x' } }, { ...paths, tls }),
    /not one of the peers/,
  );
});

test('IPv6: parsing, the RFC 5952 form, prefixes', () => {
  assert.equal(bigToIp6(ip6ToBig('FD00:0010:0000:0000:0000:0000:0000:0001')), 'fd00:10::1');
  assert.equal(bigToIp6(ip6ToBig('::')), '::');
  assert.equal(bigToIp6(ip6ToBig('::1')), '::1');
  assert.equal(bigToIp6(ip6ToBig('fe80::')), 'fe80::');
  // the first of two equally long zero runs; a single zero group stays
  assert.equal(bigToIp6(ip6ToBig('2001:db8:0:0:1:0:0:1')), '2001:db8::1:0:0:1');
  assert.equal(bigToIp6(ip6ToBig('2001:db8:0:1:1:1:1:1')), '2001:db8:0:1:1:1:1:1');
  assert.equal(bigToIp6(ip6ToBig('::ffff:10.0.0.1')), '::ffff:a00:1');
  for (const bad of ['1::2::3', '1:2:3:4:5:6:7', 'g::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4::5:6:7:8', '12345::'])
    assert.throws(() => ip6ToBig(bad), /not an IPv6/, bad);
  assert.equal(parseCidr6('fd00:10::/64').prefix, 64);
  assert.equal(parseCidr6('fd00:10::/64').last, ip6ToBig('fd00:10::ffff:ffff:ffff:ffff'));
  assert.throws(() => parseCidr6('fd00:10::1/64'), /try fd00:10::\/64/);
  assert.throws(() => parseCidr6('fd00::/16'), /not an IPv6 prefix/);
  assert.throws(() => parseCidr6('fd00::'), /not an IPv6 prefix/);
  assert.ok(inSubnet6('fd00:10::/64', 'fd00:10::ffff'));
  assert.ok(!inSubnet6('fd00:10::/64', 'fd00:10::'), 'subnet-router anycast');
  assert.ok(!inSubnet6('fd00:10::/64', 'fd00:11::1'));
});

test('IPv6 subnets and reservations', () => {
  const s = dhcpSubnet6.parse({
    serviceId: SVC,
    prefix: 'FD00:10:0::/64',
    pools: [{ from: 'fd00:10::100', to: 'fd00:10::1ff' }],
    dnsServers: ['FD00:10::0:53'],
  });
  assert.equal(s.prefix, 'fd00:10::/64');
  assert.deepEqual(s.dnsServers, ['fd00:10::53']);
  assert.equal(s.interface, null);
  assert.deepEqual(s.domainSearch, []);
  const bad = (x: Record<string, unknown>) =>
    dhcpSubnet6.safeParse({ serviceId: SVC, prefix: 'fd00:10::/64', ...x }).success;
  assert.equal(bad({ pools: [{ from: 'fd00:11::1', to: 'fd00:11::2' }] }), false, 'pool outside');
  assert.equal(bad({ pools: [{ from: 'fd00:10::9', to: 'fd00:10::1' }] }), false, 'from > to');
  assert.equal(bad({ prefix: 'fd00:10::1/64' }), false, 'not a prefix');
  assert.equal(bad({ dnsServers: ['10.0.0.1'] }), false, 'IPv4 DNS server');
  const r = (x: Record<string, unknown>) => dhcpReservation6.safeParse({ subnetId: SVC, ip: 'fd00:10::201', ...x });
  assert.equal(r({ duid: '00:03:00:01:02:00:00:00:97:01' }).success, true);
  assert.equal(r({ mac: '02-00-00-00-97-01' }).success, true);
  assert.equal(r({ duid: '00:03:00:01:02:00:00:00:97:01', mac: '02:00:00:00:97:01' }).success, false, 'both');
  assert.equal(r({}).success, false, 'neither');
  assert.equal(r({ duid: '00:03' }).success, false, 'too short');
});

test('Kea6 rendering: interface per subnet, DUID or MAC reservations, lifetimes, HA on its own port', () => {
  const a = keaApplyArgs.parse({
    enabled: true,
    interfaces: ['eth0'],
    leaseSeconds: 4000,
    subnets6: [
      {
        id: 7,
        prefix: 'fd00:10::/64',
        interface: 'eth0',
        pools: [{ from: 'fd00:10::100', to: 'fd00:10::1ff' }],
        dnsServers: ['fd00:10::53'],
        domainSearch: ['example.test'],
        reservations: [
          { duid: '00:03:00:01:02:00:00:00:97:01', mac: null, ip: 'fd00:10::201', hostname: 'r1' },
          { duid: null, mac: '02:00:00:00:97:02', ip: 'fd00:10::200', hostname: null },
        ],
      },
    ],
  });
  const paths6 = { ...paths, leaseFile: '/var/lib/kea/l6.csv', controlSocket: '/run/kea/s6' };
  type Conf = {
    Dhcp6: {
      'preferred-lifetime': number;
      'renew-timer': number;
      'rebind-timer': number;
      'control-socket': { 'socket-name': string };
      'hooks-libraries': { library: string; parameters?: { 'high-availability': { peers: { url: string }[] }[] } }[];
      subnet6: {
        interface: string;
        'option-data': { name: string; data: string }[];
        reservations: Record<string, unknown>[];
      }[];
    };
  };
  const c = (renderKea6(a, paths6) as Conf).Dhcp6;
  assert.equal(c['preferred-lifetime'], 3000);
  assert.equal(c['renew-timer'], 1500);
  assert.equal(c['rebind-timer'], 2400);
  assert.equal(c['control-socket']['socket-name'], '/run/kea/s6');
  assert.equal(c.subnet6[0]?.interface, 'eth0');
  assert.deepEqual(
    c.subnet6[0]?.['option-data'].map((o) => o.name),
    ['dns-servers', 'domain-search'],
  );
  assert.deepEqual(c.subnet6[0]?.reservations, [
    { 'hw-address': '02:00:00:00:97:02', 'ip-addresses': ['fd00:10::200'] },
    { duid: '00:03:00:01:02:00:00:00:97:01', 'ip-addresses': ['fd00:10::201'], hostname: 'r1' },
  ]);
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
  const h = (renderKea6(ha, { ...paths6, tls }) as Conf).Dhcp6['hooks-libraries'][1];
  assert.equal(h?.parameters?.['high-availability'][0]?.peers[1]?.url, 'https://10.0.0.2:8001/');
  assert.throws(() => renderKea6(ha, paths6), /needs TLS/);
});
