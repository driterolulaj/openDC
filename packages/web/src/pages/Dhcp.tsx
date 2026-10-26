// SPDX-License-Identifier: AGPL-3.0-only
/** DHCP (ROADMAP Phase 3): services, subnets, reservations, and this node's leases. */
import { useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CloseButton,
  Group,
  Loader,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';
import { ObjectPicker } from '../components/directory.tsx';

const service = z.object({
  id: z.string(),
  name: z.string(),
  servers: z.array(z.object({ nodeGuid: z.string(), host: z.string() })),
  mode: z.string(),
  interfaces: z.array(z.string()),
  leaseSeconds: z.number(),
});
const subnet = z.object({
  id: z.string(),
  serviceId: z.string(),
  cidr: z.string(),
  pools: z.array(z.object({ from: z.string(), to: z.string() })),
  routers: z.array(z.string()),
  dnsServers: z.array(z.string()),
});
const reservation = z.object({
  id: z.string(),
  subnetId: z.string(),
  mac: z.string(),
  ip: z.string(),
  hostname: z.string().nullable(),
});
const overview = z.object({ services: z.array(service), subnets: z.array(subnet), reservations: z.array(reservation) });
const leases = z.object({
  leases: z.array(z.object({ ip: z.string(), mac: z.string(), hostname: z.string().nullable(), expires: z.string() })),
});
type Overview = z.infer<typeof overview>;
const csv = (s: string): string[] => s.split(/[\s,]+/).filter(Boolean);

function useDhcp() {
  return useQuery({ queryKey: ['dhcp'], queryFn: () => api('/dhcp', { schema: overview }) });
}

function Services({ data, canWrite }: { data: Overview; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [servers, setServers] = useState<{ guid: string; name: string }[]>([]);
  const [interfaces, setInterfaces] = useState('eth0');
  const [mode, setMode] = useState('hot-standby');
  const create = useMutation({
    mutationFn: () =>
      api('/dhcp/services', {
        method: 'POST',
        body: {
          name,
          servers: servers.map((s) => ({ nodeGuid: s.guid, host: s.name })),
          mode,
          interfaces: csv(interfaces),
        },
        schema: z.object({ id: z.string() }),
      }),
    onSuccess: async () => {
      setName('');
      setServers([]);
      await qc.invalidateQueries({ queryKey: ['dhcp'] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/dhcp/services/${id}`, { method: 'DELETE', schema: z.object({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dhcp'] }),
  });
  return (
    <Stack>
      {del.error ? <ErrorView error={del.error} /> : null}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('dhcp.name')}</Table.Th>
            <Table.Th>{t('dhcp.servers')}</Table.Th>
            <Table.Th>{t('dhcp.interfaces')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {data.services.map((s) => (
            <Table.Tr key={s.id}>
              <Table.Td>{s.name}</Table.Td>
              <Table.Td>
                {s.servers.map((x) => x.host).join(', ')}{' '}
                {s.servers.length === 2 ? <Badge variant="light">{t(`dhcp.mode-${s.mode}`)}</Badge> : null}
              </Table.Td>
              <Table.Td>{s.interfaces.join(', ')}</Table.Td>
              <Table.Td>
                {canWrite ? (
                  <Button size="xs" variant="subtle" color="red" onClick={() => del.mutate(s.id)}>
                    {t('dir.delete')}
                  </Button>
                ) : null}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {canWrite ? (
        <Card withBorder>
          <Stack>
            <Title order={4}>{t('dhcp.new-service')}</Title>
            {create.error ? <ErrorView error={create.error} /> : null}
            <SimpleGrid cols={{ base: 1, sm: 2 }}>
              <TextInput label={t('dhcp.name')} value={name} onChange={(e) => setName(e.currentTarget.value)} />
              <TextInput
                label={t('dhcp.interfaces')}
                description={t('dhcp.interfaces-hint')}
                value={interfaces}
                onChange={(e) => setInterfaces(e.currentTarget.value)}
              />
            </SimpleGrid>
            <ObjectPicker
              label={t('dhcp.servers')}
              types="computer"
              exclude={servers.map((s) => s.guid)}
              onPick={(c) => setServers((x) => (x.length < 2 ? [...x, { guid: c.guid, name: c.name }] : x))}
            />
            <Group gap={4}>
              {servers.map((s) => (
                <Badge
                  key={s.guid}
                  variant="light"
                  rightSection={
                    <CloseButton
                      size="xs"
                      aria-label={t('pol.remove-group', { name: s.name })}
                      onClick={() => setServers((x) => x.filter((y) => y.guid !== s.guid))}
                    />
                  }
                >
                  {s.name}
                </Badge>
              ))}
            </Group>
            {servers.length === 2 ? (
              <SegmentedControl
                aria-label={t('dhcp.ha-mode')}
                value={mode}
                onChange={setMode}
                data={[
                  { value: 'hot-standby', label: t('dhcp.mode-hot-standby') },
                  { value: 'load-balancing', label: t('dhcp.mode-load-balancing') },
                ]}
              />
            ) : null}
            <Group justify="flex-end">
              <Button disabled={!name || !servers.length} loading={create.isPending} onClick={() => create.mutate()}>
                {t('dhcp.create')}
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}

function Reservations({ data, subnetId, canWrite }: { data: Overview; subnetId: string; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mac, setMac] = useState('');
  const [ip, setIp] = useState('');
  const [hostname, setHostname] = useState('');
  const [edit, setEdit] = useState<{ id: string; ip: string } | null>(null);
  const done = async () => {
    setMac('');
    setIp('');
    setHostname('');
    setEdit(null);
    await qc.invalidateQueries({ queryKey: ['dhcp'] });
  };
  const add = useMutation({
    mutationFn: () =>
      api('/dhcp/reservations', {
        method: 'POST',
        body: { subnetId, mac, ip, hostname: hostname || null },
        schema: z.object({ id: z.string() }),
      }),
    onSuccess: done,
  });
  const update = useMutation({
    mutationFn: (r: z.infer<typeof reservation> & { newIp: string }) =>
      api(`/dhcp/reservations/${r.id}`, {
        method: 'PUT',
        body: { subnetId: r.subnetId, mac: r.mac, ip: r.newIp, hostname: r.hostname },
        schema: z.object({}),
      }),
    onSuccess: done,
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/dhcp/reservations/${id}`, { method: 'DELETE', schema: z.object({}) }),
    onSuccess: done,
  });
  const rows = data.reservations.filter((r) => r.subnetId === subnetId);
  const err = add.error ?? update.error ?? del.error;
  return (
    <Stack gap="xs">
      {err ? <ErrorView error={err} /> : null}
      <Table>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('dhcp.ip')}</Table.Th>
            <Table.Th>{t('dhcp.mac')}</Table.Th>
            <Table.Th>{t('dhcp.hostname')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {rows.map((r) => (
            <Table.Tr key={r.id}>
              <Table.Td ff="monospace">
                {edit?.id === r.id ? (
                  <TextInput
                    size="xs"
                    aria-label={t('dhcp.ip')}
                    value={edit.ip}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setEdit({ id: r.id, ip: v });
                    }}
                  />
                ) : (
                  r.ip
                )}
              </Table.Td>
              <Table.Td ff="monospace">{r.mac}</Table.Td>
              <Table.Td>{r.hostname ?? ''}</Table.Td>
              <Table.Td>
                {canWrite ? (
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    {edit?.id === r.id ? (
                      <Button
                        size="xs"
                        loading={update.isPending}
                        onClick={() => update.mutate({ ...r, newIp: edit.ip })}
                      >
                        {t('dir.save')}
                      </Button>
                    ) : (
                      <Button size="xs" variant="subtle" onClick={() => setEdit({ id: r.id, ip: r.ip })}>
                        {t('rbac.edit')}
                      </Button>
                    )}
                    <Button size="xs" variant="subtle" color="red" onClick={() => del.mutate(r.id)}>
                      {t('dir.delete')}
                    </Button>
                  </Group>
                ) : null}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {canWrite ? (
        <Group align="flex-end">
          <TextInput size="xs" label={t('dhcp.mac')} value={mac} onChange={(e) => setMac(e.currentTarget.value)} />
          <TextInput size="xs" label={t('dhcp.ip')} value={ip} onChange={(e) => setIp(e.currentTarget.value)} />
          <TextInput
            size="xs"
            label={t('dhcp.hostname')}
            value={hostname}
            onChange={(e) => setHostname(e.currentTarget.value)}
          />
          <Button size="xs" disabled={!mac || !ip} loading={add.isPending} onClick={() => add.mutate()}>
            {t('dhcp.reserve')}
          </Button>
        </Group>
      ) : null}
    </Stack>
  );
}

function Subnets({ data, canWrite }: { data: Overview; canWrite: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [cidr, setCidr] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [routers, setRouters] = useState('');
  const [dns, setDns] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api('/dhcp/subnets', {
        method: 'POST',
        body: {
          serviceId,
          cidr,
          pools: from && to ? [{ from, to }] : [],
          routers: csv(routers),
          dnsServers: csv(dns),
        },
        schema: z.object({ id: z.string() }),
      }),
    onSuccess: async () => {
      setCidr('');
      setFrom('');
      setTo('');
      await qc.invalidateQueries({ queryKey: ['dhcp'] });
    },
  });
  return (
    <Stack>
      {data.subnets.map((s) => (
        <Card key={s.id} withBorder>
          <Stack gap="xs">
            <Group justify="space-between">
              <Text fw={500} ff="monospace">
                {s.cidr}
              </Text>
              <Text size="sm" c="dimmed">
                {data.services.find((x) => x.id === s.serviceId)?.name ?? s.serviceId}
                {s.pools.length ? ` · ${s.pools.map((p) => `${p.from} – ${p.to}`).join(', ')}` : ''}
                {s.routers.length ? ` · ${t('dhcp.router')} ${s.routers.join(', ')}` : ''}
              </Text>
            </Group>
            <Reservations data={data} subnetId={s.id} canWrite={canWrite} />
          </Stack>
        </Card>
      ))}
      {canWrite && data.services.length ? (
        <Card withBorder>
          <Stack>
            <Title order={4}>{t('dhcp.new-subnet')}</Title>
            {create.error ? <ErrorView error={create.error} /> : null}
            <SimpleGrid cols={{ base: 1, sm: 3 }}>
              <Select
                label={t('dhcp.service')}
                data={data.services.map((s) => ({ value: s.id, label: s.name }))}
                value={serviceId}
                onChange={setServiceId}
              />
              <TextInput
                label={t('dhcp.cidr')}
                placeholder="10.0.0.0/24"
                value={cidr}
                onChange={(e) => setCidr(e.currentTarget.value)}
              />
              <TextInput label={t('dhcp.router')} value={routers} onChange={(e) => setRouters(e.currentTarget.value)} />
              <TextInput label={t('dhcp.pool-from')} value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
              <TextInput label={t('dhcp.pool-to')} value={to} onChange={(e) => setTo(e.currentTarget.value)} />
              <TextInput label={t('dhcp.dns')} value={dns} onChange={(e) => setDns(e.currentTarget.value)} />
            </SimpleGrid>
            <Group justify="flex-end">
              <Button disabled={!serviceId || !cidr} loading={create.isPending} onClick={() => create.mutate()}>
                {t('dhcp.create')}
              </Button>
            </Group>
          </Stack>
        </Card>
      ) : null}
    </Stack>
  );
}

function Leases() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['dhcp-leases'], queryFn: () => api('/dhcp/leases', { schema: leases }) });
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  if (!q.data.leases.length) return <Text c="dimmed">{t('dhcp.no-leases')}</Text>;
  return (
    <Table striped>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>{t('dhcp.ip')}</Table.Th>
          <Table.Th>{t('dhcp.mac')}</Table.Th>
          <Table.Th>{t('dhcp.hostname')}</Table.Th>
          <Table.Th>{t('dhcp.expires')}</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {q.data.leases.map((l) => (
          <Table.Tr key={`${l.ip}-${l.mac}`}>
            <Table.Td ff="monospace">{l.ip}</Table.Td>
            <Table.Td ff="monospace">{l.mac}</Table.Td>
            <Table.Td>{l.hostname ?? ''}</Table.Td>
            <Table.Td>{l.expires.replace('T', ' ').slice(0, 16)}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export default function Dhcp() {
  const { t } = useTranslation();
  const { has } = useSession();
  const q = useDhcp();
  if (!has('dhcp.read')) return <Text>{t('error.forbidden')}</Text>;
  const canWrite = has('dhcp.write');
  return (
    <Stack>
      <Title order={2}>{t('dhcp.title')}</Title>
      {q.isPending ? <Loader size="sm" aria-label={t('app.loading')} /> : null}
      {q.isError ? <ErrorView error={q.error} /> : null}
      {q.data ? (
        <Tabs defaultValue="subnets">
          <Tabs.List>
            <Tabs.Tab value="subnets">{t('dhcp.subnets')}</Tabs.Tab>
            <Tabs.Tab value="services">{t('dhcp.services')}</Tabs.Tab>
            <Tabs.Tab value="leases">{t('dhcp.leases')}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="subnets" pt="md">
            <Subnets data={q.data} canWrite={canWrite} />
          </Tabs.Panel>
          <Tabs.Panel value="services" pt="md">
            <Services data={q.data} canWrite={canWrite} />
          </Tabs.Panel>
          <Tabs.Panel value="leases" pt="md">
            <Leases />
          </Tabs.Panel>
        </Tabs>
      ) : null}
    </Stack>
  );
}
