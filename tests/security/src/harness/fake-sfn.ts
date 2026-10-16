/**
 * Capturing stand-in for the Step Functions API (AWS JSON 1.0 protocol), so the suite sees the
 * exact `StartExecution` input the API's real SDK client sends (the execution input must
 * carry no document data). The API is pointed at it with `AWS_ENDPOINT_URL_SFN`; nothing reaches
 * AWS. Control endpoints for test workers in other processes:
 *   GET  /__captures   every StartExecution received so far
 *   POST /__hold       from now on, StartExecution calls are captured but NOT answered, which
 *                      holds the API's POST /v1/jobs handler after the job row exists
 *   GET  /__held       the calls being held
 *   POST /__release    answers every held call and stops holding
 *
 * TEST ONLY: it answers StartExecution with a synthetic ARN and rejects every other operation.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

export interface StartExecutionCapture {
  stateMachineArn: string;
  name: string;
  /** The `input` string exactly as sent. */
  input: string;
  receivedAt: string;
}

export interface StartedFakeStepFunctions {
  url: string;
  capturesUrl: string;
  /** Base URL of the hold controls (`/__hold`, `/__held`, `/__release`). */
  controlUrl: string;
  captures(): StartExecutionCapture[];
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/x-amz-json-1.0' });
  res.end(JSON.stringify(body));
};

const control = (res: ServerResponse, body: unknown) => {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

interface HeldCall {
  capture: StartExecutionCapture;
  answer(): void;
}

export async function startFakeStepFunctions(): Promise<StartedFakeStepFunctions> {
  const captures: StartExecutionCapture[] = [];
  const held: HeldCall[] = [];
  let holding = false;
  const releaseAll = () => {
    holding = false;
    const calls = held.splice(0);
    for (const call of calls) call.answer();
    return calls.length;
  };
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method === 'GET' && req.url === '/__captures') return control(res, captures);
      if (req.method === 'GET' && req.url === '/__held') {
        return control(
          res,
          held.map((h) => h.capture),
        );
      }
      if (req.method === 'POST' && req.url === '/__hold') {
        holding = true;
        return control(res, { holding });
      }
      if (req.method === 'POST' && req.url === '/__release') {
        return control(res, { released: releaseAll() });
      }
      const target = String(req.headers['x-amz-target'] ?? '');
      const body = await readBody(req);
      if (target !== 'AWSStepFunctions.StartExecution') {
        json(res, 400, { __type: 'UnknownOperationException', message: `fake: ${target}` });
        return;
      }
      const parsed = JSON.parse(body) as {
        stateMachineArn?: string;
        name?: string;
        input?: string;
      };
      const capture: StartExecutionCapture = {
        stateMachineArn: parsed.stateMachineArn ?? '',
        name: parsed.name ?? '',
        input: parsed.input ?? '',
        receivedAt: new Date().toISOString(),
      };
      captures.push(capture);
      const arn = (
        parsed.stateMachineArn ?? 'arn:aws:states:ap-southeast-1:000000000000:stateMachine:x'
      )
        .replace(':stateMachine:', ':execution:')
        .concat(`:${parsed.name ?? 'unnamed'}`);
      const answer = () => json(res, 200, { executionArn: arn, startDate: Date.now() / 1000 });
      if (holding) held.push({ capture, answer });
      else answer();
    })().catch(() => json(res, 500, { __type: 'InternalFailure' }));
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    capturesUrl: `${url}/__captures`,
    controlUrl: url,
    captures: () => [...captures],
    close: () =>
      new Promise<void>((resolve) => {
        releaseAll();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
