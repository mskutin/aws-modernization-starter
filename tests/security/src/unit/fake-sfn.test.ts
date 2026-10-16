import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { describe, expect, it } from 'vitest';
import { startFakeStepFunctions, type StartedFakeStepFunctions } from '../harness/fake-sfn.js';
import { call, pollUntil } from '../http.js';

const clientFor = (fake: StartedFakeStepFunctions) =>
  new SFNClient({
    region: 'ap-southeast-1',
    endpoint: fake.url,
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
    maxAttempts: 1,
  });

const start = (client: SFNClient, name: string) =>
  client.send(
    new StartExecutionCommand({
      stateMachineArn: 'arn:aws:states:ap-southeast-1:000000000000:stateMachine:x',
      name,
      input: JSON.stringify({ jobId: name }),
    }),
  );

describe('fake Step Functions endpoint', () => {
  it('captures StartExecution input sent by the real SDK client (AWS_ENDPOINT_URL_SFN style)', async () => {
    const fake = await startFakeStepFunctions();
    const client = clientFor(fake);
    try {
      const out = await start(client, 'job-1');
      expect(out.executionArn).toBe('arn:aws:states:ap-southeast-1:000000000000:execution:x:job-1');
      const captures = (await call(fake.controlUrl, 'GET', '/__captures')).json as {
        input: string;
      }[];
      expect(captures.map((c) => c.input)).toEqual(['{"jobId":"job-1"}']);
    } finally {
      client.destroy();
      await fake.close();
    }
  });

  it('holds StartExecution while armed and answers every held call on release', async () => {
    const fake = await startFakeStepFunctions();
    const client = clientFor(fake);
    try {
      expect((await call(fake.controlUrl, 'POST', '/__hold')).json).toEqual({ holding: true });
      let settled = false;
      const pending = start(client, 'job-held').finally(() => (settled = true));
      const held = await pollUntil('the held call', async () => {
        const calls = (await call(fake.controlUrl, 'GET', '/__held')).json as { name: string }[];
        return calls.length > 0 ? calls : undefined;
      });
      expect(held.map((c) => c.name)).toEqual(['job-held']);
      expect(settled).toBe(false);
      expect((await call(fake.controlUrl, 'POST', '/__release')).json).toEqual({ released: 1 });
      expect((await pending).executionArn).toMatch(/:execution:x:job-held$/);
      // Released: no longer holding, the next call is answered at once.
      expect((await start(client, 'job-free')).executionArn).toMatch(/:job-free$/);
      expect((await call(fake.controlUrl, 'GET', '/__held')).json).toEqual([]);
    } finally {
      client.destroy();
      await fake.close();
    }
  });
});
