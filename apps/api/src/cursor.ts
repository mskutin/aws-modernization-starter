/** Opaque keyset-pagination cursor: base64url JSON of the last (createdAt, id). */
import { z } from 'zod';
import { validationProblem } from './problem.js';

const CursorSchema = z.strictObject({ t: z.iso.datetime(), id: z.uuid() });
export type Cursor = { createdAt: Date; id: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.toISOString(), id: cursor.id })).toString(
    'base64url',
  );
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { createdAt: new Date(parsed.t), id: parsed.id };
  } catch {
    throw validationProblem([{ path: 'query.cursor', message: 'invalid cursor' }]);
  }
}
