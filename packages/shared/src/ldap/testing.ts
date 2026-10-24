// SPDX-License-Identifier: AGPL-3.0-only
/** Deterministic random inputs for property tests (no dependency; seeded xorshift). */

const SPECIALS = ['(', ')', '*', '\\', '\u0000', ',', '+', ';', '<', '>', '"', '=', '#', ' ', '\t', '\n', '/'];
const UNICODE = ['ü', 'ß', 'č', 'é', '日', '本', '😀', ' ', '​', 'Å'];

export function* randomStrings(
  count: number,
  seed: number,
  opts: { asciiOnly?: boolean; maxLen?: number } = {},
): Generator<string> {
  let x = (seed * 2654435761) >>> 0 || 1;
  const next = (): number => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x;
  };
  const maxLen = opts.maxLen ?? 24;
  for (let n = 0; n < count; n++) {
    const len = next() % (maxLen + 1);
    let s = '';
    for (let i = 0; i < len; i++) {
      const r = next() % 10;
      if (r < 4) s += SPECIALS[next() % SPECIALS.length] ?? '';
      else if (r < 6 && !opts.asciiOnly) s += UNICODE[next() % UNICODE.length] ?? '';
      else s += String.fromCharCode(0x20 + (next() % 95));
    }
    yield s;
  }
}
