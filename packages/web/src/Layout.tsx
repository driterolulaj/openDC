// SPDX-License-Identifier: AGPL-3.0-only
import { AppShell, Button, Group, NavLink as MantineNavLink, Stack, Text, Title } from '@mantine/core';
import { NavLink, Outlet } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { empty } from '@opendc/shared/api';
import { api, setCsrfToken } from './api.ts';
import { useSession } from './session.tsx';
import { LanguageSwitch } from './LanguageSwitch.tsx';

/** Navigation entries, each shown only with its permission (the server enforces regardless). */
const NAV = [
  { to: '/', label: 'nav.home', permission: 'core.console.access' },
  { to: '/audit', label: 'nav.audit', permission: 'core.audit.read' },
] as const;

export default function Layout() {
  const { t } = useTranslation();
  const { session, has, refresh } = useSession();
  const qc = useQueryClient();

  async function logout(): Promise<void> {
    await api('/session', { method: 'DELETE', schema: empty }).catch(() => undefined);
    setCsrfToken(null);
    qc.clear();
    await refresh();
  }

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 220, breakpoint: 'sm' }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Title order={1} size="h4">
            {t('app.name')}
          </Title>
          <Group gap="sm">
            <Text size="sm" c="dimmed">
              {t('app.signed-in-as', { name: session?.user.displayName ?? session?.user.username ?? '' })}
            </Text>
            <LanguageSwitch />
            <Button variant="default" size="xs" onClick={() => void logout()}>
              {t('app.logout')}
            </Button>
          </Group>
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="xs" component="nav" aria-label={t('app.name')}>
        <Stack gap={2}>
          {NAV.filter((n) => has(n.permission)).map((n) => (
            <MantineNavLink key={n.to} component={NavLink} to={n.to} end label={t(n.label)} />
          ))}
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
