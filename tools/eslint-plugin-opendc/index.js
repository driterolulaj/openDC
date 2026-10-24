// SPDX-License-Identifier: AGPL-3.0-only
// Project lint rules that enforce CLAUDE.md hard rules 3 (no shell strings), 4 (no distro checks outside
// packages/os), 7 (LDAP filters/DNs only via the escaping helpers) and 10 (UI strings through i18next).

const norm = (f) => f.replaceAll('\\', '/');

/** Path predicates. Tests may opt in to rules explicitly through the config, so these only look at paths. */
const inPackage = (file, ...pkgs) => pkgs.some((p) => norm(file).includes(`/packages/${p}/`));
const inLdapHelpers = (file) => norm(file).includes('/packages/shared/src/ldap/');

const CHILD_PROCESS = new Set(['child_process', 'node:child_process']);
const BANNED_EXEC = new Set(['exec', 'execSync']);

/** @type {import('eslint').Rule.RuleModule} */
const noShellExec = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid shell execution; child_process only in packages/agent and packages/os' },
    messages: {
      importOutside: 'child_process may only be imported in packages/agent or packages/os (ADR-0006).',
      bannedFn: '"{{name}}" runs a shell. Use execFile/spawn with an argv array and shell: false.',
      shellTrue: 'shell: true is forbidden. Pass an argv array instead.',
    },
    schema: [{ type: 'object', properties: { allowImport: { type: 'boolean' } }, additionalProperties: false }],
  },
  create(context) {
    const file = context.filename;
    // Build tooling may import child_process; exec/execSync/shell:true stay banned everywhere.
    const allowed = inPackage(file, 'agent', 'os') || context.options[0]?.allowImport === true;
    const localNames = new Set();
    const nsNames = new Set();
    return {
      ImportDeclaration(node) {
        if (!CHILD_PROCESS.has(node.source.value)) return;
        if (!allowed) context.report({ node, messageId: 'importOutside' });
        for (const s of node.specifiers) {
          if (s.type === 'ImportSpecifier' && BANNED_EXEC.has(s.imported.name)) {
            context.report({ node: s, messageId: 'bannedFn', data: { name: s.imported.name } });
            localNames.add(s.local.name);
          } else if (s.type !== 'ImportSpecifier') {
            nsNames.add(s.local.name);
          }
        }
      },
      ImportExpression(node) {
        if (node.source.type === 'Literal' && CHILD_PROCESS.has(node.source.value) && !allowed) {
          context.report({ node, messageId: 'importOutside' });
        }
      },
      CallExpression(node) {
        const c = node.callee;
        if (c.type === 'Identifier' && localNames.has(c.name)) {
          context.report({ node, messageId: 'bannedFn', data: { name: c.name } });
        }
        if (
          c.type === 'MemberExpression' &&
          c.object.type === 'Identifier' &&
          nsNames.has(c.object.name) &&
          c.property.type === 'Identifier' &&
          BANNED_EXEC.has(c.property.name)
        ) {
          context.report({ node, messageId: 'bannedFn', data: { name: c.property.name } });
        }
      },
      Property(node) {
        const key = node.key.type === 'Identifier' ? node.key.name : node.key.value;
        if (key === 'shell' && !(node.value.type === 'Literal' && node.value.value === false)) {
          context.report({ node, messageId: 'shellTrue' });
        }
      },
    };
  },
};

