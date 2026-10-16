import type { JobStatus } from '@starter/contracts';

/** Status text plus colour — colour is never the only signal. */
export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={`badge badge--${status.toLowerCase()}`} data-status={status}>
      {status}
    </span>
  );
}
