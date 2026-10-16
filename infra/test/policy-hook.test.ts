import { Stack, Stage, Validations, type App, type CfnResource } from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import { AwsSolutionsChecks, NagPack } from 'cdk-nag';
import { Construct } from 'constructs';
import {
  SuppressionAuditPlugin,
  UngovernedSuppressionError,
  checkSuppressions,
  todayUtc,
  type DatedSuppressionEntry,
  type SuppressionEntry,
} from '@starter/policies';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acknowledgeAnnotation,
  acknowledgeCfnValidate,
  acknowledgeRule,
  applyPolicyChecks,
  recordedAcknowledgments,
  useSuppressionRegister,
} from '../lib/policy-hook.js';
import { loadEnvironmentConfig } from '../environments/index.js';
import { WorkloadStage } from '../stages/workload-stage.js';
import {
  FIXTURE_ENTRIES,
  TEST_DIGEST,
  TEST_ORIGIN_VERIFY_SECRET,
  newApp,
  TEST_ENV,
} from './helpers.js';
import { sandboxAdoptedRegisters } from './policy-registers.js';

class CountingPack extends NagPack {
  public readonly name = 'Counting';
  public visited = 0;
  constructor() {
    super();
    this.packName = 'Counting';
  }
  protected checkResource(_node: CfnResource): void {
    this.visited++;
  }
}

/** A project construct with two topics that both violate AwsSolutions-SNS3 (no TLS enforcement). */
class Topics extends Construct {
  public readonly a: sns.Topic;
  public readonly b: sns.Topic;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.a = new sns.Topic(this, 'A');
    this.b = new sns.Topic(this, 'B');
  }
}

const NOTE = 'Test topics: publishers are internal AWS services only.';

