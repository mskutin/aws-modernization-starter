import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Gitleaks allowlists must be narrow. Any [[allowlists]] block needs a description;
 * value patterns (`regexes`) are allowed only with `targetRules` and `regexTarget = "match"`; the
 * line target (one value exempting every secret on the line) is never allowed.
 */
const config = readFileSync(join(import.meta.dirname, '../../../.gitleaks.toml'), 'utf8');

function blocks(text: string, header: string): string[] {
  const parts = text.split(/^(?=\[\[?[\w.]+\]\]?)/m);
  return parts.filter((p) => p.startsWith(header));
}

describe('.gitleaks.toml', () => {
  it('extends the default rules and keeps the runner-token rule', () => {
    expect(config).toMatch(/^\[extend\]\s*\nuseDefault = true/m);
    expect(config).toMatch(/id = "starter-gitlab-runner-token"/);
  });

  it('never allowlists by line', () => {
    expect(config).not.toMatch(/regexTarget\s*=\s*"line"/);
  });

  it('every allowlist is described, and value allowlists are rule- and match-scoped', () => {
    for (const block of [
      ...blocks(config, '[[allowlists]]'),
      ...blocks(config, '[[rules.allowlists]]'),
    ]) {
      expect(block, block).toMatch(/description\s*=/);
      if (/^\s*regexes\s*=/m.test(block)) {
        expect(block, block).toMatch(/regexTarget\s*=\s*"match"/);
        if (block.startsWith('[[allowlists]]')) expect(block, block).toMatch(/targetRules\s*=/);
      }
    }
  });

  it('detects a broad allowlist (control)', () => {
    const broad = `${config}\n[[allowlists]]\ndescription = "too broad"\nregexes = ['''secret''']\n`;
    const offending = blocks(broad, '[[allowlists]]').filter(
      (b) => /^\s*regexes\s*=/m.test(b) && !/targetRules\s*=/.test(b),
    );
    expect(offending).toHaveLength(1);
  });
});
