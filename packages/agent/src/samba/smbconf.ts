// SPDX-License-Identifier: AGPL-3.0-only
/** smb.conf [global] parameters: set, remove and read one parameter, keeping everything else as it is. */

const keyPattern = (name: string, rest: string): RegExp =>
  new RegExp(`^\\s*${name.trim().split(/\s+/).join('\\s+')}\\s*=${rest}`, 'i');
const sectionOf = (line: string): string | null => /^\s*\[(.+)\]\s*$/.exec(line)?.[1]?.trim().toLowerCase() ?? null;

/** Sets (value) or removes (null) one parameter in [global]; a new one goes after the section's last setting. */
export function withGlobalParam(text: string, name: string, value: string | null): string {
  const key = keyPattern(name, '');
  const line = value === null ? null : `\t${name} = ${value}`;
  const out: string[] = [];
  let inGlobal = false;
  let done = false;
  /** where a new line goes: after the last non-blank line of [global] */
  let insertAt = -1;
  const append = (): void => {
    if (inGlobal && !done && line) out.splice(insertAt + 1, 0, line);
  };
  for (const l of text.split('\n')) {
    const section = sectionOf(l);
    if (section !== null) {
      append();
      inGlobal = section === 'global';
      done = false;
      out.push(l);
      insertAt = out.length - 1;
      continue;
    }
    if (inGlobal && key.test(l)) {
      if (line && !done) out.push(line);
      done = true;
      continue;
    }
    out.push(l);
    if (inGlobal && l.trim()) insertAt = out.length - 1;
  }
  append();
  return out.join('\n');
}

/** The value of a [global] parameter, or null. */
export function globalParam(text: string, name: string): string | null {
  const key = keyPattern(name, '\\s*(.*)$');
  let inGlobal = false;
  let found: string | null = null;
  for (const l of text.split('\n')) {
    const section = sectionOf(l);
    if (section !== null) {
      inGlobal = section === 'global';
      continue;
    }
    const m = inGlobal ? key.exec(l) : null;
    if (m) found = (m[1] ?? '').trim();
  }
  return found;
}

export function withDnsForwarder(text: string, forwarders: string[]): string {
  return withGlobalParam(text, 'dns forwarder', forwarders.length ? forwarders.join(' ') : null);
}
