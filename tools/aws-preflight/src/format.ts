/**
 * Prettier formatting with explicit options only. Prettier's configuration resolution is
 * never used: no `.prettierrc*`, `prettier.config.*`, `package.json` key, `.editorconfig` or plugin
 * near an output path is read, so nothing placed next to an operator-supplied `--evidence-out` can
 * run inside the tool. The options equal the repository's `.prettierrc.json` (a test compares
 * them), so generated files stay stable under `pnpm format:check`.
 */
export const PRETTIER_OPTIONS = Object.freeze({
  printWidth: 100,
  singleQuote: true,
  trailingComma: 'all',
  semi: true,
  proseWrap: 'preserve',
} as const);

export async function formatText(text: string, parser: 'json' | 'markdown'): Promise<string> {
  const prettier = await import('prettier');
  return prettier.format(text, { ...PRETTIER_OPTIONS, parser, plugins: [] });
}
