// SPDX-License-Identifier: AGPL-3.0-only
import { AppShell, Button, Group, NavLink as MantineNavLink, Stack, Text, Title } from '@mantine/core';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { empty } from '@opendc/shared/api';
import { api, setCsrfToken } from './api.ts';
import { useSession } from './session.tsx';
import { LanguageSwitch } from './LanguageSwitch.tsx';
import { ReauthModal } from './pages/Account.tsx';

/** Navigation entries, each shown only with its permission (the server enforces regardless). */
const NAV = [
  { to: '/', label: 'nav.home', permission: 'core.console.access' },
  { to: '/directory', label: 'nav.directory', permission: 'domain.users.read' },
  { to: '/domain', label: 'nav.domain', permission: 'domain.info.read' },
  { to: '/password-policies', label: 'nav.passwordPolicies', permission: 'domain.passwordPolicy.read' },
  { to: '/policies', label: 'nav.policies', permission: 'policies.policy.read' },
  { to: '/dns', label: 'nav.dns', permission: 'dns.zones.read' },
  { to: '/rbac', label: 'nav.rbac', permission: 'domain.rbac.read' },
  { to: '/audit', label: 'nav.audit', permission: 'core.audit.read' },
  { to: '/account', label: 'nav.account', permission: 'core.console.access' },
] as const;

export default function Layout() {
  const { t } = useTranslation();
  const { session, has, refresh } = useSession();
  const qc = useQueryClient();
  const { pathname } = useLocation();
  const isActive = (to: string): boolean => (to === '/' ? pathname === '/' : pathname.startsWith(to));

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
            <MantineNavLink key={n.to} component={NavLink} to={n.to} active={isActive(n.to)} label={t(n.label)} />
          ))}
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <ReauthModal />
        <Outlet />
      </AppShell.Main>
    </AppShell>
  );
}
