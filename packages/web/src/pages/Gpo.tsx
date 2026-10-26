// SPDX-License-Identifier: AGPL-3.0-only
/** Group policy (ROADMAP Phase 3): GPOs with their links, create, back up, restore, link and unlink. */
import { useState } from 'react';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Table, Tabs, Text, TextInput, Title } from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { useSession } from '../session.tsx';
import { ObjectPicker, ProtectedBadge, TypedConfirm } from '../components/directory.tsx';

const link = z.object({
  container: z.string(),
  name: z.string(),
  dn: z.string(),
  enforced: z.boolean(),
  disabled: z.boolean(),
  order: z.number(),
  protected: z.boolean(),
});
const gpo = z.object({
  id: z.string(),
  gpo: z.string(),
  displayName: z.string(),
  userVersion: z.number(),
  computerVersion: z.number(),
  userDisabled: z.boolean(),
  computerDisabled: z.boolean(),
  changedAt: z.string().nullable(),
  links: z.array(link),
});
const overview = z.object({
  pdc: z.string().nullable(),
  isPdc: z.boolean(),
  domain: z.object({ container: z.string(), name: z.string() }),
  gpos: z.array(gpo),
});
const backup = z.object({
  id: z.string(),
  gpo: z.string(),
  displayName: z.string(),
  version: z.number(),
  createdAt: z.string(),
  files: z.number(),
  bytes: z.number(),
});
const backups = z.object({ backups: z.array(backup) });
type Gpo = z.infer<typeof gpo>;
type Backup = z.infer<typeof backup>;
const when = (iso: string | null): string => (iso ? iso.replace('T', ' ').slice(0, 16) : '');

