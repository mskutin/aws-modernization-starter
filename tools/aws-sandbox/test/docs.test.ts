import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../src/aws/allowlist.js';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

describe('README', () => {
  it('lists every allowlisted operation with its IAM action, and nothing else', () => {
    for (const o of OPERATIONS) {
      expect(readme, `${o.service} ${o.operation}`).toContain(`| \`${o.service} ${o.operation}\``);
      expect(readme, o.iamAction).toContain(`\`${o.iamAction}\``);
    }
    const listed = [
      ...readme.matchAll(/^\| `([a-z0-9-]+ (?:list|describe|get)-[a-z0-9-]+)`/gm),
    ].map((m) => m[1]);
    expect(listed.sort()).toEqual(OPERATIONS.map((o) => `${o.service} ${o.operation}`).sort());
    expect(readme).toContain(`${OPERATIONS.length} \`list-*\``);
  });
});
