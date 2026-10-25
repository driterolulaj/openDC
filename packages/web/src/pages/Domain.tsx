// SPDX-License-Identifier: AGPL-3.0-only
/** Domain overview: identity, functional levels, domain controllers, FSMO role holders. */
import { Badge, Card, Group, Loader, SimpleGrid, Stack, Table, Text, Title } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { domainInfo } from '@opendc/shared/api';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { FsmoCard } from './Fsmo.tsx';

export default function Domain() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['domain-info'], queryFn: () => api('/directory/info', { schema: domainInfo }) });
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  const d = q.data;
  const row = (label: string, value: string) => (
    <Table.Tr key={label}>
      <Table.Th scope="row" w="40%">
        {label}
      </Table.Th>
      <Table.Td>{value}</Table.Td>
    </Table.Tr>
  );
  return (
    <Stack>
      <Title order={2}>{t('domain.title')}</Title>
      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Card withBorder>
          <Title order={3} size="h5" mb="xs">
            {t('domain.identity')}
          </Title>
          <Table>
            <Table.Tbody>
              {row(t('domain.name'), d.domain)}
              {row(t('domain.netbios'), d.netbios ?? '—')}
              {row(t('domain.dn'), d.domainDn)}
              {row(t('domain.sid'), d.domainSid)}
              {row(t('domain.forest-level'), d.forestLevel ?? '—')}
              {row(t('domain.domain-level'), d.domainLevel ?? '—')}
              {row(t('domain.id-base'), String(d.idBase))}
            </Table.Tbody>
          </Table>
        </Card>
        <Card withBorder>
          <Title order={3} size="h5" mb="xs">
            {t('domain.dcs')}
          </Title>
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('domain.dc-name')}</Table.Th>
                <Table.Th>{t('domain.dc-os')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {d.dcs.map((dc) => (
                <Table.Tr key={dc.guid}>
                  <Table.Td>
                    <Group gap={6}>
                      <Text>{dc.dnsHostName ?? dc.name}</Text>
                      {dc.readOnly ? <Badge size="sm">{t('domain.rodc')}</Badge> : null}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{dc.os ?? '—'}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      </SimpleGrid>
      <FsmoCard info={d} />
    </Stack>
  );
}
