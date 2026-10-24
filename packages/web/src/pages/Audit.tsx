// SPDX-License-Identifier: AGPL-3.0-only
import { Badge, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { auditList } from '@opendc/shared/api';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';

const COLORS: Record<string, string> = { success: 'green', failure: 'orange', denied: 'red' };

export default function Audit() {
  const { t, i18n } = useTranslation();
  const { has } = useSession();
  const allowed = has('core.audit.read');
  const q = useQuery({
    queryKey: ['audit'],
    queryFn: () => api('/audit?limit=100', { schema: auditList }),
    enabled: allowed,
  });
  if (!allowed) return <Text>{t('error.forbidden')}</Text>;
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'medium' });
  return (
    <Stack>
      <Title order={2}>{t('audit.title')}</Title>
      {q.data.entries.length === 0 ? (
        <Text>{t('audit.empty')}</Text>
      ) : (
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('audit.time')}</Table.Th>
              <Table.Th>{t('audit.actor')}</Table.Th>
              <Table.Th>{t('audit.action')}</Table.Th>
              <Table.Th>{t('audit.result')}</Table.Th>
              <Table.Th>{t('audit.target')}</Table.Th>
              <Table.Th>{t('audit.source')}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {q.data.entries.map((e) => (
              <Table.Tr key={`${e.originNodeId}:${String(e.seq)}`}>
                <Table.Td>{fmt.format(new Date(e.ts))}</Table.Td>
                <Table.Td>{e.actor}</Table.Td>
                <Table.Td ff="monospace">{e.action}</Table.Td>
                <Table.Td>
                  <Badge color={COLORS[e.result] ?? 'gray'} variant="light">
                    {e.result}
                  </Badge>
                </Table.Td>
                <Table.Td>{e.targetDn ?? ''}</Table.Td>
                <Table.Td>{e.sourceIp ?? ''}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Stack>
  );
}