const daysFromToday = (days: number): string => {
  const d = new Date(`${todayUtc()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const entry = (overrides: Partial<DatedSuppressionEntry> = {}): DatedSuppressionEntry => ({
  id: 'SUP-9001',
  ruleId: 'AwsSolutions-SNS3',
  construct: 'Topics',
  resources: ['A/Resource'],
  environments: ['dev', 'staging', 'prod'],
  justification: 'Test fixture: topic A only receives messages from AWS services in-account.',
  owner: 'security-team',
  createdAt: daysFromToday(-10),
  reviewedAt: daysFromToday(-10),
  reviewBy: daysFromToday(30),
  ...overrides,
});

/** The same entry without dates, as `status: reference` or `status: example`. */
const undated = (status: 'reference' | 'example'): SuppressionEntry => {
  const {
    createdAt: _c,
    reviewedAt: _r,
    reviewBy: _b,
    approver: _a,
    ...rest
  } = entry({
    resources: ['A/Resource', 'B/Resource'],
  });
  return { ...rest, status };
};

const useRegister = (...entries: SuppressionEntry[]) =>
  useSuppressionRegister(checkSuppressions({ schemaVersion: 1, suppressions: entries }));

/** App → Stage `stageName` → Stack `S` → Topics `T`. */
function topicsIn(stageName = 'Env'): { app: App; topics: Topics } {
  const app = newApp();
  const stack = new Stack(new Stage(app, stageName), 'S', { env: TEST_ENV });
  return { app, topics: new Topics(stack, 'T') };
}

const synthError = (app: App): string => {
  try {
    app.synth();
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
};

afterEach(() => useSuppressionRegister(undefined));

describe('policy hook', () => {
  it('registers AwsSolutions, additional packs (instances or factories) and the suppression audit', () => {
    const app = newApp();
    const extra = new CountingPack();
    const packs = applyPolicyChecks(app, { additionalPacks: [extra, () => new CountingPack()] });
    expect(packs).toHaveLength(4);
    expect(packs[0]).toBeInstanceOf(AwsSolutionsChecks);
    expect(packs[1]).toBe(extra);
    expect(packs[3]).toBeInstanceOf(SuppressionAuditPlugin);
  });

  it('additional packs run during synth over nested stages', () => {
    const app = newApp();
    const extra = new CountingPack();
    const stage = new Stage(app, 'Env');
    new sns.Topic(new Stack(stage, 'S', { env: TEST_ENV }), 'T', { enforceSSL: true });
    applyPolicyChecks(app, { awsSolutions: false, additionalPacks: [extra] });
    app.synth();
    expect(extra.visited).toBeGreaterThan(0);
  });

  it('an unacknowledged finding in a nested stage fails synth', () => {
    const app = newApp();
    const stage = new Stage(app, 'Env');
    new sns.Topic(new Stack(stage, 'S', { env: TEST_ENV }), 'T'); // AwsSolutions-SNS3
    applyPolicyChecks(app);
    expect(() => app.synth()).toThrow(/AwsSolutions-SNS3/);
  });

  it('rejects vague or bulk acknowledgments', () => {
    const topic = new sns.Topic(new Stack(newApp(), 'S'), 'T');
    expect(() => acknowledgeRule(topic, 'AwsSolutions-SNS3', 'ok')).toThrow(/meaningful reason/);
    expect(() =>
      acknowledgeRule(topic, 'AwsSolutions-*', 'a sufficiently long reason here'),
    ).toThrow(/single rule id/);
    expect(() =>
      acknowledgeAnnotation(topic, 'anything', 'a sufficiently long reason here'),
    ).toThrow();
    expect(() => acknowledgeCfnValidate(topic, 'W*', 'a sufficiently long reason here')).toThrow();
  });
});

describe('governed acknowledgments (suppression register)', () => {
  it('a registered acknowledgment clears the finding on exactly the registered resources', () => {
    useRegister(entry({ resources: ['A/Resource', 'B/Resource'] }));
    const { app, topics } = topicsIn();
    acknowledgeRule(topics, 'AwsSolutions-SNS3', NOTE);
    applyPolicyChecks(app);
    expect(() => app.synth()).not.toThrow();
    const recorded = recordedAcknowledgments().filter((r) => r.requestedPath === 'Env/S/T');
    expect(recorded.map((r) => r.path).sort()).toEqual([
      'Env/S/T/A/Resource',
      'Env/S/T/B/Resource',
    ]);
    expect(recorded.every((r) => r.suppressionId === 'SUP-9001')).toBe(true);
    expect(recorded[0]?.reason).toMatch(/^\[SUP-9001\] Test fixture/);
  });

  it('narrowing: an acknowledgment on a parent covers only the resources the entry names', () => {
    useRegister(entry()); // A/Resource only
    const { app, topics } = topicsIn();
    acknowledgeRule(topics, 'AwsSolutions-SNS3', NOTE);
    applyPolicyChecks(app);
    const message = synthError(app);
    expect(message).toMatch(/AwsSolutions-SNS3/);
    expect(message).toContain('Env/S/T/B/Resource');
    expect(message).not.toContain('Env/S/T/A/Resource');
  });

  it('an acknowledgment without a register entry throws with a ready-to-fill entry', () => {
    useRegister();
    const { topics } = topicsIn();
    let error: unknown;
    try {
      acknowledgeRule(topics.a, 'AwsSolutions-SNS3', NOTE);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(UngovernedSuppressionError);
    const message = (error as Error).message;
    expect(message).toContain('Ungoverned acknowledgement: AwsSolutions-SNS3 on Env/S/T/A');
    expect(message).toContain('construct: Topics');
    expect(message).toContain('- A/Resource');
  });

  it('an entry for another construct class, rule or resource does not govern it', () => {
    useRegister(
      entry({ id: 'SUP-9002', construct: 'OtherConstruct' }),
      entry({ id: 'SUP-9003', ruleId: 'AwsSolutions-SNS2' }),
      entry({ id: 'SUP-9004', resources: ['C/Resource'] }),
    );
    const { topics } = topicsIn();
    expect(() => acknowledgeRule(topics.a, 'AwsSolutions-SNS3', NOTE)).toThrow(
      UngovernedSuppressionError,
    );
  });

  it('an entry whose review date has passed no longer applies', () => {
    useRegister(entry({ reviewedAt: daysFromToday(-40), reviewBy: daysFromToday(-1) }));
    const { topics } = topicsIn();
    expect(() => acknowledgeRule(topics, 'AwsSolutions-SNS3', NOTE)).toThrow(
      /SUP-9001 is not active[\s\S]*review overdue/,
    );
  });

  it('an entry limited to dev does not apply in the Prod stage', () => {
    useRegister(entry({ environments: ['dev'] }));
    expect(() => acknowledgeRule(topicsIn('Dev').topics, 'AwsSolutions-SNS3', NOTE)).not.toThrow();
    expect(() => acknowledgeRule(topicsIn('Prod').topics, 'AwsSolutions-SNS3', NOTE)).toThrow(
      /limited to dev, not prod/,
    );
  });

  it('two entries covering the same acknowledgment are rejected as ambiguous', () => {
    useRegister(entry(), entry({ id: 'SUP-9002', resources: ['A/Res*'] }));
    expect(() => acknowledgeRule(topicsIn().topics, 'AwsSolutions-SNS3', NOTE)).toThrow(
      /several register entries \(SUP-9001, SUP-9002\)/,
    );
  });

  it('BASE-* findings cannot be acknowledged in code (governed exceptions only)', () => {
    useRegister(entry());
    expect(() => acknowledgeRule(topicsIn().topics, 'BASE-LMB-004', NOTE)).toThrow(
      /exceptions\.yaml/,
    );
  });
});

describe('synth-time suppression audit', () => {
  const bypass = (target: Construct) =>
    Validations.of(target).acknowledge({
      id: 'AwsSolutions-SNS3',
      reason: 'Bypassing the register with a plausible sounding reason.',
    });

  it('fails synth on a direct Validations.acknowledge() that bypasses the register', () => {
    useRegister();
    const { app, topics } = topicsIn();
    bypass(topics.a);
    bypass(topics.b);
    applyPolicyChecks(app);
    const message = synthError(app);
    expect(message).toContain('BASE-SUP-001');
    expect(message).toContain('cites no register entry');
  });

  it('fails synth on a broad acknowledgment that cites a valid entry from an ancestor', () => {
    useRegister(entry({ resources: ['A/Resource', 'B/Resource'] }));
    const { app, topics } = topicsIn();
    // Forged: right citation, but on the parent construct (it would cover its whole subtree).
    Validations.of(topics).acknowledge({
      id: 'AwsSolutions-SNS3',
      reason: '[SUP-9001] Test fixture: topic A only receives messages from AWS services.',
    });
    applyPolicyChecks(app);
    expect(synthError(app)).toMatch(/SCOPE_MISMATCH[\s\S]*does not cover this resource/);
  });

  it('the audit itself cannot be acknowledged away (fatal violations)', () => {
    useRegister();
    const { app, topics } = topicsIn();
    bypass(topics.a);
    bypass(topics.b);
    for (const id of ['BaselineSuppressionAudit::BASE-SUP-001', 'BASE-SUP-001']) {
      Validations.of(app).acknowledge({ id, reason: 'Trying to silence the governance audit.' });
    }
    applyPolicyChecks(app);
    expect(synthError(app)).toContain('BASE-SUP-001');
  });

  it('reports register errors (e.g. an overdue review) even when the entry is unused', () => {
    useRegister(entry({ reviewedAt: daysFromToday(-40), reviewBy: daysFromToday(-1) }));
    const app = newApp();
    new sns.Topic(new Stack(new Stage(app, 'Env'), 'S', { env: TEST_ENV }), 'T', {
      enforceSSL: true,
    });
    applyPolicyChecks(app);
    expect(synthError(app)).toMatch(/BASE-SUP-001[\s\S]*SUP-9001: review overdue/);
  });
});

describe('reference-design and example entries', () => {
  it('a new reference entry is not pinned and never applies (only the shipped ones do)', () => {
    useRegister(undated('reference'));
    expect(() => acknowledgeRule(topicsIn('Dev').topics, 'AwsSolutions-SNS3', NOTE)).toThrow(
      /SUP-9001 is not active[\s\S]*is not a pinned reference entry/,
    );
  });

  it('an example entry never applies: the acknowledgement throws', () => {
    useRegister(undated('example'));
    expect(() => acknowledgeRule(topicsIn('Dev').topics, 'AwsSolutions-SNS3', NOTE)).toThrow(
      /SUP-9001 is not active[\s\S]*is not adopted and never applies/,
    );
  });
});

describe('the opt-in Sandbox stage and the shipped registers', () => {
  const buildSandbox = () =>
    new WorkloadStage(newApp(), 'Sandbox', {
      config: loadEnvironmentConfig('sandbox'),
      imageDigest: TEST_DIGEST,
      handlerEntries: FIXTURE_ENTRIES,
      originVerifySecret: TEST_ORIGIN_VERIFY_SECRET,
    });

  it('does not build from the shipped registers: its entries are an example register', () => {
    useSuppressionRegister(undefined);
    expect(buildSandbox).toThrow(UngovernedSuppressionError);
    expect(buildSandbox).toThrow(/EXAMPLE register \(policies\/exceptions\/examples\/sandbox\/\)/);
  });

  it('builds once the sandbox example register is adopted (here in memory, test-only)', () => {
    useSuppressionRegister(sandboxAdoptedRegisters().register);
    expect(buildSandbox).not.toThrow();
  });
});
