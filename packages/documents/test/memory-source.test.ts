import { TransientDependencyError } from '@starter/domain';
import { WorkflowError } from '@starter/workflow-processing';
import { describe, expect, it } from 'vitest';
import { DocumentSourceError, InMemoryDocumentSource } from '../src/index.js';
import { describeDocumentSourceContract } from './source-contract.js';

describeDocumentSourceContract('in-memory', async () => {
  const source = new InMemoryDocumentSource();
  return {
    source,
    seed: async (jobId, doc) => {
      source.put(jobId, {
        title: doc.title,
        content: doc.content,
        options: { topTerms: doc.topTerms },
      });
    },
    purge: async (jobId) => source.purge(jobId),
    tamper: async (jobId, content) => source.tamper(jobId, content),
  };
});

describe('InMemoryDocumentSource test hooks', () => {
  it('classifies injected driver failures like the PostgreSQL source', async () => {
    const source = new InMemoryDocumentSource();
    source.put('j', { title: 't', content: 'c' });
    source.failNext(
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' }),
    );
    source.failNext(
      Object.assign(new Error('permission denied for table jobs'), { code: '42501' }),
    );
    const transient = await source.load('j').catch((e: unknown) => e);
    expect(transient).toBeInstanceOf(TransientDependencyError);
    expect((transient as Error).name).toBe(WorkflowError.Transient);
    expect((transient as Error).message).not.toContain('10.0.0.5');
    const permanent = await source.load('j').catch((e: unknown) => e);
    expect(permanent).toBeInstanceOf(DocumentSourceError);
    expect((permanent as Error).message).toBe('document source failed for job j (42501)');
    await expect(source.load('j')).resolves.toMatchObject({ title: 't' });
    expect(source.loads).toBe(3);
  });

  it('returns copies so callers cannot alter the stored document', async () => {
    const source = new InMemoryDocumentSource();
    source.put('j', { title: 't', content: 'c' });
    const doc = await source.load('j');
    doc.content = 'changed';
    await expect(source.load('j')).resolves.toMatchObject({ content: 'c' });
  });
});
