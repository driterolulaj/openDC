// SPDX-License-Identifier: AGPL-3.0-only
/** CSV user import: upload, dry-run diff, apply as a job, history with undo and one-time password download. */
import { useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  FileInput,
  Group,
  Loader,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { importBatches, importPreview, job as jobSchema, userTemplates, type ImportPreview } from '@opendc/shared/api';
import { api } from '../../api.ts';
import { ErrorView } from '../../ErrorView.tsx';
import { useSession } from '../../session.tsx';
import { useJob } from '../../useJob.ts';
import { OuPickerModal } from './OuPicker.tsx';

const objectIdentity = z.object({ guid: z.string(), dn: z.string() }).loose();
const ACTION_COLOR = { create: 'green', update: 'blue', unchanged: 'gray', error: 'red' } as const;

export default function Import() {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const tpls = useQuery({
    queryKey: ['templates'],
    queryFn: () => api('/directory/templates', { schema: userTemplates }),
  });
  const batches = useQuery({
    queryKey: ['imports'],
    queryFn: () => api('/directory/imports', { schema: importBatches }),
  });
  const [file, setFile] = useState<File | null>(null);
  const [csv, setCsv] = useState('');
  const [mode, setMode] = useState<'create' | 'update' | 'upsert'>('create');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [parent, setParent] = useState<{ guid: string; dn: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(jobId);

  const body = () => ({ csv, mode, ...(templateId ? { templateId } : {}), ...(parent ? { parent: parent.guid } : {}) });
  const dryRun = useMutation({
    mutationFn: () => api('/directory/import/preview', { method: 'POST', body: body(), schema: importPreview }),
    onSuccess: setPreview,
  });
  const run = useMutation({
    mutationFn: () => api('/directory/import', { method: 'POST', body: body(), schema: jobSchema }),
    onSuccess: (j) => {
      setJobId(j.id);
      setPreview(null);
    },
  });
  const undo = useMutation({
    mutationFn: (id: string) => api(`/directory/imports/${id}`, { method: 'DELETE', schema: jobSchema }),
    onSuccess: (j) => setJobId(j.id),
  });
  const result = job.data?.status === 'succeeded' ? (job.data.result as Record<string, unknown>) : null;
  if (job.data && job.data.status !== 'running') void qc.invalidateQueries({ queryKey: ['imports'] });

  return (
    <Stack>
      <Title order={2}>{t('imp.title')}</Title>
      <Text size="sm">{t('imp.help')}</Text>
      <Card withBorder>
        <Stack>
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <FileInput
              label={t('imp.file')}
              accept=".csv,text/csv"
              value={file}
              onChange={(f) => {
                setFile(f);
                setPreview(null);
                void f?.text().then(setCsv);
              }}
            />
            <Select
              label={t('imp.template')}
              clearable
              data={(tpls.data?.templates ?? []).map((x) => ({ value: x.id, label: x.name }))}
              value={templateId}
              onChange={setTemplateId}
            />
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t('imp.target')}
              </Text>
              <Group>
                <Text size="sm" ff="monospace">
                  {parent?.dn ?? t('imp.target-default')}
                </Text>
                <Button size="xs" variant="light" onClick={() => setPicking(true)}>
                  {t('imp.choose')}
                </Button>
              </Group>
            </Stack>
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                {t('imp.mode')}
              </Text>
              <SegmentedControl
                value={mode}
                onChange={(v) => setMode(v === 'update' || v === 'upsert' ? v : 'create')}
                data={(['create', 'update', 'upsert'] as const).map((m) => ({ value: m, label: t(`imp.mode-${m}`) }))}
              />
            </Stack>
          </SimpleGrid>
          <Group>
            <Button disabled={!csv} loading={dryRun.isPending} onClick={() => dryRun.mutate()}>
              {t('imp.dry-run')}
            </Button>
            <Button
              color="green"
              disabled={!preview || preview.counts.create + preview.counts.update === 0}
              loading={run.isPending}
              onClick={() => run.mutate()}
            >
              {t('imp.apply', { count: (preview?.counts.create ?? 0) + (preview?.counts.update ?? 0) })}
            </Button>
          </Group>
          {(dryRun.error ?? run.error) ? <ErrorView error={dryRun.error ?? run.error} /> : null}
        </Stack>
      </Card>

      {preview ? (
        <Card withBorder>
          <Stack>
            <Group gap="xs">
              {(['create', 'update', 'unchanged', 'error'] as const).map((k) => (
                <Badge key={k} color={ACTION_COLOR[k]} variant="light">
                  {t(`imp.count-${k}`, { count: preview.counts[k] })}
                </Badge>
              ))}
            </Group>
            {preview.ignored.length ? (
              <Alert color="yellow">{t('imp.ignored', { columns: preview.ignored.join(', ') })}</Alert>
            ) : null}
            <Table striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>{t('imp.line')}</Table.Th>
                  <Table.Th>{t('dir.f-sam')}</Table.Th>
                  <Table.Th>{t('imp.action')}</Table.Th>
                  <Table.Th>{t('imp.changes')}</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {preview.rows.slice(0, 500).map((r) => (
                  <Table.Tr key={r.line}>
                    <Table.Td>{r.line}</Table.Td>
                    <Table.Td>{r.sam}</Table.Td>
                    <Table.Td>
                      <Badge color={ACTION_COLOR[r.action]} variant="light">
                        {t(`imp.action-${r.action}`)}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {r.error ? (
                        <Text size="sm" c="red">
                          {r.error}
                        </Text>
                      ) : (
                        <Text size="xs" ff="monospace">
                          {Object.entries(r.changes)
                            .map(([k, v]) => `${k}: ${v.from ?? '∅'} → ${v.to ?? '∅'}`)
                            .join('; ')}
                        </Text>
                      )}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            {preview.rows.length > 500 ? (
              <Text size="sm" c="dimmed">
                {t('imp.more-rows', { count: preview.rows.length - 500 })}
              </Text>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      {job.data ? (
        <Card withBorder>
          <Stack>
            <Title order={3} size="h5">
              {t(`imp.job-${job.data.type === 'directory.import.undo' ? 'undo' : 'run'}`)}
            </Title>
            {job.data.status === 'running' ? <Progress value={100} animated aria-label={t('app.loading')} /> : null}
            {job.data.status === 'failed' ? <ErrorView error={job.data.error} /> : null}
            {result ? (
              <Text size="sm" ff="monospace">
                {JSON.stringify(result)}
              </Text>
            ) : null}
          </Stack>
        </Card>
      ) : null}

      <Card withBorder>
        <Title order={3} size="h5" mb="xs">
          {t('imp.history')}
        </Title>
        {batches.isPending ? <Loader size="sm" aria-label={t('app.loading')} /> : null}
        <Table>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>{t('audit.time')}</Table.Th>
              <Table.Th>{t('audit.actor')}</Table.Th>
              <Table.Th>{t('imp.result')}</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(batches.data?.batches ?? []).map((b) => (
              <Table.Tr key={b.id}>
                <Table.Td>{new Date(b.createdAt).toLocaleString()}</Table.Td>
                <Table.Td>{b.actor}</Table.Td>
                <Table.Td>{t('imp.batch', { created: b.created, updated: b.updated, failed: b.failed })}</Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    {b.passwordsAvailable ? (
                      <Anchor href={`/api/v1/directory/imports/${b.id}/passwords`} size="sm">
                        {t('imp.passwords')}
                      </Anchor>
                    ) : null}
                    {b.undone ? (
                      <Badge variant="light">{t('imp.undone')}</Badge>
                    ) : (
                      <Button
                        size="xs"
                        variant="subtle"
                        color="red"
                        disabled={!has('domain.users.delete') || b.created === 0}
                        onClick={() => undo.mutate(b.id)}
                      >
                        {t('imp.undo')}
                      </Button>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Card>
      <OuPickerModal
        opened={picking}
        onClose={() => setPicking(false)}
        onPick={(guid) => {
          setPicking(false);
          void api(`/directory/objects/${guid}`, { schema: objectIdentity }).then((o) =>
            setParent({ guid: o.guid, dn: o.dn }),
          );
        }}
      />
    </Stack>
  );
}
