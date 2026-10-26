// SPDX-License-Identifier: AGPL-3.0-only
/**
 * DHCPv4 and DHCPv6 with Kea (ROADMAP Phase 3, Spike S4): the directory objects (services, subnets and
 * reservations per family), address arithmetic for their validation, and the Kea configurations the agent renders
 * from typed data. The agent never
 * accepts a Kea configuration as such: hook libraries load code as root, so their paths come from the OS adapter.
 */
import { z } from 'zod';

// ---------------------------------------------------------------- addresses

export function ipToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255))
    throw new TypeError(`not an IPv4 address: ${ip}`);
  return (((p[0] ?? 0) << 24) >>> 0) + ((p[1] ?? 0) << 16) + ((p[2] ?? 0) << 8) + (p[3] ?? 0);
}
export const intToIp = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');

export function parseCidr(cidr: string): { network: number; prefix: number; first: number; last: number } {
  const [ip, bits] = cidr.split('/');
  const prefix = Number(bits);
  if (!ip || !Number.isInteger(prefix) || prefix < 8 || prefix > 30) throw new TypeError(`not an IPv4 subnet: ${cidr}`);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  const network = (ipToInt(ip) & mask) >>> 0;
  if (network !== ipToInt(ip))
    throw new TypeError(`${cidr} is not a network address (try ${intToIp(network)}/${String(prefix)})`);
  const broadcast = (network | (~mask >>> 0)) >>> 0;
  return { network, prefix, first: network + 1, last: broadcast - 1 };
}

/** A usable host address of the subnet (not the network or broadcast address). */
export function inSubnet(cidr: string, ip: string): boolean {
  const s = parseCidr(cidr);
  const n = ipToInt(ip);
  return n >= s.first && n <= s.last;
}

