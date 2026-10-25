// SPDX-License-Identifier: AGPL-3.0-only
/** Certificates (ADR-0007): root and issuing CAs, pending issuer requests, issued certificates, revocation. */
import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Table, Text, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { pkiCert } from '@opendc/shared/pki';
import { z } from 'zod';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';
import { TypedConfirm } from '../components/directory.tsx';

const certView = z.object({
  subject: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  fingerprint: z.string(),
});
const overview = z.object({
  root: certView.extend({ holder: z.string() }).nullable(),
  issuers: z.array(
    certView.extend({
      id: z.string(),
      host: z.string(),
      crlNumber: z.number(),
      crlNextUpdate: z.string().nullable(),
      revoked: z.number(),
    }),
  ),
  requests: z.array(z.object({ nodeGuid: z.string(), host: z.string(), requestedAt: z.string(), state: z.string() })),
  certificates: z.array(pkiCert),
});
const day = (s: string): string => s.slice(0, 10);

export default function Pki() {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['pki'], queryFn: () => api('/pki', { schema: overview }) });
  const [approve, setApprove] = useState<{ nodeGuid: string; host: string } | null>(null);
  const [revoke, setRevoke] = useState<string | null>(null);
  const done = async () => {
    setApprove(null);
    setRevoke(null);
    await qc.invalidateQueries({ queryKey: ['pki'] });
  };
  const approveM = useMutation({
    mutationFn: (r: { nodeGuid: string; confirm: string }) =>
      api(`/pki/requests/${r.nodeGuid}/approve`, {
        method: 'POST',
        body: { confirm: r.confirm },
        schema: z.object({ issuer: z.string(), host: z.string() }),
      }),
    onSuccess: done,
  });
  const revokeM = useMutation({
    mutationFn: (r: { serial: string; confirm: string }) =>
      api(`/pki/certificates/${r.serial}/revoke`, {
        method: 'POST',
        body: { reason: 'unspecified', confirm: r.confirm },
        schema: z.object({ serial: z.string(), issuerId: z.string(), crlUpdated: z.boolean() }),
      }),
    onSuccess: done,
  });
  if (!has('pki.read')) return <Text>{t('error.forbidden')}</Text>;
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  const d = q.data;
  const canManage = has('pki.manage');
  return (
    <Stack>
      <Title order={2}>{t('pki.title')}</Title>
      {d.root ? (
        <Card withBorder>
          <Text fw={500}>{t('pki.root')}</Text>
          <Text size="sm">{d.root.subject}</Text>
          <Text size="sm">{t('pki.valid', { from: day(d.root.notBefore), to: day(d.root.notAfter) })}</Text>
          <Text size="sm">{t('pki.holder', { host: d.root.holder })}</Text>
          <Text size="xs" ff="monospace" c="dimmed">
            {t('pki.fingerprint', { value: d.root.fingerprint })}
          </Text>
        </Card>
      ) : (
        <Alert color="yellow">{t('pki.no-root')}</Alert>
      )}
      {approveM.error ? <ErrorView error={approveM.error} /> : null}
      {d.requests
        .filter((r) => r.state === 'pending')
        .map((r) => (
          <Alert key={r.nodeGuid} color="orange" title={t('pki.request', { host: r.host })}>
            <Group justify="space-between">
              <Text size="sm">{t('pki.request-hint', { at: day(r.requestedAt) })}</Text>
              {canManage ? (
                <Button size="xs" onClick={() => setApprove({ nodeGuid: r.nodeGuid, host: r.host })}>
                  {t('pki.approve')}
                </Button>
              ) : null}
            </Group>
          </Alert>
        ))}
      <Title order={3}>{t('pki.issuers')}</Title>
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('pki.dc')}</Table.Th>
            <Table.Th>{t('pki.valid-to')}</Table.Th>
            <Table.Th>{t('pki.crl')}</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {d.issuers.map((i) => (
            <Table.Tr key={i.id}>
              <Table.Td>{i.host}</Table.Td>
              <Table.Td>{day(i.notAfter)}</Table.Td>
              <Table.Td>
                {t('pki.crl-state', {
                  n: i.crlNumber,
                  revoked: i.revoked,
                  next: i.crlNextUpdate ? day(i.crlNextUpdate) : '–',
                })}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <Title order={3}>{t('pki.certificates')}</Title>
      {revokeM.error ? <ErrorView error={revokeM.error} /> : null}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('pki.subject')}</Table.Th>
            <Table.Th>{t('pki.profile')}</Table.Th>
            <Table.Th>{t('pki.valid-to')}</Table.Th>
            <Table.Th>{t('pki.serial')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {d.certificates.map((c) => (
            <Table.Tr key={c.serial}>
              <Table.Td>{c.subject}</Table.Td>
              <Table.Td>
                <Badge variant="light">{t(`pki.p-${c.profile}`, { defaultValue: c.profile })}</Badge>
              </Table.Td>
              <Table.Td>{day(c.notAfter)}</Table.Td>
              <Table.Td ff="monospace" fz="xs">
                {c.serial}
              </Table.Td>
              <Table.Td>
                {c.revoked ? (
                  <Badge color="red" variant="light">
                    {t('pki.revoked', { at: day(c.revoked.at) })}
                  </Badge>
                ) : canManage ? (
                  <Button size="xs" variant="subtle" color="red" onClick={() => setRevoke(c.serial)}>
                    {t('pki.revoke')}
                  </Button>
                ) : null}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      <TypedConfirm
        opened={approve !== null}
        title={t('pki.approve-title', { host: approve?.host ?? '' })}
        body={t('pki.approve-body')}
        phrase={approve?.host ?? ''}
        confirmLabel={t('pki.approve')}
        busy={approveM.isPending}
        onConfirm={(confirm) => approve && approveM.mutate({ nodeGuid: approve.nodeGuid, confirm })}
        onClose={() => setApprove(null)}
      />
      <TypedConfirm
        opened={revoke !== null}
        title={t('pki.revoke-title')}
        body={t('pki.revoke-body')}
        phrase={revoke ?? ''}
        confirmLabel={t('pki.revoke')}
        busy={revokeM.isPending}
        onConfirm={(confirm) => revoke && revokeM.mutate({ serial: revoke, confirm })}
        onClose={() => setRevoke(null)}
      />
    </Stack>
  );
}
