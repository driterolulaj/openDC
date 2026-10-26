// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Platform error catalogue. Every error a user or admin can see has a stable code, an HTTP status, and a
 * message plus a fix in every supported language. Messages name the cause, fixes name the next step
 * (CLAUDE.md conventions). Placeholders use i18next syntax ({{name}}), so the same texts feed the web UI's
 * "errors" namespace via `errorResources()`.
 */

export type Lang = 'en' | 'de';

interface ErrorText {
  message: string;
  fix: string;
}

interface ErrorDefinition {
  http: number;
  en: ErrorText;
  de: ErrorText;
}

const catalogue = {
  internal: {
    http: 500,
    en: {
      message: 'Internal error (request {{requestId}}).',
      fix: 'Check the journal of the OpenDC service for this request id.',
    },
    de: {
      message: 'Interner Fehler (Anfrage {{requestId}}).',
      fix: 'Prüfen Sie das Journal des OpenDC-Dienstes zu dieser Anfrage-ID.',
    },
  },
  'validation.invalid': {
    http: 400,
    en: { message: 'Invalid input: {{issues}}.', fix: 'Correct the listed fields and try again.' },
    de: {
      message: 'Ungültige Eingabe: {{issues}}.',
      fix: 'Korrigieren Sie die genannten Felder und versuchen Sie es erneut.',
    },
  },
  'request.not-found': {
    http: 404,
    en: { message: '{{what}} was not found.', fix: 'Check the address or reload the list.' },
    de: { message: '{{what}} wurde nicht gefunden.', fix: 'Prüfen Sie die Adresse oder laden Sie die Liste neu.' },
  },
  'request.conflict': {
    http: 409,
    en: {
      message: '{{what}} was changed by someone else in the meantime.',
      fix: 'Reload, review the current state and apply your change again.',
    },
    de: {
      message: '{{what}} wurde inzwischen von jemand anderem geändert.',
      fix: 'Laden Sie neu, prüfen Sie den aktuellen Stand und wiederholen Sie Ihre Änderung.',
    },
  },
  'auth.invalid-credentials': {
    http: 401,
    en: {
      message: 'User name or password is wrong.',
      fix: 'Check the spelling and keyboard layout. Repeated failures lock the account according to the domain policy.',
    },
    de: {
      message: 'Benutzername oder Passwort ist falsch.',
      fix: 'Prüfen Sie Schreibweise und Tastaturbelegung. Wiederholte Fehlversuche sperren das Konto gemäß Domänenrichtlinie.',
    },
  },
  'auth.account-locked': {
    http: 401,
    en: {
      message: 'The account is locked.',
      fix: 'Wait for the lockout to expire or ask an administrator to unlock it.',
    },
    de: {
      message: 'Das Konto ist gesperrt.',
      fix: 'Warten Sie, bis die Sperre abläuft, oder lassen Sie es von einem Administrator entsperren.',
    },
  },
  'auth.account-disabled': {
    http: 401,
    en: { message: 'The account is disabled.', fix: 'Ask an administrator to enable it.' },
    de: { message: 'Das Konto ist deaktiviert.', fix: 'Lassen Sie es von einem Administrator aktivieren.' },
  },
  'auth.password-expired': {
    http: 401,
    en: {
      message: 'The password has expired or must be changed.',
      fix: 'Change the password (self-service or at a domain workstation), then log in again.',
    },
    de: {
      message: 'Das Passwort ist abgelaufen oder muss geändert werden.',
      fix: 'Ändern Sie das Passwort (Self-Service oder an einem Domänenrechner) und melden Sie sich erneut an.',
    },
  },
  'auth.session-required': {
    http: 401,
    en: { message: 'Not logged in, or the session has expired.', fix: 'Log in again.' },
    de: { message: 'Nicht angemeldet oder die Sitzung ist abgelaufen.', fix: 'Melden Sie sich erneut an.' },
  },
  'auth.csrf': {
    http: 403,
    en: {
      message: 'The request is missing a valid CSRF token or comes from a foreign origin.',
      fix: 'Reload the console page. Requests must come from the console itself.',
    },
    de: {
      message: 'Der Anfrage fehlt ein gültiges CSRF-Token oder sie stammt von fremder Herkunft.',
      fix: 'Laden Sie die Konsole neu. Anfragen müssen aus der Konsole selbst kommen.',
    },
  },
  'auth.forbidden': {
    http: 403,
    en: {
      message: 'Permission {{permission}} is required for this action.',
      fix: 'Ask an administrator for a role that grants it for this object.',
    },
    de: {
      message: 'Für diese Aktion ist die Berechtigung {{permission}} erforderlich.',
      fix: 'Bitten Sie einen Administrator um eine Rolle, die sie für dieses Objekt gewährt.',
    },
  },
  'auth.tier0-required': {
    http: 403,
    en: {
      message: '{{target}} is a protected (tier-0) object.',
      fix: 'Only roles with tier-0 permissions can change it. Ask a Domain Admin.',
    },
    de: {
      message: '{{target}} ist ein geschütztes (Tier-0-)Objekt.',
      fix: 'Nur Rollen mit Tier-0-Berechtigungen dürfen es ändern. Wenden Sie sich an einen Domänen-Administrator.',
    },
  },
  'auth.rate-limited': {
    http: 429,
    en: { message: 'Too many requests.', fix: 'Wait {{retryAfterSec}} seconds and try again.' },
    de: { message: 'Zu viele Anfragen.', fix: 'Warten Sie {{retryAfterSec}} Sekunden und versuchen Sie es erneut.' },
  },
  'ldap.unreachable': {
    http: 503,
    en: {
      message: 'Domain controller {{host}} is not reachable ({{reason}}).',
      fix: 'Check that Samba is running on {{host}} (systemctl status samba-ad-dc) and that port {{port}} is open.',
    },
    de: {
      message: 'Domänencontroller {{host}} ist nicht erreichbar ({{reason}}).',
      fix: 'Prüfen Sie, ob Samba auf {{host}} läuft (systemctl status samba-ad-dc) und Port {{port}} offen ist.',
    },
  },
  'ldap.tls-untrusted': {
    http: 502,
    en: {
      message: 'The TLS certificate of {{host}} is not trusted ({{reason}}).',
      fix: 'Install the domain CA certificate configured in directory.ldap.caFile, or check that {{host}} is the expected DC.',
    },
    de: {
      message: 'Dem TLS-Zertifikat von {{host}} wird nicht vertraut ({{reason}}).',
      fix: 'Hinterlegen Sie das Domänen-CA-Zertifikat aus directory.ldap.caFile oder prüfen Sie, ob {{host}} der erwartete DC ist.',
    },
  },
  'ldap.operation-failed': {
    http: 502,
    en: {
      message: 'The directory rejected the operation: {{reason}} (LDAP {{ldapCode}}).',
      fix: 'Check the input. If it persists, check the Samba log on {{host}}.',
    },
    de: {
      message: 'Das Verzeichnis hat die Operation abgelehnt: {{reason}} (LDAP {{ldapCode}}).',
      fix: 'Prüfen Sie die Eingabe. Wenn es bleibt, prüfen Sie das Samba-Log auf {{host}}.',
    },
  },
  'ldap.payload-too-large': {
    http: 413,
    en: {
      message: 'Platform object {{object}} is {{size}} characters; the directory limit is {{limit}}.',
      fix: 'Reduce the payload (for example smaller images) or split it into several objects.',
    },
    de: {
      message: 'Plattformobjekt {{object}} hat {{size}} Zeichen; das Verzeichnislimit ist {{limit}}.',
      fix: 'Verkleinern Sie den Inhalt (z. B. kleinere Bilder) oder teilen Sie ihn auf mehrere Objekte auf.',
    },
  },
  'agent.unreachable': {
    http: 503,
    en: {
      message: 'The OpenDC agent socket {{socket}} is not reachable ({{reason}}).',
      fix: 'Check systemctl status opendc-agent.socket and that this service is in the socket group.',
    },
    de: {
      message: 'Der OpenDC-Agent-Socket {{socket}} ist nicht erreichbar ({{reason}}).',
      fix: 'Prüfen Sie systemctl status opendc-agent.socket und ob dieser Dienst in der Socket-Gruppe ist.',
    },
  },
  'agent.op-not-allowed': {
    http: 403,
    en: {
      message: 'Agent operation {{op}} is not allowed on the {{socket}} socket.',
      fix: 'This is a caller bug or an attack. Operations are fixed per socket at build time (ADR-0006).',
    },
    de: {
      message: 'Agent-Operation {{op}} ist am Socket {{socket}} nicht erlaubt.',
      fix: 'Das ist ein Fehler des Aufrufers oder ein Angriff. Operationen sind pro Socket beim Build festgelegt (ADR-0006).',
    },
  },
  'agent.unknown-op': {
    http: 400,
    en: {
      message: 'Unknown agent operation {{op}} (version {{version}}).',
      fix: 'Update the caller and the agent to the same OpenDC release.',
    },
    de: {
      message: 'Unbekannte Agent-Operation {{op}} (Version {{version}}).',
      fix: 'Bringen Sie Aufrufer und Agent auf dasselbe OpenDC-Release.',
    },
  },
  'agent.invalid-args': {
    http: 400,
    en: {
      message: 'Invalid arguments for {{op}}: {{issues}}.',
      fix: 'This is a caller bug; the arguments must match the operation schema exactly.',
    },
    de: {
      message: 'Ungültige Argumente für {{op}}: {{issues}}.',
      fix: 'Das ist ein Fehler des Aufrufers; die Argumente müssen exakt dem Schema der Operation entsprechen.',
    },
  },
  'agent.protocol': {
    http: 400,
    en: {
      message: 'Malformed agent request: {{reason}}.',
      fix: 'Use the OpenDC agent client; frames are newline-delimited JSON-RPC 2.0 of at most 4 MiB.',
    },
    de: {
      message: 'Fehlerhafte Agent-Anfrage: {{reason}}.',
      fix: 'Verwenden Sie den OpenDC-Agent-Client; Frames sind zeilengetrenntes JSON-RPC 2.0 mit höchstens 4 MiB.',
    },
  },
  'agent.role-refused': {
    http: 409,
    en: {
      message: 'Operation {{op}} is not available on a node with role {{role}}.',
      fix: 'Run it on a node with one of these roles: {{roles}}.',
    },
    de: {
      message: 'Operation {{op}} ist auf einem Knoten mit der Rolle {{role}} nicht verfügbar.',
      fix: 'Führen Sie sie auf einem Knoten mit einer dieser Rollen aus: {{roles}}.',
    },
  },
  'agent.confirmation-required': {
    http: 428,
    en: {
      message: 'Operation {{op}} needs a typed confirmation.',
      fix: 'Confirm the action in the console by typing the requested phrase.',
    },
    de: {
      message: 'Operation {{op}} erfordert eine getippte Bestätigung.',
      fix: 'Bestätigen Sie die Aktion in der Konsole durch Eingabe der verlangten Phrase.',
    },
  },
  'agent.confirmation-invalid': {
    http: 403,
    en: {
      message: 'The confirmation for {{op}} is invalid or expired.',
      fix: 'Start the action again and confirm within {{ttlSec}} seconds.',
    },
    de: {
      message: 'Die Bestätigung für {{op}} ist ungültig oder abgelaufen.',
      fix: 'Starten Sie die Aktion erneut und bestätigen Sie innerhalb von {{ttlSec}} Sekunden.',
    },
  },
  'agent.timeout': {
    http: 504,
    en: {
      message: 'Agent operation {{op}} did not finish within {{timeoutMs}} ms.',
      fix: 'Check journalctl -u opendc-agent for request {{requestId}}.',
    },
    de: {
      message: 'Agent-Operation {{op}} wurde nicht innerhalb von {{timeoutMs}} ms fertig.',
      fix: 'Prüfen Sie journalctl -u opendc-agent zur Anfrage {{requestId}}.',
    },
  },
  'agent.op-failed': {
    http: 500,
    en: {
      message: 'Agent operation {{op}} failed: {{reason}}.',
      fix: 'Check journalctl -u opendc-agent for request {{requestId}}.',
    },
    de: {
      message: 'Agent-Operation {{op}} ist fehlgeschlagen: {{reason}}.',
      fix: 'Prüfen Sie journalctl -u opendc-agent zur Anfrage {{requestId}}.',
    },
  },
  'agent.stale-file': {
    http: 409,
    en: {
      message: 'Managed file {{fileId}} changed since it was read (expected {{expected}}, found {{actual}}).',
      fix: 'Re-render from the current state (opendc registry commit) instead of overwriting.',
    },
    de: {
      message:
        'Verwaltete Datei {{fileId}} hat sich seit dem Lesen geändert (erwartet {{expected}}, gefunden {{actual}}).',
      fix: 'Neu aus dem aktuellen Stand rendern (opendc registry commit) statt zu überschreiben.',
    },
  },
  'registry.unknown-key': {
    http: 404,
    en: {
      message: 'Registry key {{key}} does not exist.',
      fix: 'List keys with opendc registry list; keys are declared by module manifests.',
    },
    de: {
      message: 'Registry-Schlüssel {{key}} existiert nicht.',
      fix: 'Listen Sie Schlüssel mit opendc registry list auf; Schlüssel werden in Modul-Manifesten deklariert.',
    },
  },
  'registry.invalid-value': {
    http: 400,
    en: {
      message: 'Value for {{key}} is invalid: {{issues}}.',
      fix: 'See opendc registry describe {{key}} for the expected type.',
    },
    de: {
      message: 'Wert für {{key}} ist ungültig: {{issues}}.',
      fix: 'Siehe opendc registry describe {{key}} für den erwarteten Typ.',
    },
  },
  'registry.locked': {
    http: 409,
    en: {
      message: 'Another registry commit is running (held by {{holder}} since {{since}}).',
      fix: 'Wait for it to finish. A stale lock older than {{staleSec}} s is taken over automatically.',
    },
    de: {
      message: 'Ein anderer Registry-Commit läuft (gehalten von {{holder}} seit {{since}}).',
      fix: 'Warten Sie, bis er fertig ist. Eine verwaiste Sperre älter als {{staleSec}} s wird automatisch übernommen.',
    },
  },
  'registry.commit-failed': {
    http: 500,
    en: {
      message: 'Registry commit failed at {{step}}: {{reason}}. Changed files were rolled back.',
      fix: 'Fix the cause and run opendc registry commit again.',
    },
    de: {
      message: 'Registry-Commit ist bei {{step}} fehlgeschlagen: {{reason}}. Geänderte Dateien wurden zurückgerollt.',
      fix: 'Beheben Sie die Ursache und führen Sie opendc registry commit erneut aus.',
    },
  },
  'registry.layer-corrupt': {
    http: 500,
    en: {
      message: 'Registry layer {{layer}} ({{path}}) is unreadable: {{reason}}.',
      fix: 'Restore the file from its .opendc-prev backup or remove the broken entry.',
    },
    de: {
      message: 'Registry-Ebene {{layer}} ({{path}}) ist nicht lesbar: {{reason}}.',
      fix: 'Stellen Sie die Datei aus ihrer .opendc-prev-Sicherung wieder her oder entfernen Sie den defekten Eintrag.',
    },
  },
  'os.unsupported': {
    http: 409,
    en: { message: '{{os}} is not supported for role {{role}}: {{reason}}.', fix: '{{fix}}' },
    de: { message: '{{os}} wird für die Rolle {{role}} nicht unterstützt: {{reason}}.', fix: '{{fix}}' },
  },
  'os.binary-missing': {
    http: 500,
    en: { message: 'Required program {{binary}} was not found.', fix: 'Install the package {{package}}.' },
    de: {
      message: 'Benötigtes Programm {{binary}} wurde nicht gefunden.',
      fix: 'Installieren Sie das Paket {{package}}.',
    },
  },
  'os.unknown-path-key': {
    http: 500,
    en: {
      message: 'No path is known for {{pathKey}} on {{os}}.',
      fix: 'This is a packaging bug: the OS adapter is missing an entry for this managed file.',
    },
    de: {
      message: 'Für {{pathKey}} ist auf {{os}} kein Pfad bekannt.',
      fix: 'Das ist ein Paketierungsfehler: Dem OS-Adapter fehlt ein Eintrag für diese verwaltete Datei.',
    },
  },
  'os.path-outside-roots': {
    http: 403,
    en: {
      message: 'Path {{path}} resolves outside the managed roots.',
      fix: 'Remove the symlink or bind mount that redirects it; managed files are only written under {{roots}}.',
    },
    de: {
      message: 'Pfad {{path}} liegt außerhalb der verwalteten Wurzeln.',
      fix: 'Entfernen Sie den Symlink oder Bind-Mount, der ihn umlenkt; verwaltete Dateien werden nur unter {{roots}} geschrieben.',
    },
  },
  'os.command-failed': {
    http: 500,
    en: {
      message: '{{binary}} exited with {{exitCode}}: {{stderr}}',
      fix: 'Run the same check by hand on this node to see the full output.',
    },
    de: {
      message: '{{binary}} endete mit {{exitCode}}: {{stderr}}',
      fix: 'Führen Sie dieselbe Prüfung auf diesem Knoten von Hand aus, um die vollständige Ausgabe zu sehen.',
    },
  },
  'manifest.invalid': {
    http: 500,
    en: { message: 'Module manifest {{module}} is invalid: {{issues}}.', fix: 'Fix the manifest and run npm run gen.' },
    de: {
      message: 'Modul-Manifest {{module}} ist ungültig: {{issues}}.',
      fix: 'Korrigieren Sie das Manifest und führen Sie npm run gen aus.',
    },
  },
  'db.migration-failed': {
    http: 500,
    en: {
      message: 'Platform DB migration {{migration}} failed: {{reason}}.',
      fix: 'Restore {{path}} from backup or remove it to start with an empty node-local DB (the audit log re-replicates from peers).',
    },
    de: {
      message: 'Migration {{migration}} der Plattform-DB ist fehlgeschlagen: {{reason}}.',
      fix: 'Stellen Sie {{path}} aus der Sicherung wieder her oder entfernen Sie sie für eine leere knotenlokale DB (das Audit-Log repliziert sich von den Peers neu).',
    },
  },
  'audit.chain-broken': {
    http: 500,
    en: {
      message: 'Audit hash chain of origin {{origin}} is broken at sequence {{seq}}.',
      fix: 'Treat this as possible tampering: preserve {{path}} and compare with a peer DC copy.',
    },
    de: {
      message: 'Die Audit-Hashkette des Ursprungs {{origin}} ist bei Sequenz {{seq}} unterbrochen.',
      fix: 'Behandeln Sie das als mögliche Manipulation: Sichern Sie {{path}} und vergleichen Sie mit der Kopie eines anderen DCs.',
    },
  },
  'setup.token-invalid': {
    http: 401,
    en: {
      message: 'The setup token is missing or wrong.',
      fix: 'Copy the token from the installation output or run "sudo opendc setup token" on the host.',
    },
    de: {
      message: 'Das Setup-Token fehlt oder ist falsch.',
      fix: 'Übernehmen Sie das Token aus der Installationsausgabe oder führen Sie "sudo opendc setup token" auf dem Host aus.',
    },
  },
  'setup.already-provisioned': {
    http: 409,
    en: {
      message: 'This host is already part of domain {{domain}}; setup is closed.',
      fix: 'Log in to the console with a domain account. To start over, use a fresh host.',
    },
    de: {
      message: 'Dieser Host gehört bereits zur Domäne {{domain}}; das Setup ist abgeschlossen.',
      fix: 'Melden Sie sich mit einem Domänenkonto an der Konsole an. Für einen Neuanfang verwenden Sie einen frischen Host.',
    },
  },
  'setup.preflight-failed': {
    http: 412,
    en: {
      message: 'Pre-flight checks failed: {{checks}}.',
      fix: 'Fix the failed checks shown in the setup report, then run setup again.',
    },
    de: {
      message: 'Vorabprüfungen fehlgeschlagen: {{checks}}.',
      fix: 'Beheben Sie die im Setup-Bericht gezeigten Fehler und starten Sie das Setup erneut.',
    },
  },
  'setup.step-failed': {
    http: 500,
    en: {
      message: 'Setup step "{{step}}" failed: {{reason}}',
      fix: 'Fix the cause and run setup again; completed steps are skipped. Details: journalctl -u opendc-agent.',
    },
    de: {
      message: 'Setup-Schritt "{{step}}" fehlgeschlagen: {{reason}}',
      fix: 'Beheben Sie die Ursache und starten Sie das Setup erneut; erledigte Schritte werden übersprungen. Details: journalctl -u opendc-agent.',
    },
  },
  'auth.totp-required': {
    http: 401,
    en: {
      message: 'This account uses a second factor: enter the code from your authenticator app.',
      fix: 'Enter the 6-digit code (or a recovery code) together with your password.',
    },
    de: {
      message: 'Dieses Konto verwendet einen zweiten Faktor: Geben Sie den Code aus Ihrer Authenticator-App ein.',
      fix: 'Geben Sie den 6-stelligen Code (oder einen Wiederherstellungscode) zusammen mit Ihrem Passwort ein.',
    },
  },
  'auth.totp-invalid': {
    http: 401,
    en: {
      message: 'The authenticator code is wrong or expired.',
      fix: "Check the device's clock and enter the current code, or use a recovery code.",
    },
    de: {
      message: 'Der Authenticator-Code ist falsch oder abgelaufen.',
      fix: 'Prüfen Sie die Uhrzeit des Geräts und geben Sie den aktuellen Code ein, oder verwenden Sie einen Wiederherstellungscode.',
    },
  },
  'auth.mfa-setup-required': {
    http: 403,
    en: {
      message: 'Your role requires a second factor, and none is set up yet.',
      fix: 'Set up an authenticator app in the console (it asks you right after login).',
    },
    de: {
      message: 'Ihre Rolle verlangt einen zweiten Faktor, und es ist noch keiner eingerichtet.',
      fix: 'Richten Sie in der Konsole eine Authenticator-App ein (Sie werden direkt nach der Anmeldung gefragt).',
    },
  },
  'auth.reauth-required': {
    http: 403,
    en: {
      message: 'This tier-0 action needs a fresh sign-in (more than {{minutes}} minutes ago).',
      fix: 'Confirm your password (and authenticator code) and repeat the action.',
    },
    de: {
      message: 'Diese Tier-0-Aktion braucht eine frische Anmeldung (die letzte ist über {{minutes}} Minuten her).',
      fix: 'Bestätigen Sie Ihr Passwort (und den Authenticator-Code) und wiederholen Sie die Aktion.',
    },
  },
  'auth.token-invalid': {
    http: 401,
    en: {
      message: 'The API token is unknown, revoked or expired.',
      fix: 'Create a new token in the console (Account → API tokens).',
    },
    de: {
      message: 'Das API-Token ist unbekannt, widerrufen oder abgelaufen.',
      fix: 'Erstellen Sie in der Konsole ein neues Token (Konto → API-Tokens).',
    },
  },
  'directory.not-configured': {
    http: 503,
    en: {
      message: 'This node has no directory service account yet.',
      fix: 'Complete the setup (wizard or opendc setup), then restart opendc-api.',
    },
    de: {
      message: 'Dieser Knoten hat noch kein Verzeichnis-Dienstkonto.',
      fix: 'Schließen Sie das Setup ab (Assistent oder opendc setup) und starten Sie opendc-api neu.',
    },
  },
  'directory.access-denied': {
    http: 403,
    en: {
      message: 'The directory refused the change to {{what}}.',
      fix: "The object may be protected (tier 0) or outside the delegation of the platform account. Use a tier-0 role, or check the object's permissions.",
    },
    de: {
      message: 'Das Verzeichnis hat die Änderung an {{what}} abgelehnt.',
      fix: 'Das Objekt ist vielleicht geschützt (Tier 0) oder liegt außerhalb der Delegation des Plattformkontos. Verwenden Sie eine Tier-0-Rolle oder prüfen Sie die Berechtigungen des Objekts.',
    },
  },
  'directory.exists': {
    http: 409,
    en: { message: '{{what}} already exists.', fix: 'Choose another name.' },
    de: { message: '{{what}} existiert bereits.', fix: 'Wählen Sie einen anderen Namen.' },
  },
  'directory.password-rejected': {
    http: 422,
    en: {
      message: "The password doesn't meet the password policy of {{what}}.",
      fix: 'Use a longer password with upper and lower case, digits and symbols that was not used recently and does not contain the user name.',
    },
    de: {
      message: 'Das Passwort erfüllt die Passwortrichtlinie für {{what}} nicht.',
      fix: 'Verwenden Sie ein längeres Passwort mit Groß- und Kleinbuchstaben, Ziffern und Sonderzeichen, das nicht kürzlich verwendet wurde und den Benutzernamen nicht enthält.',
    },
  },
  'directory.not-empty': {
    http: 409,
    en: {
      message: '{{what}} is not empty.',
      fix: 'Move or delete the objects in it first, or delete it recursively.',
    },
    de: {
      message: '{{what}} ist nicht leer.',
      fix: 'Verschieben oder löschen Sie zuerst die enthaltenen Objekte, oder löschen Sie rekursiv.',
    },
  },
  'directory.invalid': {
    http: 400,
    en: { message: 'The directory rejected the value: {{reason}}.', fix: 'Correct the value and try again.' },
    de: {
      message: 'Das Verzeichnis hat den Wert abgelehnt: {{reason}}.',
      fix: 'Korrigieren Sie den Wert und versuchen Sie es erneut.',
    },
  },
  'directory.unsupported': {
    http: 422,
    en: {
      message: '{{what}} is not possible from the console.',
      fix: 'Use RSAT or samba-tool as a Domain Admin for this change.',
    },
    de: {
      message: '{{what}} ist über die Konsole nicht möglich.',
      fix: 'Verwenden Sie für diese Änderung RSAT oder samba-tool als Domänen-Administrator.',
    },
  },
  'dns.record-exists': {
    http: 409,
    en: { message: '{{record}} already exists in {{zone}}.', fix: 'Change or delete the existing record instead.' },
    de: {
      message: '{{record}} existiert bereits in {{zone}}.',
      fix: 'Ändern oder löschen Sie stattdessen den vorhandenen Eintrag.',
    },
  },
  'dns.not-found': {
    http: 404,
    en: { message: '{{what}} does not exist in DNS.', fix: 'Reload the list; someone may have changed it meanwhile.' },
    de: {
      message: '{{what}} existiert im DNS nicht.',
      fix: 'Laden Sie die Liste neu; jemand hat sie womöglich inzwischen geändert.',
    },
  },
  'dns.protected': {
    http: 409,
    en: {
      message: "{{what}} is needed by Active Directory and can't be deleted.",
      fix: 'Domain controllers register these records and zones themselves.',
    },
    de: {
      message: '{{what}} wird vom Active Directory benötigt und kann nicht gelöscht werden.',
      fix: 'Domänencontroller registrieren diese Einträge und Zonen selbst.',
    },
  },
  'gpo.not-pdc': {
    http: 409,
    en: {
      message: 'Group policies are changed on the PDC emulator ({{pdc}}), not on this domain controller.',
      fix: 'Open the console on {{pdc}}: SYSVOL is copied from there to the other domain controllers.',
    },
    de: {
      message: 'Gruppenrichtlinien werden auf dem PDC-Emulator ({{pdc}}) geändert, nicht auf diesem Domänencontroller.',
      fix: 'Öffnen Sie die Konsole auf {{pdc}}: SYSVOL wird von dort auf die anderen Domänencontroller kopiert.',
    },
  },
  'gpo.not-found': {
    http: 404,
    en: { message: '{{what}} does not exist.', fix: 'Reload the list; someone may have changed it meanwhile.' },
    de: {
      message: '{{what}} existiert nicht.',
      fix: 'Laden Sie die Liste neu; jemand hat sie womöglich inzwischen geändert.',
    },
  },
  'gpo.failed': {
    http: 502,
    en: {
      message: 'Samba refused the group policy change: {{reason}}',
      fix: 'Check the agent log (journalctl -u opendc-agent) and the Samba log (journalctl -u samba-ad-dc).',
    },
    de: {
      message: 'Samba hat die Gruppenrichtlinien-Änderung abgelehnt: {{reason}}',
      fix: 'Prüfen Sie das Agent-Protokoll (journalctl -u opendc-agent) und das Samba-Protokoll (journalctl -u samba-ad-dc).',
    },
  },
  'dns.failed': {
    http: 502,
    en: {
      message: 'The DNS server refused the change: {{reason}}',
      fix: 'Check the record and the DNS server log (journalctl -u samba-ad-dc).',
    },
    de: {
      message: 'Der DNS-Server hat die Änderung abgelehnt: {{reason}}',
      fix: 'Prüfen Sie den Eintrag und das DNS-Server-Protokoll (journalctl -u samba-ad-dc).',
    },
  },
  'samba.not-provisioned': {
    http: 409,
    en: {
      message: 'This host is not a domain controller yet.',
      fix: 'Run the setup wizard or "opendc setup" first.',
    },
    de: {
      message: 'Dieser Host ist noch kein Domänencontroller.',
      fix: 'Führen Sie zuerst den Setup-Assistenten oder "opendc setup" aus.',
    },
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ErrorCode = keyof typeof catalogue;
export type ErrorParams = Record<string, string | number>;

export const errorCodes = Object.keys(catalogue) as ErrorCode[];

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(catalogue, value);
}

export function httpStatus(code: ErrorCode): number {
  return catalogue[code].http;
}

/** i18next-compatible interpolation of {{name}} placeholders. Unknown placeholders stay visible. */
export function interpolate(template: string, params: ErrorParams): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : whole,
  );
}

