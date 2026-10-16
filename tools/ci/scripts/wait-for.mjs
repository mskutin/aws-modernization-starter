#!/usr/bin/env node
// usage: node wait-for.mjs [--timeout <s>] tcp:<host>:<port> | http:<url> ...
// Polls until every target answers (TCP connect / HTTP 2xx). No dependencies.
import { connect } from 'node:net';

const args = process.argv.slice(2);
let timeout = 90;
const targets = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--timeout') timeout = Number(args[++i]);
  else targets.push(args[i]);
}
const deadline = Date.now() + timeout * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tcp(host, port) {
  return new Promise((resolve) => {
    const s = connect({ host, port: Number(port), timeout: 2000 });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
    s.once('timeout', () => (s.destroy(), resolve(false)));
  });
}
async function http(url) {
  try {
    // A redirect is not readiness and must not take the probe to another host.
    const r = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    await r.arrayBuffer();
    return r.ok;
  } catch {
    return false;
  }
}

for (const target of targets) {
  const [kind, ...rest] = target.split(':');
  const value = rest.join(':');
  for (;;) {
    const ok = kind === 'tcp' ? await tcp(...value.split(':')) : await http(value);
    if (ok) {
      console.log(`ready: ${target}`);
      break;
    }
    if (Date.now() > deadline) {
      console.error(`timeout after ${timeout}s waiting for ${target}`);
      process.exit(1);
    }
    await sleep(1000);
  }
}
