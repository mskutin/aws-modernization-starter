#!/usr/bin/env python3
"""Evaluate a GitLab SAST report (gl-sast-report.json).

- fails when the analyzer itself failed or produced no report
- fails on findings whose severity is in SAST_FAIL_ON (default: Critical,High)
- writes a GitLab Code Quality report so findings show in the MR widget on CE

Suppress a reviewed false positive inline with `// nosemgrep: <rule-id> -- <reason>` (preferred),
or with an expiring entry in .gitlab/security/sast-exceptions.json that names the rule, the path
AND the flagged code: `fingerprint` = sha256 of the flagged source lines (each line
stripped, joined by newlines; survives edits elsewhere in the file, breaks when the flagged code
changes), or else `line` = the exact start line. Whole-file entries (rule + path only) are not
honoured: a new finding of the same rule elsewhere in the file blocks again.

  sast-gate.py <gl-sast-report.json> <out-dir>        evaluate (CI)
  sast-gate.py --fingerprint <path> <line> [<end>]    print the fingerprint for an exception entry
"""
import datetime
import hashlib
import json
import os
import sys

EXCEPTIONS_FILE = os.environ.get("SAST_EXCEPTIONS_FILE", ".gitlab/security/sast-exceptions.json")


def load_exceptions(today: str) -> list:
    if not os.path.exists(EXCEPTIONS_FILE):
        return []
    with open(EXCEPTIONS_FILE, encoding="utf-8") as fh:
        entries = json.load(fh).get("exceptions", [])
    active = []
    for e in entries:
        if str(e.get("expires", "")) >= today:
            active.append(e)
        else:
            print(f"  expired SAST exception (no longer applied): {e.get('rule')} {e.get('path')} ({e.get('expires')})")
    return active

CQ_SEVERITY = {"critical": "critical", "high": "major", "medium": "minor", "low": "info", "info": "info"}


def code_fingerprint(path: str, start: int, end) -> "str | None":
    """sha256 of the flagged lines [start, end] (1-based, each stripped, joined by newlines)."""
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError:
        return None
    last = int(end or start)
    if start < 1 or last < start or last > len(lines):
        return None
    snippet = "\n".join(line.strip() for line in lines[start - 1 : last])
    return hashlib.sha256(snippet.encode("utf-8")).hexdigest()


def waiver_for(exceptions: list, rule: str, path: str, start: int, end) -> "dict | None":
    """The exception that covers exactly this finding: rule + path + (fingerprint and/or line)."""
    for e in exceptions:
        if e.get("rule") != rule or e.get("path") != path:
            continue
        if "fingerprint" not in e and "line" not in e:
            print(f"  IGNORED whole-file SAST exception (needs fingerprint or line): {rule} {path}")
            continue
        if "fingerprint" in e:
            # The flagged code itself is the binding; it may move within the file.
            if e["fingerprint"] != code_fingerprint(path, start, end):
                continue
        elif int(e["line"]) != start:
            continue
        return e
    return None


def main(report_path: str, out_dir: str) -> int:
    fail_on = {s.strip().lower() for s in os.environ.get("SAST_FAIL_ON", "Critical,High").split(",") if s.strip()}
    os.makedirs(out_dir, exist_ok=True)
    if not os.path.exists(report_path):
        print(f"ERROR: {report_path} missing — the SAST analyzer did not produce a report", file=sys.stderr)
        return 1
    with open(report_path, encoding="utf-8") as fh:
        report = json.load(fh)
    scan = report.get("scan", {})
    if scan.get("status") not in (None, "success"):
        print(f"ERROR: SAST scan status is {scan.get('status')!r}", file=sys.stderr)
        return 1
    today = os.environ.get("SAST_TODAY", datetime.date.today().isoformat())
    exceptions = load_exceptions(today)
    issues, blocking, waived = [], [], []
    for vuln in report.get("vulnerabilities", []):
        severity = str(vuln.get("severity", "Unknown")).lower()
        location = vuln.get("location", {})
        path = location.get("file", "unknown")
        line = int(location.get("start_line") or 1)
        rule = next(
            (i.get("value") for i in vuln.get("identifiers", []) if i.get("type") in ("semgrep_id", "semgrep_type")),
            vuln.get("id", "sast"),
        )
        title = vuln.get("name") or vuln.get("message") or rule
        issues.append(
            {
                "description": f"[SAST {severity}] {title} ({rule})",
                "check_name": str(rule),
                "fingerprint": hashlib.sha256(f"{path}:{line}:{rule}".encode()).hexdigest()[:32],
                "severity": CQ_SEVERITY.get(severity, "info"),
                "location": {"path": path, "lines": {"begin": line}},
            }
        )
        if severity in fail_on:
            match = waiver_for(exceptions, rule, path, line, location.get("end_line"))
            if match:
                waived.append(f"{path}:{line} [{severity}] {rule} — waived until {match['expires']}: {match['reason']}")
            else:
                blocking.append(f"{path}:{line} [{severity}] {title} ({rule})")
    with open(os.path.join(out_dir, "gl-code-quality-report.json"), "w", encoding="utf-8") as fh:
        json.dump(issues, fh, indent=2)
    analyzer = scan.get("analyzer", {})
    print(f"SAST: {len(issues)} finding(s) from {analyzer.get('name', '?')} {analyzer.get('version', '')}; failing on {sorted(fail_on)}")
    for item in waived:
        print(f"  WAIVED   {item}")
    for item in blocking:
        print(f"  BLOCKING {item}")
    return 1 if blocking else 0


if __name__ == "__main__":
    if len(sys.argv) >= 4 and sys.argv[1] == "--fingerprint":
        fp = code_fingerprint(sys.argv[2], int(sys.argv[3]), sys.argv[4] if len(sys.argv) > 4 else None)
        if fp is None:
            print(f"cannot read lines {sys.argv[3]}.. of {sys.argv[2]}", file=sys.stderr)
            sys.exit(2)
        print(fp)
        sys.exit(0)
    if len(sys.argv) != 3 or sys.argv[1].startswith("-"):
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
