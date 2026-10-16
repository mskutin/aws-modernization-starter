/** Console output is masked and leak-scanned like the evidence. */
import { describe, expect, it } from 'vitest';
import { createConsoleFilter } from '../src/cli.ts';
import { createSanitizer } from '../src/sanitize.ts';
import { EXIT } from '../src/types.ts';
import {
  fakeRunner,
  happyResponses,
  liveArgs,
  runCli,
  sandbox,
  SANDBOX,
  SESSION,
  ssoConfig,
} from './support.ts';

const ACCESS_KEY_ID = ['AS', 'IA', 'Q'.repeat(16)].join('');

describe('console filter', () => {
  it('before the gate: 12-digit runs, separated account IDs and e-mails are masked', () => {
    const c = createConsoleFilter();
    expect(c.filter(`profile admin-${SANDBOX}, 1111-2222-3333, ${SESSION}`)).toBe(
      'profile admin-<12-digit-number>, <12-digit-number>, <email>',
    );
  });

  it('a line that still hits a leak rule is replaced, never printed', () => {
    const c = createConsoleFilter();
    expect(c.filter(`key ${ACCESS_KEY_ID}`)).toBe(
      '[line suppressed by the leak scanner: aws-access-key-id]',
    );
  });

  it('after the gate: the run sanitizer applies (session name, other accounts, domains)', () => {
    const c = createConsoleFilter();
    c.useSanitizer(
      createSanitizer({ sandboxAccount: SANDBOX, sessionName: 'aexample01' }),
      SANDBOX,
    );
    expect(c.filter('user aexample01 in 444455556666 at portal.example.com')).toBe(
      'user <session> in <other-account-1> at <domain-1>.com',
    );
    // Call ids and local paths are not domain-masked.
    expect(c.filter('  ok             a.org.parents@us-east-1', { localPath: true })).toBe(
      '  ok             a.org.parents@us-east-1',
    );
  });

  it('tool digests survive (a SHA-256 with 12 decimal digits is not an account ID)', () => {
    const c = createConsoleFilter();
    const digest = `ab${'123456789012'}${'c'.repeat(50)}`;
    expect(c.filter(`AWS CLI 2.35.11 (sha256 ${digest})`)).toBe(
      `AWS CLI 2.35.11 (sha256 ${digest})`,
    );
  });
});

describe('console output of a run', () => {
  it('a profile name with digits is printed as <profile>; no raw identifier reaches the console', async () => {
    const profile = `starter-sandbox-${SANDBOX}`;
    const box = sandbox({ config: ssoConfig({ profile }) });
    const argv = liveArgs('discover', box).map((t) =>
      t === 'starter-sandbox-developer' ? profile : t,
    );
    const fake = fakeRunner(happyResponses());
    const r = await runCli(argv, fake.runner);
    expect(r.code).toBe(EXIT.OK);
    const console = [...r.out, ...r.err].join('\n');
    expect(console).toContain('profile <profile> (IAM Identity Center');
    expect(console).not.toContain(SANDBOX);
    expect(console).not.toContain(SESSION);
    expect(console).not.toContain(box.home);
    expect(console).toContain('aws sso logout');
    // ...but the AWS CLI still received the real profile name.
    expect(fake.awsCalls()[0]?.args).toContain(profile);
  });
});
