import { describe, expect, it } from 'vitest';
import { CDK_CONTEXT } from './helpers.js';

describe('CDK CLI configuration (cdk.json)', () => {
  it('disables CDK CLI telemetry, which is on by default, for every synth, diff and deploy', () => {
    // Without this key every `cdk` invocation (local, CI, the mini-stack scripts) posts usage
    // telemetry to an AWS endpoint. `false` is the value the CLI checks.
    expect(CDK_CONTEXT['cli-telemetry']).toBe(false);
  });
});
