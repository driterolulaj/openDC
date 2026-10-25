// SPDX-License-Identifier: AGPL-3.0-only
/** DNS (ROADMAP Phase 3): zones, records, and the diagnostics of the records domain controllers need. */
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Loader,
  NumberInput,
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
import { dnsDiagnostics, dnsRecords, dnsRepairResult, dnsZones, recordAdded } from '@opendc/shared/api';
import { recordTypes, sambaToolData, type RecordData, type RecordType } from '@opendc/shared/dns';
import { z } from 'zod';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';

type Fields = Record<string, string>;

/** The form fields of each record type, and how they become a record. */
const FIELDS: Record<RecordType, string[]> = {
  A: ['address'],
  AAAA: ['address'],
  CNAME: ['target'],
  NS: ['target'],
  PTR: ['target'],
  MX: ['exchange', 'preference'],
  SRV: ['target', 'port', 'priority', 'weight'],
  TXT: ['text'],
};
const NUMERIC = new Set(['preference', 'port', 'priority', 'weight']);

function toRecord(type: RecordType, f: Fields): RecordData {
  const n = (k: string): number => Number(f[k] ?? 0);
  switch (type) {
    case 'A':
    case 'AAAA':
      return { type, address: f.address ?? '' };
    case 'CNAME':
    case 'NS':
    case 'PTR':
      return { type, target: f.target ?? '' };
    case 'MX':
      return { type, exchange: f.exchange ?? '', preference: n('preference') };
    case 'SRV':
      return { type, target: f.target ?? '', port: n('port'), priority: n('priority'), weight: n('weight') };
    case 'TXT':
      return { type, strings: [f.text ?? ''] };
  }
}

function AddRecord({ zone }: { zone: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [type, setType] = useState<RecordType>('A');
  const [fields, setFields] = useState<Fields>({});
  const [ptr, setPtr] = useState(true);
  const add = useMutation({
    mutationFn: () =>
      api(`/dns/zones/${zone}/records`, {
        method: 'POST',
        body: { name: name || '@', record: toRecord(type, fields), ptr: type === 'A' && ptr },
        schema: recordAdded,
      }),
    onSuccess: async () => {
      setName('');
      setFields({});
      await qc.invalidateQueries({ queryKey: ['dns-records', zone] });
    },
  });
  return (
    <Stack gap="xs">
      <Title order={4}>{t('dns.add')}</Title>
      {add.error ? <ErrorView error={add.error} /> : null}
      <SimpleGrid cols={{ base: 1, sm: 3 }}>
        <TextInput
          label={t('dns.name')}
          description={t('dns.name-hint', { zone })}
          value={name}
          onChange={(e) => setName(e.currentTarget.value.trim())}
        />
        <Select
          label={t('dns.type')}
          data={[...recordTypes]}
          value={type}
          allowDeselect={false}
          onChange={(v) => {
            setType(v ?? 'A');
            setFields({});
          }}
        />
        {FIELDS[type].map((k) =>
          NUMERIC.has(k) ? (
            <NumberInput
              key={k}
              label={t(`dns.f-${k}`)}
              min={0}
              max={65535}
              value={fields[k] ?? ''}
              onChange={(v) => setFields((x) => ({ ...x, [k]: String(v) }))}
            />
          ) : (
            <TextInput
              key={k}
              label={t(`dns.f-${k}`)}
              value={fields[k] ?? ''}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setFields((x) => ({ ...x, [k]: v }));
              }}
            />
          ),
        )}
      </SimpleGrid>
      <Group justify="space-between">
        {type === 'A' ? (
          <Checkbox label={t('dns.with-ptr')} checked={ptr} onChange={(e) => setPtr(e.currentTarget.checked)} />
        ) : (
          <span />
        )}
        <Button loading={add.isPending} onClick={() => add.mutate()}>
          {t('dns.add')}
        </Button>
      </Group>
    </Stack>
  );
}