/** IPv6 address -> 128-bit number (no zone ids; an IPv4 tail is accepted). */
export function ip6ToBig(ip: string): bigint {
  let s = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s)?.[1];
  if (v4) {
    const n = ipToInt(v4);
    s = `${s.slice(0, -v4.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) throw new TypeError(`not an IPv6 address: ${ip}`);
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) throw new TypeError(`not an IPv6 address: ${ip}`);
  let n = 0n;
  for (const g of [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail]) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) throw new TypeError(`not an IPv6 address: ${ip}`);
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** 128-bit number -> IPv6 address in the RFC 5952 form (the longest run of zero groups compressed). */
export function bigToIp6(n: bigint): string {
  const g: string[] = [];
  for (let i = 7; i >= 0; i--) g.push(Number((n >> BigInt(i * 16)) & 0xffffn).toString(16));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8;) {
    if (g[i] !== '0') {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && g[j] === '0') j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  return best < 0 ? g.join(':') : `${g.slice(0, best).join(':')}::${g.slice(best + bestLen).join(':')}`;
}

const MAX128 = (1n << 128n) - 1n;

export function parseCidr6(cidr: string): { network: bigint; prefix: number; first: bigint; last: bigint } {
  const [ip, bits] = cidr.split('/');
  const prefix = Number(bits);
  if (!ip || !Number.isInteger(prefix) || prefix < 32 || prefix > 124)
    throw new TypeError(`not an IPv6 prefix: ${cidr}`);
  const n = ip6ToBig(ip);
  const host = (1n << BigInt(128 - prefix)) - 1n;
  const network = n & (MAX128 ^ host);
  if (network !== n) throw new TypeError(`${cidr} is not a prefix (try ${bigToIp6(network)}/${String(prefix)})`);
  return { network, prefix, first: network + 1n, last: network | host };
}

/** An address of the prefix other than the subnet-router anycast address. */
export function inSubnet6(prefix: string, ip: string): boolean {
  const s = parseCidr6(prefix);
  const n = ip6ToBig(ip);
  return n >= s.first && n <= s.last;
}

// ---------------------------------------------------------------- directory objects (CN=DHCP)

const ipv4 = z.ipv4();
/** IPv6, stored in the RFC 5952 form so equal addresses compare equal */
const ipv6 = z.ipv6().transform((a) => bigToIp6(ip6ToBig(a)));
const cidr6 = z
  .string()
  .refine((c) => {
    try {
      parseCidr6(c);
      return true;
    } catch {
      return false;
    }
  }, 'an IPv6 prefix of /32 to /124, e.g. fd00:10::/64')
  .transform((c) => `${bigToIp6(parseCidr6(c).network)}/${String(parseCidr6(c).prefix)}`);
/** DHCPv6 client id: hex octets, colon-separated */
const duid = z
  .string()
  .regex(/^([0-9A-Fa-f]{2}:){2,129}[0-9A-Fa-f]{2}$/, 'a DUID in hex, e.g. 00:01:00:01:2c:5e:aa:bb:00:11:22:33:44:55')
  .transform((d) => d.toLowerCase());
const cidr = z.string().refine((c) => {
  try {
    parseCidr(c);
    return true;
  } catch {
    return false;
  }
}, 'an IPv4 network address with a prefix of /8 to /30, e.g. 10.0.0.0/24');
const mac = z
  .string()
  .regex(/^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/, 'a MAC address, e.g. 00:11:22:33:44:55')
  .transform((m) => m.toLowerCase().replace(/-/g, ':'));
const hostLabel = z.string().regex(/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/, 'a host name (one label)');
const ifname = z.string().regex(/^[A-Za-z0-9._-]{1,15}$/, 'an interface name');
const domainName = z.string().regex(/^(?=.{1,253}$)([A-Za-z0-9-]{1,63}\.)*[A-Za-z0-9-]{1,63}$/, 'a DNS domain');
const name = z.string().min(1).max(64);
const comment = z.string().max(256).nullable().default(null);

export const dhcpServer = z.strictObject({ nodeGuid: z.uuid(), host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/) });
export const dhcpService = z.strictObject({
  name,
  /** one server, or two for an HA pair */
  servers: z.array(dhcpServer).min(1).max(2),
  mode: z.enum(['hot-standby', 'load-balancing']).default('hot-standby'),
  interfaces: z.array(ifname).min(1).max(8),
  leaseSeconds: z.number().int().min(300).max(31_536_000).default(86_400),
  comment,
});
export const dhcpPool = z.strictObject({ from: ipv4, to: ipv4 });
export const dhcpSubnet = z
  .strictObject({
    serviceId: z.uuid(),
    cidr,
    pools: z.array(dhcpPool).max(16).default([]),
    routers: z.array(ipv4).max(4).default([]),
    dnsServers: z.array(ipv4).max(4).default([]),
    domainName: domainName.nullable().default(null),
    ntpServers: z.array(ipv4).max(4).default([]),
    comment,
  })
  .superRefine((s, ctx) => {
    let net: ReturnType<typeof parseCidr>;
    try {
      net = parseCidr(s.cidr);
    } catch {
      return;
    }
    s.pools.forEach((p, i) => {
      const a = ipToInt(p.from);
      const b = ipToInt(p.to);
      if (a > b || a < net.first || b > net.last)
        ctx.addIssue({ code: 'custom', path: ['pools', i], message: `a range inside ${s.cidr}, from ≤ to` });
    });
    s.routers.forEach((r, i) => {
      if (!inSubnet(s.cidr, r)) ctx.addIssue({ code: 'custom', path: ['routers', i], message: `inside ${s.cidr}` });
    });
  });
export const dhcpReservation = z.strictObject({
  subnetId: z.uuid(),
  mac,
  ip: ipv4,
  hostname: hostLabel.nullable().default(null),
  comment,
});
/** An IPv6 subnet (kind dhcp.subnet6). Routers come from router advertisements, not DHCPv6. */
export const dhcpSubnet6 = z
  .strictObject({
    serviceId: z.uuid(),
    prefix: cidr6,
    /** the link Kea serves it on (direct clients); null: the service's only interface */
    interface: ifname.nullable().default(null),
    pools: z
      .array(z.strictObject({ from: ipv6, to: ipv6 }))
      .max(16)
      .default([]),
    dnsServers: z.array(ipv6).max(4).default([]),
    domainSearch: z.array(domainName).max(6).default([]),
    comment,
  })
  .superRefine((s, ctx) => {
    let net: ReturnType<typeof parseCidr6>;
    try {
      net = parseCidr6(s.prefix);
    } catch {
      return;
    }
    s.pools.forEach((p, i) => {
      const a = ip6ToBig(p.from);
      const b = ip6ToBig(p.to);
      if (a > b || a < net.first || b > net.last)
        ctx.addIssue({ code: 'custom', path: ['pools', i], message: `a range inside ${s.prefix}, from ≤ to` });
    });
  });
/** An IPv6 reservation (kind dhcp.reservation6): by DUID, or by MAC address where Kea can learn it. */
export const dhcpReservation6 = z
  .strictObject({
    subnetId: z.uuid(),
    duid: duid.nullable().default(null),
    mac: mac.nullable().default(null),
    ip: ipv6,
    hostname: hostLabel.nullable().default(null),
    comment,
  })
  .refine((r) => (r.duid === null) !== (r.mac === null), {
    message: 'a DUID or a MAC address (one of them)',
    path: ['duid'],
  });
export type DhcpSubnet6 = z.output<typeof dhcpSubnet6>;
export type DhcpReservation6 = z.output<typeof dhcpReservation6>;
export type DhcpService = z.output<typeof dhcpService>;
export type DhcpSubnet = z.output<typeof dhcpSubnet>;
export type DhcpReservation = z.output<typeof dhcpReservation>;

/** A stable Kea subnet id (1 … 2^31-1) from the subnet's object id. */
export function keaSubnetId(uuid: string): number {
  const h = parseInt(uuid.replace(/-/g, '').slice(0, 8), 16);
  return (h % 2_147_483_646) + 1;
}

// ---------------------------------------------------------------- what the agent renders

export const keaApplyArgs = z.strictObject({
  /** false: this node serves no DHCP (Kea stopped) */
  enabled: z.boolean(),
  interfaces: z.array(ifname).max(8).default([]),
  leaseSeconds: z.number().int().min(300).max(31_536_000).default(86_400),
  /** server-wide options (DHCP policies) */
  globals: z
    .strictObject({
      dnsServers: z.array(ipv4).max(4).default([]),
      domainName: domainName.nullable().default(null),
      ntpServers: z.array(ipv4).max(4).default([]),
    })
    .default({ dnsServers: [], domainName: null, ntpServers: [] }),
  subnets: z
    .array(
      z.strictObject({
        id: z.number().int().min(1).max(2_147_483_647),
        cidr,
        pools: z.array(dhcpPool).max(16),
        routers: z.array(ipv4).max(4),
        dnsServers: z.array(ipv4).max(4),
        domainName: domainName.nullable(),
        ntpServers: z.array(ipv4).max(4),
        reservations: z.array(z.strictObject({ mac, ip: ipv4, hostname: hostLabel.nullable() })).max(10_000),
      }),
    )
    .max(512)
    .default([]),
  subnets6: z
    .array(
      z.strictObject({
        id: z.number().int().min(1).max(2_147_483_647),
        prefix: cidr6,
        interface: ifname,
        pools: z.array(z.strictObject({ from: ipv6, to: ipv6 })).max(16),
        dnsServers: z.array(ipv6).max(4),
        domainSearch: z.array(domainName).max(6),
        reservations: z
          .array(
            z.strictObject({ duid: duid.nullable(), mac: mac.nullable(), ip: ipv6, hostname: hostLabel.nullable() }),
          )
          .max(10_000),
      }),
    )
    .max(512)
    .default([]),
  ha: z
    .strictObject({
      mode: z.enum(['hot-standby', 'load-balancing']),
      thisServer: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
      peers: z
        .array(
          z.strictObject({
            name: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
            address: ipv4,
            role: z.enum(['primary', 'standby', 'secondary']),
          }),
        )
        .length(2),
    })
    .nullable()
    .default(null),
});
export type KeaApplyArgs = z.output<typeof keaApplyArgs>;

export interface KeaPaths {
  hooksDir: string;
  leaseFile: string;
  controlSocket: string;
  /** node certificate and CA bundle for the HA channel (TLS between the peers) */
  tls: { cert: string; key: string; ca: string } | null;
}

/** HA listener ports between the two peers (Kea's dedicated HA HTTP listener, one per daemon). */
export const KEA_HA_PORT = 8000;
export const KEA_HA_PORT6 = 8001;

type Option = { name: string; data: string };
const options = (o: {
  routers?: string[];
  dnsServers: string[];
  domainName: string | null;
  ntpServers: string[];
}): Option[] => [
  ...(o.routers?.length ? [{ name: 'routers', data: o.routers.join(', ') }] : []),
  ...(o.dnsServers.length ? [{ name: 'domain-name-servers', data: o.dnsServers.join(', ') }] : []),
  ...(o.domainName ? [{ name: 'domain-name', data: o.domainName }] : []),
  ...(o.ntpServers.length ? [{ name: 'ntp-servers', data: o.ntpServers.join(', ') }] : []),
];

/** lease_cmds, and the HA hook for a pair (mutual TLS only). */
function hooksFor(a: KeaApplyArgs, p: KeaPaths, port: number): Record<string, unknown>[] {
  const hooks: Record<string, unknown>[] = [{ library: `${p.hooksDir}/libdhcp_lease_cmds.so` }];
  if (!a.ha) return hooks;
  const self = a.ha.peers.find((x) => x.name === a.ha?.thisServer);
  if (!self) throw new TypeError('ha.thisServer is not one of the peers');
  // the HA channel carries lease updates: mutual TLS only
  const tls = p.tls;
  if (!tls) throw new TypeError('an HA pair needs TLS (node certificates)');
  hooks.push({
    library: `${p.hooksDir}/libdhcp_ha.so`,
    parameters: {
      'high-availability': [
        {
          'this-server-name': a.ha.thisServer,
          mode: a.ha.mode,
          'heartbeat-delay': 10_000,
          'max-response-delay': 60_000,
          'max-ack-delay': 5000,
          'max-unacked-clients': 5,
          'multi-threading': {
            'enable-multi-threading': true,
            'http-dedicated-listener': true,
            'http-listener-threads': 2,
            'http-client-threads': 2,
          },
          'trust-anchor': tls.ca,
          'cert-file': tls.cert,
          'key-file': tls.key,
          'require-client-certs': true,
          peers: a.ha.peers.map((x) => ({
            name: x.name,
            url: `https://${x.address}:${String(port)}/`,
            role: x.role,
            'auto-failover': true,
          })),
        },
      ],
    },
  });
  return hooks;
}

