import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendForwardedFor, startProxy, type StartedProxy } from '../harness/proxy.js';

describe('X-Forwarded-For appending proxy', () => {
  it('appends the peer to the right of whatever the client sent', () => {
    expect(appendForwardedFor(undefined, '10.0.0.1')).toBe('10.0.0.1');
    expect(appendForwardedFor('203.0.113.9', '10.0.0.1')).toBe('203.0.113.9, 10.0.0.1');
    expect(appendForwardedFor(['1.1.1.1', '2.2.2.2'], '10.0.0.1')).toBe(
      '1.1.1.1, 2.2.2.2, 10.0.0.1',
    );
  });

  let upstream: ReturnType<typeof createServer>;
  let upstreamUrl = '';
  let seen: { headers: IncomingHttpHeaders; body: string }[] = [];
  const proxies: StartedProxy[] = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', (d: Buffer) => (body += d.toString()));
      req.on('end', () => {
        seen.push({ headers: req.headers, body });
        res.writeHead(418, { 'content-type': 'text/plain', 'x-upstream': 'yes' });
        res.end('teapot');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', () => resolve()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await Promise.all(proxies.map((p) => p.close()));
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  it('a two-hop chain forwards method, body, Authorization and status, appending two entries', async () => {
    seen = [];
    const alb = await startProxy('alb', upstreamUrl);
    const cf = await startProxy('cf', alb.url);
    proxies.push(alb, cf);
    const res = await fetch(`${cf.url}/v1/jobs?x=1`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer abc',
        'x-forwarded-for': '203.0.113.7',
        'content-type': 'application/json',
      },
      body: '{"a":1}',
    });
    expect(res.status).toBe(418);
    expect(res.headers.get('x-upstream')).toBe('yes');
    expect(await res.text()).toBe('teapot');
    const [request] = seen;
    expect(request?.body).toBe('{"a":1}');
    expect(request?.headers.authorization).toBe('Bearer abc');
    expect(request?.headers['x-forwarded-for']).toBe('203.0.113.7, 127.0.0.1, 127.0.0.1');
    expect(cf.forwarded).toBe(1);
  });
});