// "(attr=", "(&(", "(|(", ... directly followed by an interpolation.
const FILTER_TAIL = /\((?:[&|!]\()*[A-Za-z][\w-]*(?:;[\w-]+)*(?::[\w.:-]*)?[~<>]?=$/;
// "CN=" at the start of the string, or ",OU=" after an RDN separator, directly followed by an interpolation.
const DN_TAIL_FIRST = /(?:^|,)\s*[A-Za-z][\w-]*=$/;
const DN_TAIL_LATER = /,\s*[A-Za-z][\w-]*=$/;
const FILTER_OR_DN_TAIL = new RegExp(`${FILTER_TAIL.source}|${DN_TAIL_FIRST.source}`);
const LOOKS_LIKE_FILTER = /^\s*\(.*=/;

/** @type {import('eslint').Rule.RuleModule} */
const noRawLdap = {
  meta: {
    type: 'problem',
    docs: { description: 'LDAP filters and DNs must be built with the escaping helpers (packages/shared/src/ldap)' },
    messages: {
      interpolated:
        'Interpolated value inside an LDAP filter/DN. Use filter`...`/eq() or childDn()/buildDn() from @opendc/shared/ldap (RFC 4515/4514 escaping).',
      concatenated: 'String concatenation into an LDAP filter. Use the filter builders from @opendc/shared/ldap.',
    },
    schema: [],
  },
  create(context) {
    if (inLdapHelpers(context.filename)) return {};
    return {
      TemplateLiteral(node) {
        // Tagged templates are fine when the tag is one of our escaping builders.
        if (node.parent.type === 'TaggedTemplateExpression') return;
        for (let i = 0; i < node.expressions.length; i++) {
          const before = node.quasis[i].value.cooked ?? '';
          // Only the first chunk can start a DN; later chunks follow an interpolation, so they need a comma.
          if (FILTER_TAIL.test(before) || (i === 0 ? DN_TAIL_FIRST : DN_TAIL_LATER).test(before)) {
            context.report({ node: node.expressions[i], messageId: 'interpolated' });
          }
        }
      },
      BinaryExpression(node) {
        if (node.operator !== '+') return;
        const lit = [node.left, node.right].find((n) => n.type === 'Literal' && typeof n.value === 'string');
        if (lit && LOOKS_LIKE_FILTER.test(lit.value) && FILTER_OR_DN_TAIL.test(lit.value)) {
          context.report({ node, messageId: 'concatenated' });
        }
      },
    };
  },
};

const DISTRO_IDS = new Set([
  'debian',
  'ubuntu',
  'rhel',
  'rocky',
  'almalinux',
  'centos',
  'fedora',
  'opensuse',
  'opensuse-leap',
  'sles',
  'suse',
  'arch',
  'alpine',
]);

/** @type {import('eslint').Rule.RuleModule} */
const noDistroCheck = {
  meta: {
    type: 'problem',
    docs: { description: 'Distro detection belongs in packages/os (ADR-0008)' },
    messages: {
      distro: 'Distro-specific literal "{{value}}" outside packages/os. Ask the OS adapter (OsFacts) instead.',
    },
    schema: [],
  },
  create(context) {
    if (inPackage(context.filename, 'os')) return {};
    const check = (node, value) => {
      if (typeof value !== 'string') return;
      const v = value.toLowerCase();
      if (DISTRO_IDS.has(v) || v.includes('/etc/os-release') || v.includes('/etc/debian_version')) {
        context.report({ node, messageId: 'distro', data: { value } });
      }
    };
    return {
      Literal(node) {
        // Skip import sources and object keys (e.g. a support-matrix key is still data, but belongs in os anyway).
        if (node.parent.type === 'ImportDeclaration') return;
        check(node, node.value);
      },
      TemplateElement(node) {
        check(node, node.value.cooked);
      },
    };
  },
};

/** @type {import('eslint').Rule.RuleModule} */
const noLiteralJsxText = {
  meta: {
    type: 'problem',
    docs: { description: 'User-visible text must go through i18next (en + de)' },
    messages: { literal: 'Hard-coded UI text "{{text}}". Use t("namespace:key") and add the key to en and de.' },
    schema: [],
  },
  create(context) {
    const TEXT_ATTRS = new Set(['title', 'label', 'placeholder', 'alt', 'aria-label', 'description']);
    const hasLetters = (s) => /\p{L}/u.test(s);
    return {
      JSXText(node) {
        const text = node.value.trim();
        if (text && hasLetters(text)) context.report({ node, messageId: 'literal', data: { text } });
      },
      JSXAttribute(node) {
        const name = node.name.type === 'JSXIdentifier' ? node.name.name : '';
        if (!TEXT_ATTRS.has(name) || !node.value || node.value.type !== 'Literal') return;
        if (typeof node.value.value === 'string' && hasLetters(node.value.value)) {
          context.report({ node: node.value, messageId: 'literal', data: { text: node.value.value } });
        }
      },
    };
  },
};

export default {
  meta: { name: 'eslint-plugin-opendc', version: '0.1.0' },
  rules: {
    'no-shell-exec': noShellExec,
    'no-raw-ldap': noRawLdap,
    'no-distro-check': noDistroCheck,
    'no-literal-jsx-text': noLiteralJsxText,
  },
};
