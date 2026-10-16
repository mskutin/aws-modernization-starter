#!/usr/bin/env node
// Verdict of the egress audit of one emulator run (NOT AWS — see _emulator.sh):
//
//   node egress-report.mjs --log <run>/egress.jsonl --out <run>/egress.json [--require cdk,…]
//
// Reads the records egress-audit.mjs (and no-container-engine.sh) wrote and writes a summary:
// allowed targets with their connection counts, every violation (blocked connection, DNS query, UDP
// send, detached child process, unaudited worker thread, container-engine call), the Node
// processes the audit was loaded into, and the non-Node children it records but cannot intercept. --require names processes (e.g. `cdk`) that must have loaded
// the audit: an empty or partial log proves nothing, so a missing one is a violation (`not-audited`).
// Exit 0 when there is no violation; 1 on any violation; 2 on a usage error or an unreadable log.
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function summarize(text, required = []) {
  const allowed = {};
  const violations = [];
  const processes = new Set();
  const spawned = new Set();
  const uncovered = new Set();
  let reinjected = 0;
  let records = 0;
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (r === null || typeof r !== 'object') {
      malformed += 1;
      continue;
    }
    records += 1;
    if (r.kind === 'load') {
      if (typeof r.proc === 'string') processes.add(r.proc);
      continue;
    }
    if (r.kind === 'spawn') {
      const name = [
        r.file,
        ...(typeof r.command === 'string' ? ['-c', r.command] : []),
        ...(Array.isArray(r.script) ? r.script : []),
      ].join(' ');
      spawned.add(name);
      // Not a Node process: recorded, not intercepted (documented limit of the audit).
      if (r.node === false) uncovered.add(name);
      if (r.reinjected === true) reinjected += 1;
      if (r.allowed !== true) {
        violations.push({ kind: 'detached-spawn', target: name, proc: r.proc, at: r.at });
      }
      continue;
    }
    if (r.allowed === true) {
      allowed[r.target] = (allowed[r.target] ?? 0) + 1;
    } else {
      violations.push({ kind: r.kind, target: r.target, proc: r.proc, at: r.at });
    }
  }
  // An unparseable line could hide a violation: count it as one.
  if (malformed > 0) violations.push({ kind: 'malformed-record', target: `${malformed} line(s)` });
  for (const proc of required) {
    if (!processes.has(proc)) violations.push({ kind: 'not-audited', target: proc });
  }
  return {
    target: 'ministack-emulator',
    ok: violations.length === 0,
    records,
    allowed,
    violations,
    processes: [...processes].sort(),
    spawned: [...spawned].sort(),
    // Child processes the audit does not intercept (non-Node executables), and how many children
    // got the audit environment back after their caller had dropped it.
    uncovered: [...uncovered].sort(),
    reinjected,
  };
}

function main(argv) {
  const value = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const log = value('--log');
  const out = value('--out');
  const required = (value('--require') ?? '').split(',').filter(Boolean);
  if (!log || !out) {
    console.error(
      'usage: egress-report.mjs --log <egress.jsonl> --out <egress.json> [--require p,…]',
    );
    return 2;
  }
  let text;
  try {
    text = readFileSync(log, 'utf8');
  } catch (error) {
    console.error(
      `[egress] no audit log (${error instanceof Error ? error.message : error}): NOT proven`,
    );
    return 2;
  }
  const report = summarize(text, required);
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  const counts = Object.entries(report.allowed)
    .map(([t, n]) => `${t} x${n}`)
    .join(', ');
  console.error(`[egress] allowed: ${counts || 'none'}; violations: ${report.violations.length}`);
  for (const v of report.violations) {
    console.error(`[egress] VIOLATION ${v.kind} ${v.target}${v.proc ? ` (${v.proc})` : ''}`);
  }
  return report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
