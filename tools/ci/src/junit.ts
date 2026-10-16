/** Minimal JUnit XML writer (GitLab `artifacts:reports:junit`). */

export interface JunitCase {
  name: string;
  classname: string;
  failure?: string;
  skipped?: string;
}

function escape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderJunit(suite: string, cases: JunitCase[]): string {
  const failures = cases.filter((c) => c.failure !== undefined).length;
  const skipped = cases.filter((c) => c.skipped !== undefined).length;
  const body = cases
    .map((c) => {
      const open = `    <testcase name="${escape(c.name)}" classname="${escape(c.classname)}"`;
      if (c.failure !== undefined) {
        return `${open}>\n      <failure message="${escape(c.failure.split('\n')[0] ?? '')}">${escape(c.failure)}</failure>\n    </testcase>`;
      }
      if (c.skipped !== undefined) {
        return `${open}>\n      <skipped message="${escape(c.skipped)}"/>\n    </testcase>`;
      }
      return `${open}/>`;
    })
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites>
  <testsuite name="${escape(suite)}" tests="${cases.length}" failures="${failures}" skipped="${skipped}">
${body}
  </testsuite>
</testsuites>
`;
}