export function renderError(code: ErrorCode, params: ErrorParams, lang: Lang = 'en'): ErrorText {
  const t = catalogue[code][lang];
  return { message: interpolate(t.message, params), fix: interpolate(t.fix, params) };
}

/** Resources for i18next: `{ en: { "<code>": { message, fix } }, de: ... }`. */
export function errorResources(): Record<Lang, Record<string, ErrorText>> {
  const out: Record<Lang, Record<string, ErrorText>> = { en: {}, de: {} };
  for (const code of errorCodes) {
    out.en[code] = catalogue[code].en;
    out.de[code] = catalogue[code].de;
  }
  return out;
}

/** Wire shape of an error (API responses, agent JSON-RPC error data, CLI output). */
export interface ErrorBody {
  code: ErrorCode;
  /** English message, for logs and API clients without i18n. */
  message: string;
  fix: string;
  params: ErrorParams;
}

export class PlatformError extends Error {
  readonly code: ErrorCode;
  readonly params: ErrorParams;
  readonly fix: string;

  constructor(code: ErrorCode, params: ErrorParams = {}, options?: { cause?: unknown }) {
    const text = renderError(code, params);
    super(text.message, options);
    this.name = 'PlatformError';
    this.code = code;
    this.params = params;
    this.fix = text.fix;
  }

  get httpStatus(): number {
    return httpStatus(this.code);
  }

  toBody(): ErrorBody {
    return { code: this.code, message: this.message, fix: this.fix, params: this.params };
  }

  static fromBody(body: ErrorBody): PlatformError {
    return isErrorCode(body.code) ? new PlatformError(body.code, body.params) : new PlatformError('internal', {});
  }
}

export function isPlatformError(e: unknown): e is PlatformError {
  return e instanceof PlatformError;
}
