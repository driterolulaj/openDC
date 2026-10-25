// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CSV (RFC 4180) for directory import/export, in-house per DEPENDENCIES.md (csv-parse rejected). Accepts a
 * UTF-8 BOM, CRLF or LF, quoted fields with embedded quotes/newlines, and comma or semicolon separators
 * (German spreadsheet exports use ";"). Export neutralises spreadsheet formulas (CSV injection).
 */
import { PlatformError } from '@opendc/shared';

export function detectDelimiter(text: string): ',' | ';' {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === ',') commas++;
    else if (!quoted && ch === ';') semis++;
  }
  return semis > commas ? ';' : ',';
}

/** Parses CSV text into rows of fields. Throws validation.invalid on an unterminated quote. */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let line = 1;
  while (i < s.length) {
    const ch = s[i] ?? '';
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      if (ch === '\n') line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === '') {
      quoted = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
      continue;
    }
    if (ch === '\r' && s[i + 1] === '\n') {
      i++;
      continue;
    }
    if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      line++;
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  if (quoted)
    throw new PlatformError('validation.invalid', { issues: `csv: unterminated quoted field (line ${String(line)})` });
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // drop blank lines
  return rows.filter((r) => r.some((f) => f.trim() !== ''));
}

/** A cell that a spreadsheet would run as a formula gets a leading apostrophe. */
function neutralise(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

export function toCsv(
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
  delimiter = ',',
): string {
  return (
    rows
      .map((r) =>
        r
          .map((v) => {
            const s = neutralise(v === null || v === undefined ? '' : String(v));
            return /["\r\n]|[,;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(delimiter),
      )
      .join('\r\n') + '\r\n'
  );
}

/** Header aliases (lower case, without spaces/underscores/dashes) -> canonical column names. */
const ALIASES: Record<string, string> = {
  sam: 'sam',
  samaccountname: 'sam',
  username: 'sam',
  login: 'sam',
  account: 'sam',
  givenname: 'givenName',
  firstname: 'givenName',
  vorname: 'givenName',
  sn: 'sn',
  surname: 'sn',
  lastname: 'sn',
  nachname: 'sn',
  displayname: 'displayName',
  initials: 'initials',
  description: 'description',
  mail: 'mail',
  email: 'mail',
  userprincipalname: 'userPrincipalName',
  upn: 'userPrincipalName',
  telephonenumber: 'telephoneNumber',
  phone: 'telephoneNumber',
  telefon: 'telephoneNumber',
  mobile: 'mobile',
  title: 'title',
  department: 'department',
  abteilung: 'department',
  company: 'company',
  office: 'office',
  physicaldeliveryofficename: 'office',
  streetaddress: 'streetAddress',
  city: 'city',
  l: 'city',
  postalcode: 'postalCode',
  country: 'country',
  c: 'country',
  employeeid: 'employeeId',
  homedirectory: 'homeDirectory',
  homedrive: 'homeDrive',
  profilepath: 'profilePath',
  scriptpath: 'scriptPath',
  loginshell: 'loginShell',
  unixhomedirectory: 'unixHomeDirectory',
  accountexpires: 'accountExpires',
  enabled: 'enabled',
  groups: 'groups',
  password: 'password',
};

export function canonicalColumn(header: string): string | null {
  return (
    ALIASES[
      header
        .trim()
        .toLowerCase()
        .replace(/[\s_-]/g, '')
    ] ?? null
  );
}