const multiThreading = { 'enable-multi-threading': true, 'thread-pool-size': 4, 'packet-queue-size': 64 };

/** The Dhcp4 configuration of this node. */
export function renderKea4(a: KeaApplyArgs, p: KeaPaths): Record<string, unknown> {
  const hooks = hooksFor(a, p, KEA_HA_PORT);
  return {
    Dhcp4: {
      'interfaces-config': { interfaces: a.interfaces, 'dhcp-socket-type': 'raw' },
      'control-socket': { 'socket-type': 'unix', 'socket-name': p.controlSocket },
      'lease-database': { type: 'memfile', persist: true, name: p.leaseFile, 'lfc-interval': 3600 },
      'valid-lifetime': a.leaseSeconds,
      'renew-timer': Math.floor(a.leaseSeconds / 2),
      'rebind-timer': Math.floor((a.leaseSeconds * 7) / 8),
      ...(a.ha ? { 'multi-threading': multiThreading } : {}),
      'hooks-libraries': hooks,
      'option-data': options({ ...a.globals }),
      subnet4: a.subnets
        .slice()
        .sort((x, y) => x.id - y.id)
        .map((s) => ({
          id: s.id,
          subnet: s.cidr,
          pools: s.pools.map((x) => ({ pool: `${x.from} - ${x.to}` })),
          'option-data': options(s),
          reservations: s.reservations
            .slice()
            .sort((x, y) => ipToInt(x.ip) - ipToInt(y.ip))
            .map((r) => ({ 'hw-address': r.mac, 'ip-address': r.ip, ...(r.hostname ? { hostname: r.hostname } : {}) })),
        })),
      loggers: [{ name: 'kea-dhcp4', output_options: [{ output: 'syslog' }], severity: 'INFO' }],
    },
  };
}

