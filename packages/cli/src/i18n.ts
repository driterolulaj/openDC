// SPDX-License-Identifier: AGPL-3.0-only
/** CLI texts (en + de) through i18next; the language follows LC_ALL / LC_MESSAGES / LANG. */
import i18next, { type TFunction } from 'i18next';
import { errorResources } from '@opendc/shared';

const cli = {
  en: {
    usage:
      'Usage: opendc <command>\n\n  registry get <key> [--explain]\n  registry set <key> <value> [--forced]\n  registry unset <key> [--forced]\n  registry list\n  registry describe <key>\n  registry commit [<key>...]\n  registry drift\n  agent info\n  version\n\nOptions: --json (machine-readable output), --socket <path>',
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
  },
  de: {
    usage:
      'Aufruf: opendc <Befehl>\n\n  registry get <Schlüssel> [--explain]\n  registry set <Schlüssel> <Wert> [--forced]\n  registry unset <Schlüssel> [--forced]\n  registry list\n  registry describe <Schlüssel>\n  registry commit [<Schlüssel>...]\n  registry drift\n  agent info\n  version\n\nOptionen: --json (maschinenlesbare Ausgabe), --socket <Pfad>',
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
