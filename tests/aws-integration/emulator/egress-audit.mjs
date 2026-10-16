// Egress audit of the MiniStack EMULATOR runs (NOT AWS — see _emulator.sh). Preloaded into every
// Node process of an emulator run through NODE_OPTIONS=--import=<this file> (ci.sh sets it after the
// guard): `cdk` (and the CDK CLI's detached telemetry sender), the CDK app, pnpm, the emulator CLIs
// and the vitest workers.
//
// Every outbound TCP/TLS connection (net.Socket#connect: http, https, undici fetch, http2, tls), every
// DNS query (dns.lookup/lookupService/resolve*, callback and promise APIs) and every UDP send is
// checked against
// STARTER_EMULATOR_EGRESS_ALLOW (comma-separated host:port, the guard-validated emulator endpoint). An
// allowed connection is recorded; anything else is recorded as a violation and BLOCKED (the socket
// errors with EGRESSBLOCKED before any byte leaves the process; the DNS query is not sent). Unix-socket
// connections are violations too: no emulator step needs a container-engine socket.
// A connection to an allowed HOST NAME with a caller-supplied `lookup` is refused (the lookup could
// point the name anywhere). Worker threads are not reached by NODE_OPTIONS preloads, so creating one
// is a violation too.
// Every child process — async (spawn, exec, execFile, fork) and sync (spawnSync, execSync,
// execFileSync) — is recorded, and its environment gets the audit back (NODE_OPTIONS --import, log,
// allowlist) even if the caller passed a clean `env`: a Node child is audited like its parent. A
// DETACHED child is a violation (it would outlive the audit — the CDK CLI's telemetry sender is one).
// ci.sh's `egress audit` step (egress-report.mjs) fails the run on any violation.
//
// Records are JSON lines appended to STARTER_EMULATOR_EGRESS_LOG. Unset log or allowlist → no-op (the
// hook only acts where ci.sh configured it). Covers Node processes only: non-Node executables
// (esbuild, the pnpm executable, sh, curl, …) are recorded (`node: false`) but not intercepted, a
// non-Node child that clears its own children's environment (`env -i node …`) takes them out of the
// audit, and the MiniStack service container is not part of this process tree.
import childProcess from 'node:child_process';
import dgram from 'node:dgram';
import dns from 'node:dns';
import { appendFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import workerThreads, { isMainThread } from 'node:worker_threads';

const LOG = process.env.STARTER_EMULATOR_EGRESS_LOG;
const ALLOW_RAW = process.env.STARTER_EMULATOR_EGRESS_ALLOW;

if (LOG && ALLOW_RAW && !globalThis.__starterEgressAudit) {
  globalThis.__starterEgressAudit = true;
  const allow = new Set(
    ALLOW_RAW.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
  const allowedHosts = new Set([...allow].map((hp) => hp.slice(0, hp.lastIndexOf(':'))));
  const IMPORT_FLAG = `--import=${fileURLToPath(import.meta.url)}`;
  const evaluated = process.execArgv.some((a) => /^(?:-e|-p|--eval|--print)(?:=|$)/.test(a));
  const proc = evaluated ? 'node -e' : path.basename(process.argv[1] ?? 'node');

  const record = (entry) => {
    try {
      appendFileSync(
        LOG,
        `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, proc, ...entry })}\n`,
      );
    } catch {
      // The audit must not change the behaviour of an allowed call; a lost record of a blocked one
      // still leaves the call blocked.
    }
  };
  // Evidence that this process was audited at all (egress.json lists the processes).
  record({ kind: 'load', thread: isMainThread ? 'main' : 'worker', allowed: true });
  const blockedError = (what) =>
    Object.assign(new Error(`egress blocked by the emulator egress audit: ${what}`), {
      code: 'EGRESSBLOCKED',
    });

  // ── TCP / TLS ──────────────────────────────────────────────────────────────────────────────
  const normalize = (args) => {
    let first = args[0];
    if (Array.isArray(first)) first = first[0]; // internal normalized form [options, cb]
    if (first !== null && typeof first === 'object') {
      if (typeof first.path === 'string') return { unix: first.path };
      return {
        host: String(first.host ?? 'localhost'),
        port: Number(first.port),
        lookup: first.lookup,
      };
    }
    if (typeof first === 'string' && Number.isNaN(Number(first))) return { unix: first };
    return { host: typeof args[1] === 'string' ? args[1] : 'localhost', port: Number(first) };
  };
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function auditedConnect(...args) {
    const t = normalize(args);
    if (t.unix !== undefined) {
      record({ kind: 'connect', target: `unix:${t.unix}`, allowed: false });
      process.nextTick(() => this.destroy(blockedError(`unix:${t.unix}`)));
      return this;
    }
    const host = t.host.toLowerCase().replace(/^\[|\]$/g, '');
    const target = `${host}:${t.port}`;
    // A caller-supplied lookup decides where an allowed NAME really goes: refused (an IP literal
    // never consults it).
    const customLookup = typeof t.lookup === 'function' && net.isIP(host) === 0;
    const allowed = allow.has(target) && !customLookup;
    record({ kind: customLookup ? 'connect-custom-lookup' : 'connect', target, allowed });
    if (!allowed) {
      process.nextTick(() => this.destroy(blockedError(target)));
      return this;
    }
    return originalConnect.apply(this, args);
  };

  // ── DNS ────────────────────────────────────────────────────────────────────────────────────
  const hostAllowed = (name) => allowedHosts.has(String(name).toLowerCase().replace(/\.$/, ''));
  // `lookup` (getaddrinfo) of an IP literal answers locally and sends no query; Node itself does it
  // for `server.listen(port, '127.0.0.1')` (the CI forwarder). Where that address may be reached is
  // still decided at connect time. The resolve* APIs always query a DNS server, so they get no pass.
  const noQuery = (name, hostname) => name === 'lookup' && net.isIP(String(hostname)) !== 0;
  const wrapCallbackApi = (owner, name) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function auditedDns(hostname, ...rest) {
      if (hostAllowed(hostname) || noQuery(name, hostname)) {
        return original.call(this, hostname, ...rest);
      }
      record({ kind: `dns.${name}`, target: String(hostname), allowed: false });
      const cb = rest.findLast((x) => typeof x === 'function');
      if (cb) process.nextTick(() => cb(blockedError(`dns ${String(hostname)}`)));
      return undefined;
    };
  };
  const wrapPromiseApi = (owner, name) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    owner[name] = function auditedDnsPromise(hostname, ...rest) {
      if (hostAllowed(hostname) || noQuery(name, hostname)) {
        return original.call(this, hostname, ...rest);
      }
      record({ kind: `dns.${name}`, target: String(hostname), allowed: false });
      return Promise.reject(blockedError(`dns ${String(hostname)}`));
    };
  };
  const RESOLVERS = [
    'lookup',
    'resolve',
    'resolve4',
    'resolve6',
    'resolveAny',
    'resolveCname',
    'resolveCaa',
    'resolveMx',
    'resolveNaptr',
    'resolveNs',
    'resolvePtr',
    'resolveSoa',
    'resolveSrv',
    'resolveTxt',
  ];
  for (const name of RESOLVERS) {
    wrapCallbackApi(dns, name);
    wrapCallbackApi(dns.Resolver.prototype, name);
    wrapPromiseApi(dns.promises, name);
    wrapPromiseApi(dns.promises.Resolver.prototype, name);
  }
  // Reverse lookups (getnameinfo) are never needed by an emulator step: always refused.
  dns.lookupService = function auditedLookupService(address, port, callback) {
    record({
      kind: 'dns.lookupService',
      target: `${String(address)}:${String(port)}`,
      allowed: false,
    });
    if (typeof callback === 'function') {
      process.nextTick(() => callback(blockedError(`dns lookupService ${String(address)}`)));
    }
  };
  dns.promises.lookupService = function auditedLookupServicePromise(address, port) {
    record({
      kind: 'dns.lookupService',
      target: `${String(address)}:${String(port)}`,
      allowed: false,
    });
    return Promise.reject(blockedError(`dns lookupService ${String(address)}`));
  };

  // ── UDP ────────────────────────────────────────────────────────────────────────────────────
  const originalSend = dgram.Socket.prototype.send;
  // send(msg[, offset, length][, port][, address][, callback]); a connected socket omits port/address.
  dgram.Socket.prototype.send = function auditedSend(...args) {
    const withRange = typeof args[1] === 'number' && typeof args[2] === 'number';
    const at = withRange && typeof args[3] === 'number' ? 3 : 1;
    let port = typeof args[at] === 'number' ? args[at] : undefined;
    let host = typeof args[at + 1] === 'string' ? args[at + 1] : undefined;
    if (port === undefined) {
      try {
        const remote = this.remoteAddress();
        port = remote.port;
        host = remote.address;
      } catch {
        // not connected: the target is unknown, which is a violation below
      }
    }
    const target = `${String(host ?? 'localhost').toLowerCase()}:${String(port)}`;
    const allowed = allow.has(target);
    record({ kind: 'udp', target, allowed });
    if (!allowed) {
      const cb = args.findLast((x) => typeof x === 'function');
      if (cb) process.nextTick(() => cb(blockedError(`udp ${target}`)));
      return undefined;
    }
    return originalSend.apply(this, args);
  };
  const originalUdpConnect = dgram.Socket.prototype.connect;
  dgram.Socket.prototype.connect = function auditedUdpConnect(port, address, ...rest) {
    const host = typeof address === 'string' ? address : 'localhost';
    const target = `${host.toLowerCase()}:${String(port)}`;
    const allowed = allow.has(target);
    record({ kind: 'udp', target, allowed });
    if (!allowed) throw blockedError(`udp ${target}`);
    return originalUdpConnect.call(this, port, address, ...rest);
  };

  // ── Child processes ────────────────────────────────────────────────────────────────────────
  // The audit's own variables, forced into a child environment (a clean `env` would drop them).
  const auditEnv = (env) => {
    const out = { ...(env ?? process.env) };
    const options = String(out.NODE_OPTIONS ?? '');
    const reinjected =
      !options.split(/\s+/).includes(IMPORT_FLAG) ||
      out.STARTER_EMULATOR_EGRESS_LOG !== LOG ||
      out.STARTER_EMULATOR_EGRESS_ALLOW !== ALLOW_RAW;
    if (!options.split(/\s+/).includes(IMPORT_FLAG)) {
      out.NODE_OPTIONS = options.trim() === '' ? IMPORT_FLAG : `${options} ${IMPORT_FLAG}`;
    }
    out.STARTER_EMULATOR_EGRESS_LOG = LOG;
    out.STARTER_EMULATOR_EGRESS_ALLOW = ALLOW_RAW;
    return { env: out, reinjected };
  };
  const isNode = (file) =>
    String(file) === process.execPath ||
    /^node(?:js)?(?:\.exe)?$/.test(path.basename(String(file)));
  const SHELL = /^(?:sh|bash|dash|zsh|cmd\.exe)$/;
  /** What a child is: file, the command a shell runs, script names (never full argument lists). */
  const describeChild = (file, argv) => {
    const base = path.basename(String(file ?? ''));
    const c = argv.indexOf('-c');
    const command =
      SHELL.test(base) && c >= 0 && typeof argv[c + 1] === 'string'
        ? path.basename(argv[c + 1].trim().split(/\s+/)[0] ?? '')
        : undefined;
    return {
      file: base,
      ...(command !== undefined ? { command } : {}),
      script: argv
        .filter((a) => typeof a === 'string' && /\.(?:c|m)?js$/.test(a))
        .map((a) => path.basename(a))
        .slice(0, 2),
      node: isNode(file) || (command !== undefined && /^node(?:js)?$/.test(command)),
    };
  };

  // Async: spawn, exec, execFile, fork all end in ChildProcess#spawn (environment as envPairs).
  const originalSpawn = childProcess.ChildProcess.prototype.spawn;
  childProcess.ChildProcess.prototype.spawn = function auditedSpawn(options) {
    const argv = Array.isArray(options?.args) ? options.args.slice(1) : [];
    let reinjected = false;
    if (options && Array.isArray(options.envPairs)) {
      const current = {};
      for (const pair of options.envPairs) {
        const i = String(pair).indexOf('=');
        if (i > 0) current[pair.slice(0, i)] = pair.slice(i + 1);
      }
      const audited = auditEnv(current);
      reinjected = audited.reinjected;
      options.envPairs = Object.entries(audited.env).map(([k, v]) => `${k}=${String(v)}`);
    }
    record({
      kind: 'spawn',
      ...describeChild(options?.file, argv),
      reinjected,
      // A detached child outlives the run and so the audit (the CDK telemetry sender is one).
      detached: options?.detached === true,
      allowed: options?.detached !== true,
    });
    return originalSpawn.call(this, options);
  };

  // Sync: spawnSync, execFileSync (file, [args], [options]) and execSync (command, [options]) do
  // not pass through ChildProcess#spawn; each export is wrapped.
  const recordSync = (file, argv, reinjected) =>
    record({ kind: 'spawn', ...describeChild(file, argv), sync: true, reinjected, allowed: true });
  for (const name of ['spawnSync', 'execFileSync']) {
    const original = childProcess[name];
    childProcess[name] = function auditedSyncChild(file, ...rest) {
      const argList = Array.isArray(rest[0]) ? rest[0] : [];
      const raw = Array.isArray(rest[0]) ? rest[1] : rest[0];
      const options = raw !== null && typeof raw === 'object' ? raw : {};
      const { env, reinjected } = auditEnv(options.env);
      const shell = options.shell === true ? '/bin/sh' : options.shell;
      if (typeof shell === 'string') {
        recordSync(shell, ['-c', [file, ...argList].join(' ')], reinjected);
      } else {
        recordSync(file, argList, reinjected);
      }
      return original.call(this, file, argList, { ...options, env });
    };
  }
  const originalExecSync = childProcess.execSync;
  childProcess.execSync = function auditedExecSync(command, options) {
    const opts = options !== null && typeof options === 'object' ? options : {};
    const { env, reinjected } = auditEnv(opts.env);
    recordSync(
      typeof opts.shell === 'string' ? opts.shell : '/bin/sh',
      ['-c', String(command)],
      reinjected,
    );
    return originalExecSync.call(this, command, { ...opts, env });
  };

  // ── Worker threads ─────────────────────────────────────────────────────────────────────────
  // NODE_OPTIONS preloads do not run in worker threads (and `--import` is not accepted in a worker's
  // execArgv), so a worker's network calls would go unaudited: a worker is a violation (fail closed).
  const OriginalWorker = workerThreads.Worker;
  workerThreads.Worker = class AuditedWorker extends OriginalWorker {
    constructor(filename, options) {
      record({
        kind: 'worker',
        target: options?.eval ? '<eval>' : path.basename(String(filename)),
        allowed: false,
      });
      super(filename, options);
    }
  };

  // ESM named imports of builtins (`import { lookup } from 'node:dns'`) see the patched functions.
  syncBuiltinESMExports();
}
