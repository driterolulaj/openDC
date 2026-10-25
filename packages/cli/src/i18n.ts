// SPDX-License-Identifier: AGPL-3.0-only
/** CLI texts (en + de) through i18next; the language follows LC_ALL / LC_MESSAGES / LANG. */
import i18next, { type TFunction } from 'i18next';
import { errorResources } from '@opendc/shared';

const cli = {
  en: {
    usage:
      'Usage: opendc <command>\n\n  setup status | token\n  setup preflight primary-dc|dc --fqdn <fqdn> --ip <address> [--domain <dns domain>] [--netbios <name>] [--forwarder <ip>]... [--dc <dc>]\n  setup provision --fqdn <fqdn> --ip <address> [--domain <dns domain>] [--netbios <name>] [--forwarder <ip>]... [--ntp <server>]... [--ntp-allow <cidr>]... [--schema 2012_R2|2016] [--level 2008_R2|2012|2012_R2|2016] [--site <name>] [--id-base <n>] [--password-file <file>|-] [--confirm <domain>]\n  setup join --fqdn <fqdn> --ip <address> --dc <dc> [--domain <dns domain>] [--user <name>] [--password-file <file>|-] [--forwarder <ip>]... [--confirm <domain>]\n  registry get <key> [--explain]\n  registry set <key> <value> [--forced]\n  registry unset <key> [--forced]\n  registry list\n  registry describe <key>\n  registry commit [<key>...]\n  registry drift\n  agent info\n  version\n\nOptions: --json (machine-readable output), --socket <path>',
    'unknown-command': 'Unknown command "{{command}}". Run opendc --help.',
    'missing-arg': 'Missing argument: {{name}}.',
    explain: '{{key}} = {{value}}  (from {{layer}})',
    'explain-layer': '  {{layer}}: {{value}}{{ignored}}',
    ignored: '  [ignored: invalid or not allowed in this layer]',
    'set-done': '{{key}} set in the {{layer}} layer.',
    'unset-done': '{{key}} removed from the {{layer}} layer.',
    'commit-done': 'Rendered {{rendered}} file(s), changed {{changed}}, handlers: {{handlers}}.',
    none: 'none',
    'drift-none': 'No drift: every managed file matches what the registry rendered.',
    'drift-line': '  {{fileId}}: {{state}}',
    'drift-found': 'Drift found in {{count}} managed file(s). Run opendc registry commit to restore them:',
    'drift-modified': 'modified by hand',
    'drift-missing': 'missing',
    'drift-never-rendered': 'never rendered',
    'invalid-values': 'Ignored layer values:',
    'invalid-line': '  {{layer}} {{key}}: {{issues}}',
    describe:
      '{{key}}\n  {{description}}\n  default: {{default}}\n  policy settable: {{policy}}\n  effect when changed: {{effect}}',
    yes: 'yes',
    no: 'no',
    error: 'Error: {{message}}\nFix: {{fix}}',
    'preflight-ok': "Pre-flight checks passed (warnings don't block setup).",
    'preflight-failed': 'Pre-flight checks failed. Fix the [FAIL] items above, then run setup again.',
    'setup-no-token': 'No setup token: this host is already set up, or opendc setup token was not run as root.',
    'setup-status-done': 'Set up: {{fqdn}} is a {{role}} of {{domain}}.',
    'setup-status-open':
      'Not set up yet: {{fqdn}} ({{os}}), addresses {{addresses}}. Run opendc setup provision or join.',
    'setup-need-root': 'opendc setup provision/join must run as root (sudo opendc setup ...).',
    'setup-confirm': 'This changes the host irreversibly. Type the domain name ({{phrase}}) to continue: ',
    'setup-confirm-mismatch': 'Confirmation did not match "{{phrase}}"; nothing was changed.',
    'setup-password-prompt': 'Password for the domain Administrator: ',
    'setup-join-password-prompt': 'Password of {{user}}: ',
    'setup-provisioned':
      'Domain {{domain}} is up. {{fqdn}} is its first DC. Log in at https://{{fqdn}}:8443/console/ as Administrator.',
    'setup-joined': '{{fqdn}} joined {{domain}} as an additional DC.',
  },
  de: {
    usage:
      'Aufruf: opendc <Befehl>\n\n  setup status | token\n  setup preflight primary-dc|dc --fqdn <FQDN> --ip <Adresse> [--domain <DNS-Domäne>] [--netbios <Name>] [--forwarder <IP>]... [--dc <DC>]\n  setup provision --fqdn <FQDN> --ip <Adresse> [--domain <DNS-Domäne>] [--netbios <Name>] [--forwarder <IP>]... [--ntp <Server>]... [--ntp-allow <CIDR>]... [--schema 2012_R2|2016] [--level 2008_R2|2012|2012_R2|2016] [--site <Name>] [--id-base <n>] [--password-file <Datei>|-] [--confirm <Domäne>]\n  setup join --fqdn <FQDN> --ip <Adresse> --dc <DC> [--domain <DNS-Domäne>] [--user <Name>] [--password-file <Datei>|-] [--forwarder <IP>]... [--confirm <Domäne>]\n  registry get <Schlüssel> [--explain]\n  registry set <Schlüssel> <Wert> [--forced]\n  registry unset <Schlüssel> [--forced]\n  registry list\n  registry describe <Schlüssel>\n  registry commit [<Schlüssel>...]\n  registry drift\n  agent info\n  version\n\nOptionen: --json (maschinenlesbare Ausgabe), --socket <Pfad>',
    'unknown-command': 'Unbekannter Befehl "{{command}}". Siehe opendc --help.',
    'missing-arg': 'Fehlendes Argument: {{name}}.',
    explain: '{{key}} = {{value}}  (aus {{layer}})',
    'explain-layer': '  {{layer}}: {{value}}{{ignored}}',
    ignored: '  [ignoriert: ungültig oder in dieser Ebene nicht erlaubt]',
    'set-done': '{{key}} in der Ebene {{layer}} gesetzt.',
    'unset-done': '{{key}} aus der Ebene {{layer}} entfernt.',
    'commit-done': '{{rendered}} Datei(en) gerendert, {{changed}} geändert, Handler: {{handlers}}.',
    none: 'keine',
    'drift-none': 'Keine Abweichung: Alle verwalteten Dateien entsprechen dem, was die Registry gerendert hat.',
    'drift-line': '  {{fileId}}: {{state}}',
    'drift-found': 'Abweichung in {{count}} verwalteten Datei(en). opendc registry commit stellt sie wieder her:',
    'drift-modified': 'von Hand geändert',
    'drift-missing': 'fehlt',
    'drift-never-rendered': 'nie gerendert',
    'invalid-values': 'Ignorierte Ebenenwerte:',
    'invalid-line': '  {{layer}} {{key}}: {{issues}}',
    describe:
      '{{key}}\n  {{description}}\n  Standard: {{default}}\n  per Richtlinie setzbar: {{policy}}\n  Wirkung bei Änderung: {{effect}}',
    yes: 'ja',
    no: 'nein',
    error: 'Fehler: {{message}}\nAbhilfe: {{fix}}',
    'preflight-ok': 'Vorabprüfungen bestanden (Warnungen blockieren das Setup nicht).',
    'preflight-failed':
      'Vorabprüfungen fehlgeschlagen. Beheben Sie die [FAIL]-Punkte oben und starten Sie das Setup erneut.',
    'setup-no-token':
      'Kein Setup-Token: Dieser Host ist bereits eingerichtet, oder opendc setup token lief nicht als root.',
    'setup-status-done': 'Eingerichtet: {{fqdn}} ist ein {{role}} von {{domain}}.',
    'setup-status-open':
      'Noch nicht eingerichtet: {{fqdn}} ({{os}}), Adressen {{addresses}}. Führen Sie opendc setup provision oder join aus.',
    'setup-need-root': 'opendc setup provision/join muss als root laufen (sudo opendc setup ...).',
    'setup-confirm':
      'Dies verändert den Host unumkehrbar. Geben Sie zur Bestätigung den Domänennamen ({{phrase}}) ein: ',
    'setup-confirm-mismatch': 'Die Bestätigung stimmt nicht mit "{{phrase}}" überein; nichts wurde geändert.',
    'setup-password-prompt': 'Passwort für den Domänen-Administrator: ',
    'setup-join-password-prompt': 'Passwort von {{user}}: ',
    'setup-provisioned':
      'Die Domäne {{domain}} läuft. {{fqdn}} ist ihr erster DC. Anmeldung unter https://{{fqdn}}:8443/console/ als Administrator.',
    'setup-joined': '{{fqdn}} ist {{domain}} als weiterer DC beigetreten.',
  },
};

export function detectLang(env: NodeJS.ProcessEnv = process.env): 'en' | 'de' {
  const v = env.LC_ALL || env.LC_MESSAGES || env.LANG || '';
  return v.toLowerCase().startsWith('de') ? 'de' : 'en';
}

export async function initI18n(
  moduleResources: Record<'en' | 'de', Record<string, unknown>>,
  lang = detectLang(),
): Promise<TFunction> {
  const errors = errorResources();
  return i18next.createInstance().init({
    lng: lang,
    fallbackLng: 'en',
    defaultNS: 'cli',
    interpolation: { escapeValue: false },
    resources: {
      en: { cli: cli.en, errors: errors.en, ...moduleResources.en },
      de: { cli: cli.de, errors: errors.de, ...moduleResources.de },
    },
  });
}
