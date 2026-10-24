// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { job, nodeInfo, type Job } from '@opendc/shared/api';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Table.Tr>
      <Table.Th scope="row" w="40%">
        {label}
      </Table.Th>
      <Table.Td>{value}</Table.Td>
    </Table.Tr>
  );
}

function NodeCard() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['node'], queryFn: () => api('/node', { schema: nodeInfo }) });
  const [events, setEvents] = useState<string[]>([]);
  const [jobState, setJobState] = useState<Job | null>(null);
  const start = useMutation({
    mutationFn: () => api('/jobs/node-info', { method: 'POST', schema: job }),
    onSuccess: (j) => {
      setJobState(j);
      setEvents([]);
      const es = new EventSource(`/api/v1/jobs/${j.id}/events`);
      const onEvent = (e: MessageEvent<string>): void => {
        setEvents((x) => [...x, `${e.type}: ${e.data}`]);
        if (e.type !== 'progress') {
          es.close();
          void api(`/jobs/${j.id}`, { schema: job }).then(setJobState);
        }
      };
      for (const kind of ['progress', 'done', 'failed']) es.addEventListener(kind, onEvent as EventListener);
    },
  });

  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  const n = q.data;
  const d = Math.floor(n.uptimeSec / 86400);
  const h = Math.floor((n.uptimeSec % 86400) / 3600);
  return (
    <Stack gap="xs">
      <Table>
        <Table.Tbody>
          <Row label={t('home.fqdn')} value={n.fqdn} />
          <Row label={t('home.role')} value={t(`role.${n.role}`)} />
          <Row label={t('home.os')} value={`${n.os.prettyName} (${n.kernel})`} />
          <Row label={t('home.samba')} value={n.samba ?? t('home.samba-none')} />
          <Row label={t('home.uptime')} value={t('units.days-hours', { d, h })} />
          <Row label={t('home.platform')} value={n.platformVersion} />
        </Table.Tbody>
      </Table>
      <Group>
        <Button size="xs" variant="light" onClick={() => start.mutate()} loading={start.isPending}>
          {t('home.run-job')}
        </Button>
        {jobState ? (
          <Text size="sm">{t('home.job-status', { id: jobState.id.slice(0, 8), status: jobState.status })}</Text>
        ) : null}
      </Group>
      {start.isError ? <ErrorView error={start.error} /> : null}
      {events.length ? (
        <Text component="pre" size="xs" ff="monospace">
          {events.join('\n')}
        </Text>
      ) : null}
    </Stack>
  );
}

export default function Home() {
  const { t } = useTranslation();
  const { session, permissions, has } = useSession();
  if (!session) return null;
  return (
    <Stack>
      <Title order={2}>{t('home.title')}</Title>
      <Alert variant="light">{t('home.placeholder')}</Alert>
      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <Card withBorder>
          <Title order={3} size="h5" mb="xs">
            {t('home.user')}
          </Title>
          <Text fw={500}>{session.user.displayName ?? session.user.username}</Text>
          <Text size="sm" c="dimmed">
            {session.user.dn}
          </Text>
          <Text size="xs" c="dimmed" ff="monospace">
            {session.user.sid}
          </Text>
        </Card>
        <Card withBorder>
          <Title order={3} size="h5" mb="xs">
            {t('home.node')}
          </Title>
          {has('core.node.info') ? <NodeCard /> : <Text size="sm">{t('home.node-hidden')}</Text>}
        </Card>
      </SimpleGrid>
      <Card withBorder>
        <Title order={3} size="h5" mb="xs">
          {t('home.permissions')}
        </Title>
        <Table>
          <Table.Tbody>
            {permissions.map((p) => (
              <Table.Tr key={p.permission}>
                <Table.Td ff="monospace">{p.permission}</Table.Td>
                <Table.Td>
                  {p.scopes
                    .map((s) =>
                      s.kind === 'domain'
                        ? t('home.scope-domain')
                        : s.kind === 'subtree'
                          ? t('home.scope-subtree', { dn: s.dn })
                          : t('home.scope-node', { node: s.nodeGuid }),
                    )
                    .join(', ')}
                </Table.Td>
                <Table.Td>{p.tier0 ? <Badge color="red">{t('home.tier0')}</Badge> : null}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
    </Stack>
  );
}