function GpoCard({
  g,
  domain,
  canWrite,
  isPdc,
}: {
  g: Gpo;
  domain: { container: string; name: string };
  canWrite: boolean;
  isPdc: boolean;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['gpo'] });
  const setLink = useMutation({
    mutationFn: (l: { container: string; enforced: boolean; disabled: boolean }) =>
      api(`/gpo/${g.id}/links/${l.container}`, {
        method: 'PUT',
        body: { enforced: l.enforced, disabled: l.disabled },
        schema: z.object({ container: z.string() }),
      }),
    onSuccess: refresh,
  });
  const unlink = useMutation({
    mutationFn: (container: string) =>
      api(`/gpo/${g.id}/links/${container}`, { method: 'DELETE', schema: z.object({ container: z.string() }) }),
    onSuccess: refresh,
  });
  const backupNow = useMutation({
    mutationFn: () => api(`/gpo/${g.id}/backup`, { method: 'POST', body: {}, schema: backup }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gpo-backups'] }),
  });
  const err = setLink.error ?? unlink.error ?? backupNow.error;
  const linked = g.links.map((l) => l.container);
  return (
    <Card withBorder>
      <Stack gap="xs">
        <Group justify="space-between" align="flex-start">
          <div>
            <Text fw={600}>{g.displayName}</Text>
            <Text size="xs" c="dimmed" ff="monospace">
              {g.gpo}
            </Text>
          </div>
          <Group gap={4}>
            {g.userDisabled ? <Badge variant="light">{t('gpo.user-off')}</Badge> : null}
            {g.computerDisabled ? <Badge variant="light">{t('gpo.computer-off')}</Badge> : null}
            <Text size="sm" c="dimmed">
              {t('gpo.versions', { user: g.userVersion, computer: g.computerVersion })}
              {g.changedAt ? ` · ${when(g.changedAt)}` : ''}
            </Text>
          </Group>
        </Group>
        {err ? <ErrorView error={err} /> : null}
        {backupNow.data ? <Alert color="green">{t('gpo.backed-up', { files: backupNow.data.files })}</Alert> : null}
        {g.links.length ? (
          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('gpo.linked-to')}</Table.Th>
                <Table.Th>{t('gpo.order')}</Table.Th>
                <Table.Th>{t('gpo.state')}</Table.Th>
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {g.links.map((l) => (
                <Table.Tr key={l.container}>
                  <Table.Td>
                    <Group gap={6}>
                      <Text size="sm">{l.name}</Text>
                      {l.protected ? <ProtectedBadge /> : null}
                    </Group>
                  </Table.Td>
                  <Table.Td>{l.order}</Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {l.enforced ? <Badge color="orange">{t('gpo.enforced')}</Badge> : null}
                      {l.disabled ? <Badge color="gray">{t('gpo.link-disabled')}</Badge> : null}
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    {canWrite ? (
                      <Group gap={4} justify="flex-end" wrap="nowrap">
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() =>
                            setLink.mutate({ container: l.container, enforced: !l.enforced, disabled: l.disabled })
                          }
                        >
                          {l.enforced ? t('gpo.unenforce') : t('gpo.enforce')}
                        </Button>
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() =>
                            setLink.mutate({ container: l.container, enforced: l.enforced, disabled: !l.disabled })
                          }
                        >
                          {l.disabled ? t('gpo.enable-link') : t('gpo.disable-link')}
                        </Button>
                        <Button size="xs" variant="subtle" color="red" onClick={() => unlink.mutate(l.container)}>
                          {t('gpo.unlink')}
                        </Button>
                      </Group>
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Text size="sm" c="dimmed">
            {t('gpo.no-links')}
          </Text>
        )}
        {canWrite ? (
          <Group align="flex-end">
            <div style={{ flex: 1, minWidth: 220 }}>
              <ObjectPicker
                label={t('gpo.link-ou')}
                types="ou"
                exclude={linked}
                onPick={(ou) => setLink.mutate({ container: ou.guid, enforced: false, disabled: false })}
              />
            </div>
            {!linked.includes(domain.container) ? (
              <Button
                variant="default"
                onClick={() => setLink.mutate({ container: domain.container, enforced: false, disabled: false })}
              >
                {t('gpo.link-domain', { domain: domain.name })}
              </Button>
            ) : null}
            <Button
              variant="default"
              disabled={!isPdc}
              loading={backupNow.isPending}
              onClick={() => backupNow.mutate()}
            >
              {t('gpo.backup')}
            </Button>
          </Group>
        ) : null}
      </Stack>
    </Card>
  );
}

function Backups({ canWrite, isPdc }: { canWrite: boolean; isPdc: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gpo-backups'], queryFn: () => api('/gpo/backups', { schema: backups }) });
  const [restore, setRestore] = useState<{ b: Backup; newName: string | null } | null>(null);
  const [asNew, setAsNew] = useState<Record<string, string>>({});
  const run = useMutation({
    mutationFn: (o: { b: Backup; newName: string | null; confirm: string }) =>
      api(`/gpo/backups/${o.b.id}/restore`, {
        method: 'POST',
        body: { newName: o.newName, confirm: o.confirm },
        schema: z.object({ gpo: z.string(), created: z.boolean(), version: z.number() }),
      }),
    onSuccess: async () => {
      setRestore(null);
      await qc.invalidateQueries({ queryKey: ['gpo'] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api(`/gpo/backups/${id}`, { method: 'DELETE', schema: z.object({}) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gpo-backups'] }),
  });
  if (q.isPending) return <Loader size="sm" aria-label={t('app.loading')} />;
  if (q.isError) return <ErrorView error={q.error} />;
  if (!q.data.backups.length) return <Text c="dimmed">{t('gpo.no-backups')}</Text>;
  return (
    <Stack>
      {(run.error ?? del.error) ? <ErrorView error={run.error ?? del.error} /> : null}
      {run.data ? (
        <Alert color="green">
          {run.data.created ? t('gpo.restored-new', { gpo: run.data.gpo }) : t('gpo.restored', { gpo: run.data.gpo })}
        </Alert>
      ) : null}
      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>{t('gpo.name')}</Table.Th>
            <Table.Th>{t('gpo.created')}</Table.Th>
            <Table.Th>{t('gpo.size')}</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {q.data.backups.map((b) => (
            <Table.Tr key={b.id}>
              <Table.Td>
                <Text size="sm">{b.displayName}</Text>
                <Text size="xs" c="dimmed" ff="monospace">
                  {b.gpo}
                </Text>
              </Table.Td>
              <Table.Td>{when(b.createdAt)}</Table.Td>
              <Table.Td>{t('gpo.files', { files: b.files, kb: Math.ceil(b.bytes / 1024) })}</Table.Td>
              <Table.Td>
                {canWrite ? (
                  <Group gap={4} justify="flex-end" wrap="nowrap">
                    <Button size="xs" disabled={!isPdc} onClick={() => setRestore({ b, newName: null })}>
                      {t('gpo.restore')}
                    </Button>
                    <TextInput
                      size="xs"
                      aria-label={t('gpo.new-name')}
                      placeholder={t('gpo.new-name')}
                      value={asNew[b.id] ?? ''}
                      onChange={(e) => {
                        const v = e.currentTarget.value;
                        setAsNew((x) => ({ ...x, [b.id]: v }));
                      }}
                    />
                    <Button
                      size="xs"
                      variant="default"
                      disabled={!isPdc || !(asNew[b.id] ?? '').trim()}
                      onClick={() => setRestore({ b, newName: (asNew[b.id] ?? '').trim() })}
                    >
                      {t('gpo.restore-new')}
                    </Button>
                    <Button size="xs" variant="subtle" color="red" onClick={() => del.mutate(b.id)}>
                      {t('dir.delete')}
                    </Button>
                  </Group>
                ) : null}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
      {restore ? (
        <TypedConfirm
          opened
          title={t('gpo.restore-title')}
          body={
            restore.newName
              ? t('gpo.restore-new-body', { name: restore.newName })
              : t('gpo.restore-body', { name: restore.b.displayName, when: when(restore.b.createdAt) })
          }
          phrase={restore.newName ?? restore.b.displayName}
          confirmLabel={t('gpo.restore')}
          busy={run.isPending}
          onConfirm={(confirm) => run.mutate({ b: restore.b, newName: restore.newName, confirm })}
          onClose={() => setRestore(null)}
        />
      ) : null}
    </Stack>
  );
}

export default function GpoPage() {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['gpo'], queryFn: () => api('/gpo', { schema: overview }) });
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api('/gpo', {
        method: 'POST',
        body: { displayName: name },
        schema: z.object({ gpo: z.string(), dn: z.string() }),
      }),
    onSuccess: async () => {
      setName('');
      await qc.invalidateQueries({ queryKey: ['gpo'] });
    },
  });
  if (!has('gpo.read')) return <Text>{t('error.forbidden')}</Text>;
  const canWrite = has('gpo.write');
  return (
    <Stack>
      <Title order={2}>{t('gpo.title')}</Title>
      <Text c="dimmed">{t('gpo.intro')}</Text>
      {q.isPending ? <Loader size="sm" aria-label={t('app.loading')} /> : null}
      {q.isError ? <ErrorView error={q.error} /> : null}
      {q.data && !q.data.isPdc ? <Alert color="blue">{t('gpo.not-pdc', { pdc: q.data.pdc ?? '?' })}</Alert> : null}
      {q.data ? (
        <Tabs defaultValue="objects">
          <Tabs.List>
            <Tabs.Tab value="objects">{t('gpo.objects')}</Tabs.Tab>
            <Tabs.Tab value="backups">{t('gpo.backups')}</Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="objects" pt="md">
            <Stack>
              {canWrite ? (
                <Group align="flex-end">
                  <TextInput
                    label={t('gpo.new')}
                    value={name}
                    onChange={(e) => setName(e.currentTarget.value)}
                    disabled={!q.data.isPdc}
                  />
                  <Button
                    disabled={!q.data.isPdc || !name.trim()}
                    loading={create.isPending}
                    onClick={() => create.mutate()}
                  >
                    {t('gpo.create')}
                  </Button>
                </Group>
              ) : null}
              {create.error ? <ErrorView error={create.error} /> : null}
              {q.data.gpos.map((g) => (
                <GpoCard key={g.gpo} g={g} domain={q.data.domain} canWrite={canWrite} isPdc={q.data.isPdc} />
              ))}
            </Stack>
          </Tabs.Panel>
          <Tabs.Panel value="backups" pt="md">
            <Backups canWrite={canWrite} isPdc={q.data.isPdc} />
          </Tabs.Panel>
        </Tabs>
      ) : null}
    </Stack>
  );
}
