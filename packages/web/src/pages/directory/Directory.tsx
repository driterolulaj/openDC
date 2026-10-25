// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Directory browser: OU tree, filtered and paged object list, saved searches, bulk actions on the selected
 * objects, CSV export, create actions.
 */
import { useEffect, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Checkbox,
  Grid,
  Group,
  Loader,
  Menu,
  Modal,
  Pagination,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useDebouncedValue } from '@mantine/hooks';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';
import { domainInfo, job as jobSchema, listResponse, savedSearches, type BulkRequest } from '@opendc/shared/api';
import { api } from '../../api.ts';
import { ErrorView } from '../../ErrorView.tsx';
import { useSession } from '../../session.tsx';
import { ObjectPicker, OuTree, ProtectedBadge, TypeBadge, TypedConfirm } from '../../components/directory.tsx';
import { useJob } from '../../useJob.ts';
import { CreateContact, CreateGroup, CreateOu, CreateUser } from './Create.tsx';
import { OuPickerModal } from './OuPicker.tsx';

const PAGE = 50;
const TYPES = ['user', 'group', 'computer', 'contact', 'ou'] as const;

export default function Directory() {
  const { t } = useTranslation();
  const { has } = useSession();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? 'user';
  const base = params.get('base');
  const status = params.get('status');
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [q] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [create, setCreate] = useState<null | 'user' | 'group' | 'contact' | 'ou'>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState<null | 'move' | 'delete' | 'group'>(null);
  const [bulkJob, setBulkJob] = useState<string | null>(null);
  const [searchName, setSearchName] = useState('');

  const info = useQuery({ queryKey: ['domain-info'], queryFn: () => api('/directory/info', { schema: domainInfo }) });
  const saved = useQuery({
    queryKey: ['saved-searches'],
    queryFn: () => api('/directory/searches', { schema: savedSearches }),
  });
  const bulkState = useJob(bulkJob);
  const set = (k: string, v: string | null): void => {
    const next = new URLSearchParams(params);
    if (v === null || v === '') next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
    setPage(1);
  };
  const filters = {
    scope: base ? 'one' : 'sub',
    ...(base ? { base } : {}),
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
  };
  const types = type === 'all' ? TYPES.join(',') : type;
  const query = new URLSearchParams({ types, limit: String(PAGE), offset: String((page - 1) * PAGE), ...filters });
  const list = useQuery({
    queryKey: ['objects', query.toString()],
    queryFn: () => api(`/directory/objects?${query.toString()}`, { schema: listResponse }),
  });

  const bulk = useMutation({
    mutationFn: (action: BulkRequest['action']) =>
      api('/directory/bulk', { method: 'POST', body: { guids: [...selected], action }, schema: jobSchema }),
    onSuccess: (j) => {
      setBulkJob(j.id);
      setBulkMode(null);
    },
  });
  const finished = bulkState.data !== undefined && bulkState.data.status !== 'running';
  useEffect(() => {
    if (!finished) return;
    setSelected(new Set());
    void qc.invalidateQueries({ queryKey: ['objects'] });
  }, [finished, qc]);

  const saveSearch = useMutation({
    mutationFn: () =>
      api('/directory/searches', {
        method: 'POST',
        body: { name: searchName, query: { types, ...filters } },
        schema: z.object({ id: z.string() }),
      }),
    onSuccess: async () => {
      setSearchName('');
      await qc.invalidateQueries({ queryKey: ['saved-searches'] });
    },
  });

  const toggle = (guids: string[], on: boolean): void => {
    setSelected((cur) => {
      const next = new Set(cur);
      for (const g of guids) {
        if (on) next.add(g);
        else next.delete(g);
      }
      return next;
    });
  };
  const result =
    finished && bulkState.data.status === 'succeeded'
      ? (bulkState.data.result as { done: number; failed: number })
      : null;

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('dir.title')}</Title>
        <Group>
          <Button component={Link} to="/directory/import" variant="default">
            {t('dir.import')}
          </Button>
          <Button component={Link} to="/directory/templates" variant="default">
            {t('dir.templates')}
          </Button>
          <Button
            component="a"
            variant="default"
            href={`/api/v1/directory/export?${new URLSearchParams(filters).toString()}`}
          >
            {t('dir.export')}
          </Button>
          <Menu position="bottom-end">
            <Menu.Target>
              <Button>{t('dir.create')}</Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Item disabled={!has('domain.users.create')} onClick={() => setCreate('user')}>
                {t('dir.type-user')}
              </Menu.Item>
              <Menu.Item disabled={!has('domain.groups.create')} onClick={() => setCreate('group')}>
                {t('dir.type-group')}
              </Menu.Item>
              <Menu.Item disabled={!has('domain.contacts.write')} onClick={() => setCreate('contact')}>
                {t('dir.type-contact')}
              </Menu.Item>
              <Menu.Item disabled={!has('domain.ous.write')} onClick={() => setCreate('ou')}>
                {t('dir.type-ou')}
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        </Group>
      </Group>
      <Grid>
        <Grid.Col span={{ base: 12, md: 3 }}>
          <Paper withBorder p="xs">
            {info.data ? (
              <OuTree
                selected={base}
                rootLabel={info.data.domain}
                rootGuid={info.data.headGuid}
                onSelect={(c) => set('base', c?.guid ?? null)}
              />
            ) : (
              <Loader size="xs" aria-label={t('app.loading')} />
            )}
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 9 }}>
          <Stack>
            <Group>
              <SegmentedControl
                value={type}
                onChange={(v) => set('type', v)}
                data={[...TYPES, 'all'].map((x) => ({ value: x, label: t(`dir.types-${x}`) }))}
                aria-label={t('dir.filter-type')}
              />
              <TextInput
                placeholder={t('dir.search')}
                aria-label={t('dir.search')}
                value={search}
                onChange={(e) => {
                  setSearch(e.currentTarget.value);
                  setPage(1);
                }}
                style={{ flex: 1 }}
              />
              <Select
                aria-label={t('dir.filter-status')}
                placeholder={t('dir.filter-status')}
                clearable
                w={160}
                value={status}
                onChange={(v) => set('status', v)}
                data={['enabled', 'disabled', 'locked', 'expired'].map((s) => ({
                  value: s,
                  label: t(`dir.status-${s}`),
                }))}
              />
            </Group>
            <Group>
              <Select
                aria-label={t('dir.saved-searches')}
                placeholder={t('dir.saved-searches')}
                w={240}
                data={(saved.data?.searches ?? []).map((x) => ({
                  value: x.id,
                  label: x.shared ? `${x.name} (${t('dir.shared')})` : x.name,
                }))}
                value={null}
                onChange={(id) => {
                  const x = saved.data?.searches.find((y) => y.id === id);
                  if (!x) return;
                  const next = new URLSearchParams();
                  const ty = x.query.types?.includes(',') ? 'all' : x.query.types;
                  if (ty) next.set('type', ty);
                  if (x.query.base) next.set('base', x.query.base);
                  if (x.query.status) next.set('status', x.query.status);
                  setParams(next, { replace: true });
                  setSearch(x.query.q ?? '');
                  setPage(1);
                }}
              />
              <TextInput
                aria-label={t('dir.save-search-name')}
                placeholder={t('dir.save-search-name')}
                value={searchName}
                onChange={(e) => setSearchName(e.currentTarget.value)}
              />
              <Button
                variant="light"
                disabled={!searchName}
                loading={saveSearch.isPending}
                onClick={() => saveSearch.mutate()}
              >
                {t('dir.save-search')}
              </Button>
            </Group>
            {selected.size > 0 ? (
              <Alert color="blue">
                <Group justify="space-between">
                  <Text size="sm">{t('dir.selected', { count: selected.size })}</Text>
                  <Group gap="xs">
                    <Button
                      size="xs"
                      variant="default"
                      loading={bulk.isPending}
                      onClick={() => bulk.mutate({ kind: 'enable' })}
                    >
                      {t('dir.enable')}
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      loading={bulk.isPending}
                      onClick={() => bulk.mutate({ kind: 'disable' })}
                    >
                      {t('dir.disable')}
                    </Button>
                    <Button size="xs" variant="default" onClick={() => setBulkMode('move')}>
                      {t('dir.move')}
                    </Button>
                    <Button size="xs" variant="default" onClick={() => setBulkMode('group')}>
                      {t('dir.add-to-group')}
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      loading={bulk.isPending}
                      onClick={() => bulk.mutate({ kind: 'fillPosixIds' })}
                    >
                      {t('dir.fill-posix-ids')}
                    </Button>
                    <Button size="xs" color="red" variant="light" onClick={() => setBulkMode('delete')}>
                      {t('dir.delete')}
                    </Button>
                    <Button size="xs" variant="subtle" onClick={() => setSelected(new Set())}>
                      {t('dir.clear-selection')}
                    </Button>
                  </Group>
                </Group>
              </Alert>
            ) : null}
            {bulk.error ? <ErrorView error={bulk.error} /> : null}
            {bulkState.data?.status === 'running' ? <Loader size="sm" aria-label={t('app.loading')} /> : null}
            {finished ? (
              <Alert
                color={result && result.failed === 0 ? 'green' : 'orange'}
                withCloseButton
                closeButtonLabel={t('app.close')}
                onClose={() => setBulkJob(null)}
              >
                {result ? t('dir.bulk-done', { done: result.done, failed: result.failed }) : t('dir.bulk-failed')}
              </Alert>
            ) : null}
            {list.isError ? <ErrorView error={list.error} /> : null}
            {list.isPending ? <Loader size="sm" aria-label={t('app.loading')} /> : null}
            {list.data ? (
              <>
                <Text size="sm" c="dimmed">
                  {t('dir.count', { count: list.data.total })}
                  {list.data.truncated ? ` ${t('dir.truncated')}` : ''}
                </Text>
                <Table striped highlightOnHover>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th w={1}>
                        <Checkbox
                          aria-label={t('dir.select-page')}
                          checked={
                            list.data.items.some((i) => !i.protected) &&
                            list.data.items.filter((i) => !i.protected).every((i) => selected.has(i.guid))
                          }
                          onChange={(e) =>
                            toggle(
                              list.data.items.filter((i) => !i.protected).map((i) => i.guid),
                              e.currentTarget.checked,
                            )
                          }
                        />
                      </Table.Th>
                      <Table.Th>{t('dir.col-name')}</Table.Th>
                      <Table.Th>{t('dir.col-type')}</Table.Th>
                      <Table.Th>{t('dir.col-account')}</Table.Th>
                      <Table.Th>{t('dir.col-mail')}</Table.Th>
                      <Table.Th miw={120}>{t('dir.col-status')}</Table.Th>
                      <Table.Th>{t('dir.col-location')}</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {list.data.items.map((i) => (
                      <Table.Tr key={i.guid}>
                        <Table.Td>
                          <Checkbox
                            aria-label={t('dir.select-x', { name: i.displayName ?? i.name })}
                            checked={selected.has(i.guid)}
                            disabled={i.protected}
                            onChange={(e) => toggle([i.guid], e.currentTarget.checked)}
                          />
                        </Table.Td>
                        <Table.Td>
                          <Group gap={6}>
                            <Anchor component={Link} to={`/directory/${i.guid}`}>
                              {i.displayName ?? i.name}
                            </Anchor>
                            {i.protected ? <ProtectedBadge /> : null}
                          </Group>
                        </Table.Td>
                        <Table.Td>
                          <TypeBadge type={i.type} />
                        </Table.Td>
                        <Table.Td>{i.sam ?? ''}</Table.Td>
                        <Table.Td>{i.mail ?? ''}</Table.Td>
                        <Table.Td>
                          {i.enabled === false ? (
                            <Badge color="gray" variant="light" size="sm">
                              {t('dir.status-disabled')}
                            </Badge>
                          ) : null}
                          {i.locked ? (
                            <Badge color="red" variant="light" size="sm">
                              {t('dir.status-locked')}
                            </Badge>
                          ) : null}
                        </Table.Td>
                        <Table.Td>
                          <Text size="xs" c="dimmed">
                            {i.parentDn}
                          </Text>
                        </Table.Td>
                      </Table.Tr>
                    ))}
                  </Table.Tbody>
                </Table>
                {list.data.total > PAGE ? (
                  <Pagination
                    total={Math.ceil(Math.min(list.data.total, 10_000) / PAGE)}
                    value={page}
                    onChange={setPage}
                    getControlProps={(c) => ({ 'aria-label': t(`dir.page-${c}`) })}
                  />
                ) : null}
              </>
            ) : null}
          </Stack>
        </Grid.Col>
      </Grid>
      <OuPickerModal
        opened={bulkMode === 'move'}
        onClose={() => setBulkMode(null)}
        busy={bulk.isPending}
        onPick={(parent) => bulk.mutate({ kind: 'move', parent })}
      />
      <TypedConfirm
        opened={bulkMode === 'delete'}
        title={t('dir.delete-title')}
        body={t('dir.bulk-delete-body', { count: selected.size })}
        phrase={String(selected.size)}
        confirmLabel={t('dir.delete')}
        busy={bulk.isPending}
        onClose={() => setBulkMode(null)}
        onConfirm={() => bulk.mutate({ kind: 'delete' })}
      />
      <Modal opened={bulkMode === 'group'} onClose={() => setBulkMode(null)} title={t('dir.add-to-group')}>
        <ObjectPicker
          label={t('dir.f-groups')}
          types="group"
          onPick={(g) => bulk.mutate({ kind: 'addToGroup', group: g.guid })}
        />
      </Modal>
      {info.data ? (
        <>
          <CreateUser opened={create === 'user'} onClose={() => setCreate(null)} parent={base ?? info.data.usersGuid} />
          <CreateGroup
            opened={create === 'group'}
            onClose={() => setCreate(null)}
            parent={base ?? info.data.usersGuid}
          />
          <CreateContact
            opened={create === 'contact'}
            onClose={() => setCreate(null)}
            parent={base ?? info.data.usersGuid}
          />
          <CreateOu opened={create === 'ou'} onClose={() => setCreate(null)} parent={base ?? info.data.headGuid} />
        </>
      ) : null}
    </Stack>
  );
}
