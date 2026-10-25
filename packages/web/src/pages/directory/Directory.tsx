// SPDX-License-Identifier: AGPL-3.0-only
/** Directory browser: OU tree, filtered and paged object list, create actions. */
import { useState } from 'react';
import {
  Anchor,
  Badge,
  Button,
  Grid,
  Group,
  Loader,
  Menu,
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
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { domainInfo, listResponse } from '@opendc/shared/api';
import { api } from '../../api.ts';
import { ErrorView } from '../../ErrorView.tsx';
import { useSession } from '../../session.tsx';
import { OuTree, ProtectedBadge, TypeBadge } from '../../components/directory.tsx';
import { CreateContact, CreateGroup, CreateOu, CreateUser } from './Create.tsx';

const PAGE = 50;
const TYPES = ['user', 'group', 'computer', 'contact', 'ou'] as const;

export default function Directory() {
  const { t } = useTranslation();
  const { has } = useSession();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') ?? 'user';
  const base = params.get('base');
  const status = params.get('status');
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [q] = useDebouncedValue(search, 300);
  const [page, setPage] = useState(1);
  const [create, setCreate] = useState<null | 'user' | 'group' | 'contact' | 'ou'>(null);

  const info = useQuery({ queryKey: ['domain-info'], queryFn: () => api('/directory/info', { schema: domainInfo }) });
  const set = (k: string, v: string | null): void => {
    const next = new URLSearchParams(params);
    if (v === null || v === '') next.delete(k);
    else next.set(k, v);
    setParams(next, { replace: true });
    setPage(1);
  };
  const query = new URLSearchParams({
    types: type === 'all' ? TYPES.join(',') : type,
    limit: String(PAGE),
    offset: String((page - 1) * PAGE),
    scope: base ? 'one' : 'sub',
    ...(base ? { base } : {}),
    ...(q ? { q } : {}),
    ...(status ? { status } : {}),
  });
  const list = useQuery({
    queryKey: ['objects', query.toString()],
    queryFn: () => api(`/directory/objects?${query.toString()}`, { schema: listResponse }),
  });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>{t('dir.title')}</Title>
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
