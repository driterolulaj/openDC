// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Setup wizard (ROADMAP Phase 2): token -> role -> host and domain -> administrator -> pre-flight -> confirm
 * and run. Talks to /api/v1/setup/* with the one-time setup token; the server and the agent validate
 * everything again, the checks here only give early feedback.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Center,
  Code,
  Group,
  List,
  Paper,
  PasswordInput,
  Progress,
  Radio,
  Select,
  SimpleGrid,
  Stack,
  Stepper,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  SETUP_TOKEN_HEADER,
  setupJobResponse,
  setupPreflightResponse,
  setupStatusResponse,
  job as jobSchema,
} from '@opendc/shared/api';
import {
  baseSchemas,
  confirmationPhrase,
  defaultNetbios,
  dnsDomainIssue,
  functionalLevels,
  hostLabelIssue,
  netbiosIssue,
  passwordIssue,
  DEFAULT_ID_BASE,
  DEFAULT_SITE,
  type PreflightResult,
  type SetupState,
} from '@opendc/shared/domain';
import { api } from '../api.ts';
import { ErrorView } from '../ErrorView.tsx';
import { LanguageSwitch } from '../LanguageSwitch.tsx';

type Role = 'primary-dc' | 'dc';
type SetupJob = z.infer<typeof setupJobResponse>;

const splitList = (s: string): string[] =>
  s
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean);

function CheckList({ result }: { result: PreflightResult }) {
  const { t } = useTranslation();
  const color = { pass: 'green', warn: 'yellow', fail: 'red' } as const;
  return (
    <List spacing="xs" listStyleType="none" aria-label={t('setup.preflight-title')}>
      {result.checks.map((c) => {
        const params =
          typeof c.params.issue === 'string' && c.params.issue
            ? { ...c.params, issue: t(`domain:setup.issue.${c.params.issue}`) }
            : c.params;
        return (
          <List.Item key={c.id}>
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <Badge color={color[c.status]} variant="light" w={64}>
                {t(`setup.status-${c.status}`)}
              </Badge>
              <div>
                <Text size="sm">{t(`domain:setup.check.${c.id}.${c.status}`, params)}</Text>
                {c.status !== 'pass' ? (
                  <Text size="xs" c="dimmed">
                    {t(`domain:setup.check.${c.id}.fix`, params)}
                  </Text>
                ) : null}
              </div>
            </Group>
          </List.Item>
        );
      })}
    </List>
  );
}

export default function Setup() {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [token, setToken] = useState(() => new URLSearchParams(location.search).get('token') ?? '');
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const [role, setRole] = useState<Role>('primary-dc');
  const [fqdn, setFqdn] = useState('');
  const [hostIp, setHostIp] = useState('');
  const [domain, setDomain] = useState('');
  const [netbios, setNetbios] = useState('');
  const [forwarders, setForwarders] = useState('');
  const [ntp, setNtp] = useState('');
  const [dcHost, setDcHost] = useState('');
  const [joinUser, setJoinUser] = useState('Administrator');
  const [joinPassword, setJoinPassword] = useState('');
  const [baseSchema, setBaseSchema] = useState<string>('2016');
  const [level, setLevel] = useState<string>('2008_R2');
  const [site, setSite] = useState(DEFAULT_SITE);
  const [idBase, setIdBase] = useState(String(DEFAULT_ID_BASE));
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [confirm, setConfirm] = useState('');
  const [job, setJob] = useState<SetupJob | null>(null);

  const headers = useMemo(() => ({ [SETUP_TOKEN_HEADER]: token.trim() }), [token]);

  // domain and NetBIOS follow the FQDN until the user edits them
  const [domainTouched, setDomainTouched] = useState(false);
  const [netbiosTouched, setNetbiosTouched] = useState(false);
  useEffect(() => {
    if (!domainTouched) setDomain(fqdn.split('.').slice(1).join('.'));
  }, [fqdn, domainTouched]);
  useEffect(() => {
    if (!netbiosTouched) setNetbios(defaultNetbios(domain));
  }, [domain, netbiosTouched]);

  async function checkToken(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const s = await api('/setup/status', { schema: setupStatusResponse, headers });
      if (s.provisioned) {
        setState(s);
        return;
      }
      if (s.tokenValid !== true) throw new Error(t('setup.token-wrong'));
      setState(s);
      setFqdn(s.fqdn.includes('.') ? s.fqdn : '');
      setHostIp(s.addresses.find((a) => !a.dynamic)?.address ?? s.addresses[0]?.address ?? '');
      setForwarders(s.nameservers.filter((n) => !n.startsWith('127.')).join(', '));
      setStep(1);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const host = fqdn.split('.')[0] ?? '';
  const hostIssue = host ? hostLabelIssue(host) : null;
  const domainIssue = domain ? dnsDomainIssue(domain) : null;
  const nbIssue = role === 'primary-dc' && netbios ? netbiosIssue(netbios, host) : null;
  const pwIssue = password ? passwordIssue(password) : null;
  const issue = (code: string | null): string | null => (code ? t(`domain:setup.issue.${code}`) : null);

  const hostValid =
    !!host &&
    !hostIssue &&
    !!domain &&
    (!domainIssue || domainIssue === 'mdns-local') &&
    fqdn.toLowerCase() === `${host}.${domain}`.toLowerCase() &&
    /^\d+\.\d+\.\d+\.\d+$/.test(hostIp) &&
    (role === 'dc' ? !!dcHost && !!joinUser && !!joinPassword : !!netbios && !nbIssue);
  const adminValid = role === 'dc' || (!!password && !pwIssue && password === password2);

  const common = () => ({
    fqdn,
    hostIp,
    domain,
    dnsForwarders: splitList(forwarders),
    ntpServers: splitList(ntp),
    ntpAllow: [],
  });

  async function runPreflight(): Promise<void> {
    setBusy(true);
    setError(null);
    setPreflight(null);
    try {
      const r = await api('/setup/preflight', {
        method: 'POST',
        schema: setupPreflightResponse,
        headers,
        body: {
          role,
          fqdn,
          hostIp,
          domain,
          dnsForwarders: splitList(forwarders),
          ...(role === 'primary-dc' ? { netbiosDomain: netbios } : { dcHost }),
        },
      });
      setPreflight(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  async function start(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const body =
        role === 'primary-dc'
          ? {
              ...common(),
              netbiosDomain: netbios,
              adminPassword: password,
              baseSchema,
              functionalLevel: level,
              siteName: site,
              idBase: Number(idBase),
              confirm,
            }
          : { ...common(), dcHost, username: joinUser, password: joinPassword, siteName: site, confirm };
      const j = await api(role === 'primary-dc' ? '/setup/provision' : '/setup/join', {
        method: 'POST',
        schema: jobSchema,
        headers,
        body,
      });
      setPassword('');
      setPassword2('');
      setJoinPassword('');
      setJob({ job: j, events: [] });
      setStep(5);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  // follow the job; after success the API restarts, so keep polling through a short outage
  useEffect(() => {
    if (!job || job.job.status !== 'running') return;
    const id = job.job.id;
    const timer = setInterval(() => {
      void api(`/setup/jobs/${id}`, { schema: setupJobResponse, headers })
        .then(setJob)
        .catch(() => undefined);
    }, 2000);
    return () => clearInterval(timer);
  }, [job, headers]);

  const lastProgress = [...(job?.events ?? [])].reverse().find((e) => e.kind === 'progress')?.data as
    { step?: string; percent?: number } | undefined;

  if (state?.provisioned) {
    return (
      <Center mih="100vh" p="md">
        <Paper withBorder p="xl" w={520} component="main">
          <Stack>
            <Title order={1} size="h3">
              {t('setup.title')}
            </Title>
            <Alert color="blue">{t('setup.already', { domain: state.domain ?? '' })}</Alert>
            <Button component="a" href="/console/">
              {t('setup.to-login')}
            </Button>
          </Stack>
        </Paper>
      </Center>
    );
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" radius="md" w={760} component="main">
        <Stack>
          <Group justify="space-between">
            <div>
              <Title order={1} size="h2">
                {t('setup.title')}
              </Title>
              <Text c="dimmed" size="sm">
                {state ? `${state.fqdn} · ${state.os}` : t('setup.subtitle')}
              </Text>
            </div>
            <LanguageSwitch />
          </Group>
          {error ? <ErrorView error={error} /> : null}
          <Stepper active={step} size="sm" allowNextStepsSelect={false}>
            <Stepper.Step label={t('setup.step-token')}>
              <Stack mt="md">
                <Text size="sm">{t('setup.token-help')}</Text>
                <Code block>{t('setup.token-command')}</Code>
                <TextInput
                  label={t('setup.token')}
                  autoComplete="off"
                  required
                  value={token}
                  onChange={(e) => setToken(e.currentTarget.value)}
                />
                <Group justify="flex-end">
                  <Button onClick={() => void checkToken()} loading={busy} disabled={!token.trim()}>
                    {t('setup.next')}
                  </Button>
                </Group>
              </Stack>
            </Stepper.Step>

            <Stepper.Step label={t('setup.step-role')}>
              <Stack mt="md">
                <Radio.Group
                  value={role}
                  onChange={(v) => setRole(v === 'dc' ? 'dc' : 'primary-dc')}
                  label={t('setup.role')}
                >
                  <Stack mt="xs">
                    <Radio
                      value="primary-dc"
                      label={t('setup.role-primary')}
                      description={t('setup.role-primary-hint')}
                    />
                    <Radio value="dc" label={t('setup.role-dc')} description={t('setup.role-dc-hint')} />
                  </Stack>
                </Radio.Group>
                <Group justify="space-between">
                  <Button variant="default" onClick={() => setStep(0)}>
                    {t('setup.back')}
                  </Button>
                  <Button onClick={() => setStep(2)}>{t('setup.next')}</Button>
                </Group>
              </Stack>
            </Stepper.Step>

            <Stepper.Step label={t('setup.step-host')}>
              <Stack mt="md">
                <SimpleGrid cols={{ base: 1, sm: 2 }}>
                  <TextInput
                    label={t('setup.fqdn')}
                    description={t('setup.fqdn-hint')}
                    required
                    value={fqdn}
                    onChange={(e) => setFqdn(e.currentTarget.value.trim().toLowerCase())}
                    error={issue(hostIssue)}
                  />
                  <Select
                    label={t('setup.ip')}
                    description={t('setup.ip-hint')}
                    required
                    data={(state?.addresses ?? []).map((a) => ({
                      value: a.address,
                      label: `${a.address}/${String(a.prefix)} (${a.iface}${a.dynamic ? ', DHCP' : ''})`,
                    }))}
                    value={hostIp}
                    onChange={(v) => setHostIp(v ?? '')}
                  />
                  <TextInput
                    label={t('setup.domain')}
                    description={t('setup.domain-hint')}
                    required
                    value={domain}
                    onChange={(e) => {
                      setDomainTouched(true);
                      setDomain(e.currentTarget.value.trim().toLowerCase());
                    }}
                    error={domainIssue === 'mdns-local' ? null : issue(domainIssue)}
                  />
                  {role === 'primary-dc' ? (
                    <TextInput
                      label={t('setup.netbios')}
                      description={t('setup.netbios-hint')}
                      required
                      value={netbios}
                      onChange={(e) => {
                        setNetbiosTouched(true);
                        setNetbios(e.currentTarget.value.trim().toUpperCase());
                      }}
                      error={issue(nbIssue)}
                    />
                  ) : (
                    <TextInput
                      label={t('setup.dc-host')}
                      description={t('setup.dc-host-hint')}
                      required
                      value={dcHost}
                      onChange={(e) => setDcHost(e.currentTarget.value.trim())}
                    />
                  )}
                  <TextInput
                    label={t('setup.forwarders')}
                    description={t('setup.forwarders-hint')}
                    value={forwarders}
                    onChange={(e) => setForwarders(e.currentTarget.value)}
                  />
                  <TextInput
                    label={t('setup.ntp')}
                    description={t('setup.ntp-hint')}
                    value={ntp}
                    onChange={(e) => setNtp(e.currentTarget.value)}
                  />
                  <TextInput
                    label={t('setup.site')}
                    value={site}
                    onChange={(e) => setSite(e.currentTarget.value.trim())}
                  />
                  {role === 'primary-dc' ? (
                    <TextInput
                      label={t('setup.id-base')}
                      description={t('setup.id-base-hint')}
                      value={idBase}
                      onChange={(e) => setIdBase(e.currentTarget.value.replace(/\D/g, ''))}
                    />
                  ) : null}
                  {role === 'primary-dc' ? (
                    <Select
                      label={t('setup.schema')}
                      data={[...baseSchemas]}
                      value={baseSchema}
                      onChange={(v) => setBaseSchema(v ?? '2016')}
                    />
                  ) : null}
                  {role === 'primary-dc' ? (
                    <Select
                      label={t('setup.level')}
                      description={t('setup.level-hint')}
                      data={[...functionalLevels]}
                      value={level}
                      onChange={(v) => setLevel(v ?? '2008_R2')}
                    />
                  ) : null}
                  {role === 'dc' ? (
                    <TextInput
                      label={t('setup.join-user')}
                      required
                      autoComplete="username"
                      value={joinUser}
                      onChange={(e) => setJoinUser(e.currentTarget.value)}
                    />
                  ) : null}
                  {role === 'dc' ? (
                    <PasswordInput
                      label={t('setup.join-password')}
                      required
                      autoComplete="current-password"
                      value={joinPassword}
                      onChange={(e) => setJoinPassword(e.currentTarget.value)}
                    />
                  ) : null}
                </SimpleGrid>
                <Group justify="space-between">
                  <Button variant="default" onClick={() => setStep(1)}>
                    {t('setup.back')}
                  </Button>
                  <Button onClick={() => setStep(role === 'dc' ? 4 : 3)} disabled={!hostValid}>
                    {t('setup.next')}
                  </Button>
                </Group>
              </Stack>
            </Stepper.Step>

            <Stepper.Step label={t('setup.step-admin')}>
              <Stack mt="md">
                <Text size="sm">{t('setup.admin-help')}</Text>
                <PasswordInput
                  label={t('setup.admin-password')}
                  required
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                  error={pwIssue ? t(`setup.pw-${pwIssue}`) : null}
                />
                <PasswordInput
                  label={t('setup.admin-password2')}
                  required
                  autoComplete="new-password"
                  value={password2}
                  onChange={(e) => setPassword2(e.currentTarget.value)}
                  error={password2 && password2 !== password ? t('setup.pw-mismatch') : null}
                />
                <Group justify="space-between">
                  <Button variant="default" onClick={() => setStep(2)}>
                    {t('setup.back')}
                  </Button>
                  <Button onClick={() => setStep(4)} disabled={!adminValid}>
                    {t('setup.next')}
                  </Button>
                </Group>
              </Stack>
            </Stepper.Step>

            <Stepper.Step label={t('setup.step-check')}>
              <Stack mt="md">
                <Button variant="light" onClick={() => void runPreflight()} loading={busy}>
                  {preflight ? t('setup.preflight-again') : t('setup.preflight-run')}
                </Button>
                {preflight ? <CheckList result={preflight} /> : null}
                {preflight?.ok ? (
                  <Stack>
                    <Alert color="orange" title={t('setup.confirm-title')}>
                      {t(role === 'primary-dc' ? 'setup.confirm-primary' : 'setup.confirm-dc', { fqdn, domain })}
                    </Alert>
                    <TextInput
                      label={t('setup.confirm-label', { phrase: confirmationPhrase({ domain }) })}
                      autoComplete="off"
                      value={confirm}
                      onChange={(e) => setConfirm(e.currentTarget.value)}
                    />
                  </Stack>
                ) : null}
                <Group justify="space-between">
                  <Button variant="default" onClick={() => setStep(role === 'dc' ? 2 : 3)}>
                    {t('setup.back')}
                  </Button>
                  <Button
                    color="red"
                    onClick={() => void start()}
                    loading={busy}
                    disabled={!preflight?.ok || confirm.trim().toLowerCase() !== confirmationPhrase({ domain })}
                  >
                    {t(role === 'primary-dc' ? 'setup.start-primary' : 'setup.start-dc')}
                  </Button>
                </Group>
              </Stack>
            </Stepper.Step>

            <Stepper.Completed>
              <Stack mt="md">
                {job?.job.status === 'running' ? (
                  <>
                    <Text>{t('setup.running')}</Text>
                    <Progress value={lastProgress?.percent ?? 2} animated aria-label={t('setup.running')} />
                    <Text size="sm" c="dimmed">
                      {lastProgress?.step
                        ? t(`domain:setup.step.${lastProgress.step}`, { defaultValue: lastProgress.step })
                        : t('app.loading')}
                    </Text>
                  </>
                ) : null}
                {job?.job.status === 'failed' ? (
                  <>
                    <ErrorView error={job.job.error} />
                    <Button variant="default" onClick={() => setStep(4)}>
                      {t('setup.retry')}
                    </Button>
                  </>
                ) : null}
                {job?.job.status === 'succeeded' ? (
                  <>
                    <Alert color="green" title={t('setup.done-title')}>
                      {t(role === 'primary-dc' ? 'setup.done-primary' : 'setup.done-dc', { domain, fqdn })}
                    </Alert>
                    <Button component="a" href={`https://${fqdn}:${location.port || '443'}/console/`}>
                      {t('setup.to-login')}
                    </Button>
                  </>
                ) : null}
              </Stack>
            </Stepper.Completed>
          </Stepper>
        </Stack>
      </Paper>
    </Center>
  );
}
