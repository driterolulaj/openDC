// SPDX-License-Identifier: AGPL-3.0-only
import type { TemplateFunction } from '@opendc/shared/manifest';

/** Demo managed file (Phase 1 acceptance 5): proves rendering, the header, the agent write and drift checks. */
const render: TemplateFunction = (view, ctx) => {
  if (!view.get<boolean>('core.demo.enabled')) return '';
  return [`message = ${view.get<string>('core.demo.message')}`, `node = ${ctx.node.fqdn}`, `role = ${ctx.node.role}`, ''].join(
    '\n',
  );
};

export default render;
