// SPDX-License-Identifier: AGPL-3.0-only
/** Texts for the "os" i18n namespace (support matrix reasons and fixes). */
export const osI18n = {
  en: {
    support: {
      'release-not-tier1': '{{os}} is not a supported release.',
      'release-not-tier1-fix': 'Install a Tier-1 release: Debian 12/13 or Ubuntu 24.04/26.04.',
      'samba-not-installed': 'Samba is not installed yet; version {{min}} or later is required for the DC role.',
      'samba-too-old': 'Samba {{version}} is too old for the DC role (minimum {{min}}).',
      'enable-bookworm-backports':
        'Enable bookworm-backports and install Samba from it: apt install -t bookworm-backports samba samba-ad-dc winbind.',
      'upgrade-samba': 'Upgrade Samba to {{min}} or later with the distribution updates.',
    },
  },
  de: {
    support: {
      'release-not-tier1': '{{os}} ist kein unterstütztes Release.',
      'release-not-tier1-fix': 'Installieren Sie ein Tier-1-Release: Debian 12/13 oder Ubuntu 24.04/26.04.',
      'samba-not-installed': 'Samba ist noch nicht installiert; für die DC-Rolle ist Version {{min}} oder neuer nötig.',
      'samba-too-old': 'Samba {{version}} ist für die DC-Rolle zu alt (Minimum {{min}}).',
      'enable-bookworm-backports':
        'Aktivieren Sie bookworm-backports und installieren Sie Samba daraus: apt install -t bookworm-backports samba samba-ad-dc winbind.',
      'upgrade-samba': 'Aktualisieren Sie Samba über die Distributions-Updates auf {{min}} oder neuer.',
    },
  },
} as const;
