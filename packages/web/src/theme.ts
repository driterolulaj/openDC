// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Console theme. Mantine's defaults miss WCAG 2.1 AA contrast in places the console uses a lot: filled
 * badges/buttons (white on shade 6), "light" variants (badges, the active navigation entry) and dimmed text.
 * Filled backgrounds use shade 9; light/outline text gets darker in light mode and lighter in dark mode
 * (ROADMAP Phase 2: no serious axe violations).
 */
import {
  Loader,
  Modal,
  createTheme,
  defaultVariantColorsResolver,
  parseThemeColor,
  type CSSVariablesResolver,
  type VariantColorsResolver,
} from '@mantine/core';

const variantColorResolver: VariantColorsResolver = (input) => {
  const r = defaultVariantColorsResolver(input);
  const parsed = parseThemeColor({ color: input.color ?? input.theme.primaryColor, theme: input.theme });
  if (!parsed.isThemeColor) return r;
  const c = parsed.color;
  // filled: white text needs shade 9 (shade 6 is about 3.5:1 for red and blue)
  if (input.variant === 'filled') {
    if (c === 'yellow' || c === 'lime') return r;
    return { ...r, background: `var(--mantine-color-${c}-9)`, hover: `var(--mantine-color-${c}-8)` };
  }
  if (input.variant !== 'light' && input.variant !== 'outline') return r;
  return {
    ...r,
    color: `light-dark(var(--mantine-color-${c}-9), var(--mantine-color-${c}-2))`,
    // the default light hover (shade 2) leaves shade-9 text at 4:1
    ...(input.variant === 'light' ? { hover: `light-dark(var(--mantine-color-${c}-1), ${r.hover})` } : {}),
    ...(input.variant === 'outline'
      ? { border: `1px solid light-dark(var(--mantine-color-${c}-8), var(--mantine-color-${c}-3))` }
      : {}),
  };
};

export const cssVariablesResolver: CSSVariablesResolver = () => ({
  variables: {},
  light: {
    '--mantine-color-dimmed': 'var(--mantine-color-gray-7)',
    // components without a color prop (NavLink) use the global primary light colors
    '--mantine-primary-color-light-hover': 'var(--mantine-primary-color-1)',
    '--mantine-primary-color-light-color': 'var(--mantine-primary-color-9)',
  },
  dark: { '--mantine-color-dimmed': 'var(--mantine-color-dark-1)' },
});

/** The theme; `closeLabel` names the icon-only close buttons of modals (translated by the caller). */
export function consoleTheme(closeLabel: string): ReturnType<typeof createTheme> {
  return createTheme({
    primaryColor: 'blue',
    // links and default filled buttons: shade 8 keeps 4.5:1 on white and on striped rows
    primaryShade: { light: 8, dark: 8 },
    defaultRadius: 'sm',
    variantColorResolver,
    components: {
      // the loaders carry an aria-label, which needs a role
      Loader: Loader.extend({ defaultProps: { role: 'status' } }),
      Modal: Modal.extend({ defaultProps: { closeButtonProps: { 'aria-label': closeLabel } } }),
    },
  });
}