/** The Dhcp6 configuration of this node (lifetimes after RFC 8415: T1 = 0.5, T2 = 0.8 of the preferred). */
export function renderKea6(a: KeaApplyArgs, p: KeaPaths): Record<string, unknown> {
  const preferred = Math.floor((a.leaseSeconds * 3) / 4);
  const options6 = (o: { dnsServers: string[]; domainSearch: string[] }): Option[] => [
    ...(o.dnsServers.length ? [{ name: 'dns-servers', data: o.dnsServers.join(', ') }] : []),
    ...(o.domainSearch.length ? [{ name: 'domain-search', data: o.domainSearch.join(', ') }] : []),
  ];
  return {
    Dhcp6: {
      'interfaces-config': { interfaces: a.interfaces },
      'control-socket': { 'socket-type': 'unix', 'socket-name': p.controlSocket },
      'lease-database': { type: 'memfile', persist: true, name: p.leaseFile, 'lfc-interval': 3600 },
      'valid-lifetime': a.leaseSeconds,
      'preferred-lifetime': preferred,
      'renew-timer': Math.floor(preferred / 2),
      'rebind-timer': Math.floor((preferred * 4) / 5),
      ...(a.ha ? { 'multi-threading': multiThreading } : {}),
      'hooks-libraries': hooksFor(a, p, KEA_HA_PORT6),
      subnet6: a.subnets6
        .slice()
        .sort((x, y) => x.id - y.id)
        .map((s) => ({
          id: s.id,
          subnet: s.prefix,
          interface: s.interface,
          pools: s.pools.map((x) => ({ pool: `${x.from} - ${x.to}` })),
          'option-data': options6(s),
          reservations: s.reservations
            .slice()
            .sort((x, y) => (ip6ToBig(x.ip) < ip6ToBig(y.ip) ? -1 : 1))
            .map((r) => ({
              ...(r.duid ? { duid: r.duid } : { 'hw-address': r.mac }),
              'ip-addresses': [r.ip],
              ...(r.hostname ? { hostname: r.hostname } : {}),
            })),
        })),
      loggers: [{ name: 'kea-dhcp6', output_options: [{ output: 'syslog' }], severity: 'INFO' }],
    },
  };
}