function Records({ zone }: { zone: string }) {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['dns-records', zone],
    queryFn: () => api(`/dns/zones/${zone}/records`, { schema: dnsRecords }),
  });
  const del = useMutation({
    mutationFn: (r: { name: string; record: RecordData }) =>
      api(`/dns/zones/${zone}/records`, { method: 'DELETE', body: r, schema: z.object({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dns-records', zone] }),
  });
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  const canWrite = has('dns.records.write');
  return (
    <Stack>
      {canWrite ? <AddRecord zone={zone} /> : null}
      {del.error ? <ErrorView error={del.error} /> : null}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('dns.name')}</Table.Th>
            <Table.Th>{t('dns.type')}</Table.Th>
            <Table.Th>{t('dns.data')}</Table.Th>
            <Table.Th>{t('dns.ttl')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {q.data.records.map((r, i) => (
            <Table.Tr key={`${r.name}-${String(i)}`}>
              <Table.Td ff="monospace">
                {r.name}{' '}
                {r.protected ? (
                  <Badge size="xs" variant="light" color="orange">
                    {t('dns.dc-record')}
                  </Badge>
                ) : null}
                {r.dynamic ? (
                  <Badge size="xs" variant="light">
                    {t('dns.dynamic')}
                  </Badge>
                ) : null}
              </Table.Td>
              <Table.Td>{r.record.type}</Table.Td>
              <Table.Td ff="monospace" fz="sm">
                {r.record.type === 'SOA'
                  ? `${r.record.primary} ${r.record.admin} (${String(r.record.serial)})`
                  : sambaToolData(r.record)}
              </Table.Td>
              <Table.Td>{r.ttl}</Table.Td>
              <Table.Td>
                {r.record.type !== 'SOA' && canWrite ? (
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    loading={del.isPending && del.variables.name === r.name}
                    onClick={() => del.mutate({ name: r.name, record: r.record as RecordData })}
                  >
                    {t('dir.delete')}
                  </Button>
                ) : null}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Stack>
  );
}

function Diagnostics() {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['dns-diagnostics'],
    queryFn: () => api('/dns/diagnostics', { schema: dnsDiagnostics }),
  });
  const repair = useMutation({
    mutationFn: (records: { name: string; record: RecordData }[]) =>
      api('/dns/diagnostics/repair', { method: 'POST', body: { records }, schema: dnsRepairResult }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['dns-diagnostics'] }),
  });
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  const failed = q.data.checks.filter((c) => c.kind === 'record' && c.status === 'fail' && c.record);
  const passed = q.data.checks.filter((c) => c.status === 'pass').length;
  return (
    <Stack>
      <Text>
        {t('dns.diag-servers', { servers: q.data.servers.map((s) => `${s.dc} (${s.address ?? '?'})`).join(', ') })}
      </Text>
      {q.data.summary.length === 0 ? (
        <Alert color="green">{t('dns.diag-ok', { count: passed })}</Alert>
      ) : (
        q.data.summary.map((s, i) => (
          <Alert key={String(i)} color={s.status === 'fail' ? 'red' : 'yellow'} title={s.message}>
            {s.fix}
          </Alert>
        ))
      )}
      {repair.error ? <ErrorView error={repair.error} /> : null}
      {repair.data ? (
        <Alert color="blue">
          {t('dns.repaired', { count: repair.data.added.length, failed: repair.data.failed.length })}
        </Alert>
      ) : null}
      <Group>
        <Button variant="default" onClick={() => void q.refetch()} loading={q.isFetching}>
          {t('dns.check-again')}
        </Button>
        {failed.length && has('dns.records.write') ? (
          <Button
            color="orange"
            loading={repair.isPending}
            onClick={() => repair.mutate(failed.map((c) => ({ name: c.name, record: c.record as RecordData })))}
          >
            {t('dns.repair', { count: failed.length })}
          </Button>
        ) : null}
      </Group>
    </Stack>
  );
}

export default function Dns() {
  const { t } = useTranslation();
  const { has } = useSession();
  const zones = useQuery({ queryKey: ['dns-zones'], queryFn: () => api('/dns/zones', { schema: dnsZones }) });
  const [zone, setZone] = useState<string | null>(null);
  if (!has('dns.zones.read')) return <Text>{t('error.forbidden')}</Text>;
  const current = zone ?? zones.data?.zones.find((z) => !z.reverse)?.name ?? null;
  return (
    <Stack>
      <Title order={2}>{t('dns.title')}</Title>
      <Tabs defaultValue="zones">
        <Tabs.List>
          <Tabs.Tab value="zones">{t('dns.zones')}</Tabs.Tab>
          <Tabs.Tab value="diagnostics">{t('dns.diagnostics')}</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="zones" pt="md">
          {zones.isPending ? <Loader size="sm" aria-label={t('app.loading')} /> : null}
          {zones.isError ? <ErrorView error={zones.error} /> : null}
          {zones.data ? (
            <Stack>
              <Select
                label={t('dns.zone')}
                data={zones.data.zones.map((z) => ({
                  value: z.name,
                  label: `${z.name}${z.ad ? ` (${t('dns.ad-zone')})` : ''}`,
                }))}
                value={current}
                allowDeselect={false}
                onChange={setZone}
                maw={480}
              />
              {current ? <Records zone={current} /> : null}
            </Stack>
          ) : null}
        </Tabs.Panel>
        <Tabs.Panel value="diagnostics" pt="md">
          <Diagnostics />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
