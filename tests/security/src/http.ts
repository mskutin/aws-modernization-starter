/**
 * Minimal HTTP client for black-box tests: every response is captured completely (status,
 * headers, raw text) so assertions can inspect exactly what a client sees.
 */
import { request as httpRequest } from 'node:http';
import type { Target } from './context.js';

export interface Res {
  status: number;
  headers: Headers;
  text: string;
  json: unknown;
}

export interface CallOptions {
  /** Bearer token (sets `Authorization: Bearer <token>`). */
  token?: string;
  /** Raw `Authorization` header value (malformed-header tests); wins over `token`. */
  authorization?: string;
  json?: unknown;
  body?: string | Uint8Array;
  headers?: Record<string, string>;
}

const parseJson = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
};

export async function call(
  target: Target | string,
  method: string,
  path: string,
  opts: CallOptions = {},
): Promise<Res> {
  const base = typeof target === 'string' ? target : target.baseUrl;
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers };
  if (opts.authorization !== undefined) headers['authorization'] = opts.authorization;
  else if (opts.token !== undefined) headers['authorization'] = `Bearer ${opts.token}`;
  let body: string | Uint8Array | undefined = opts.body;
  if (opts.json !== undefined) {
    body = JSON.stringify(opts.json);
    headers['content-type'] ??= 'application/json';
  }
  const init: RequestInit = {
    method,
    headers,
    body,
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  };
  const url = `${base}${path}`;
  const res = await fetch(url, init); // nosemgrep: nodejs_scan.javascript-ssrf-rule-node_ssrf -- test tool: the base URL is suite configuration (API_BASE_URL/WEB_BASE_URL or the harness's own processes) and paths are test literals
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, json: parseJson(text) };
}

/**
 * POST that DECLARES `declaredBytes` via Content-Length but sends only a short prefix, then waits
 * for the server's answer. Proves the API answers before reading the body (authentication runs
 * in `onRequest`) without racing an early close against a large upload.
 */
export function postDeclaringLength(
  baseUrl: string,
  path: string,
  declaredBytes: number,
  headers: Record<string, string> = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, `${baseUrl}/`), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(declaredBytes),
        ...headers,
      },
    });
    const timer = setTimeout(
      () =>
        req.destroy(new Error(`no response within 15 s for a declared ${declaredBytes}-byte body`)),
      15_000,
    );
    req.on('response', (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => {
        clearTimeout(timer);
        req.destroy();
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          for (const item of Array.isArray(v) ? v : [v]) h.append(k, item);
        }
        resolve({ status: res.statusCode ?? 0, headers: h, text, json: parseJson(text) });
      });
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.write('{"title":"declared-but-not-sent","content":"');
  });
}

/** Polls `fn` until it returns a value or the deadline passes (no fixed sleeps). */
export async function pollUntil<T>(
  what: string,
  fn: () => Promise<T | undefined>,
  deadlineMs = 30_000,
  intervalMs = 200,
): Promise<T> {
  const until = Date.now() + deadlineMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await fn();
      if (value !== undefined) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() >= until) {
      throw new Error(`timed out after ${deadlineMs} ms waiting for ${what}`, { cause: last });
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export const describeRes = (r: Res): string =>
  `HTTP ${r.status} [${r.headers.get('content-type') ?? ''}] ${r.text.slice(0, 400)}`;
