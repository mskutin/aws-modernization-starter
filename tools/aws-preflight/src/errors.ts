/**
 * Classifies one AWS CLI result. Only the error *code* ever leaves this module; AWS error
 * messages (which contain ARNs, account IDs and principal names) stay in the private raw file.
 *
 * The CLI runs with AWS_CLI_ERROR_FORMAT=legacy, so service errors look like
 *   aws: [ERROR]: An error occurred (AccessDenied) when calling the GetRole operation: ...
 * (also the format of releases that predate --cli-error-format). Credential problems that are not
 * service errors (SSO token expired, no credentials, unknown profile) are recognised by the
 * botocore messages of aws-cli 2.35.11.
 */
import type { ProcessResult } from './executor.ts';
import { isRecord } from './types.ts';

export type Classified =
  | { readonly kind: 'ok'; readonly data: unknown; readonly truncated: boolean }
  | { readonly kind: 'access-denied'; readonly code: string }
  | { readonly kind: 'not-found'; readonly code: string }
  | { readonly kind: 'throttled'; readonly code: string }
  /** Expired or invalid credentials / SSO session: abort the run (exit 6), never retry. */
  | { readonly kind: 'credentials'; readonly code: string }
  | { readonly kind: 'org-not-in-use'; readonly code: string }
  | { readonly kind: 'timeout'; readonly code: 'Timeout' }
  | { readonly kind: 'interrupted'; readonly code: 'Interrupted' }
  | { readonly kind: 'error'; readonly code: string };

const ACCESS_DENIED = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'UnauthorizedOperation',
  'UnauthorizedException',
  'AccessDeniedForDependencyException',
  'AuthorizationError',
  'AuthorizationErrorException',
  'Forbidden',
  'ForbiddenException',
]);

const NOT_FOUND = new Set([
  'NoSuchEntity',
  'NoSuchEntityException',
  'ParameterNotFound',
  'NotFoundException',
  'ResourceNotFoundException',
  'NoSuchHostedZone',
  'TargetNotFoundException',
  'EffectivePolicyNotFoundException',
  'PolicyNotFoundException',
  'NoSuchResourceException',
  'CertificateNotFound',
  'CertificateNotFoundFault',
  'RegistryNotFoundException',
]);

const THROTTLED = new Set([
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'RequestThrottled',
  'RequestThrottledException',
  'SlowDown',
  'PriorRequestNotComplete',
  'BandwidthLimitExceeded',
  'EC2ThrottledException',
]);

/** Service error codes meaning the credentials themselves are expired or invalid. */
const CREDENTIALS = new Set([
  'ExpiredToken',
  'ExpiredTokenException',
  'InvalidClientTokenId',
  'UnrecognizedClientException',
  'AuthFailure',
  'InvalidToken',
  'TokenRefreshRequired',
  'SignatureDoesNotMatch',
  'InvalidSignatureException',
  'IncompleteSignature',
  'MissingAuthenticationToken',
  'MissingAuthenticationTokenException',
]);

/** Non-service credential failures (botocore exception messages), mapped to stable codes. */
const CREDENTIAL_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [
    /The SSO session associated with this profile has expired or is otherwise invalid/i,
    'SSOSessionExpired',
  ],
  [/Error loading SSO Token/i, 'SSOTokenLoadError'],
  [/Error when retrieving token from sso/i, 'SSOTokenRetrievalError'],
  [/Token has expired and refresh failed/i, 'SSOTokenExpired'],
  [/pending authorization to retrieve an SSO token has expired/i, 'SSOAuthorizationExpired'],
  [/Your session has expired\. Please reauthenticate/i, 'LoginSessionExpired'],
  [/Unable to locate credentials/i, 'NoCredentials'],
  [/Unable to locate authorization token/i, 'NoAuthToken'],
  [/The config profile \(.*\) could not be found/i, 'ProfileNotFound'],
  [/Error when retrieving credentials from/i, 'CredentialRetrievalError'],
  [/Partial credentials found in/i, 'PartialCredentials'],
];

const CONNECTION_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [/Could not connect to the endpoint URL/i, 'EndpointConnectionError'],
  [/Connect timeout on endpoint URL/i, 'ConnectTimeout'],
  [/Read timeout on endpoint URL/i, 'ReadTimeout'],
  [/Failed to connect to proxy URL/i, 'ProxyConnectionError'],
  [/SSL validation failed/i, 'SSLError'],
];

const SERVICE_ERROR_RE = /An error occurred \(([A-Za-z0-9_.:-]{1,128})\)/;

/** Pagination tokens the CLI leaves in the output when a bound stopped the listing. */
export function isTruncated(data: unknown): boolean {
  if (!isRecord(data)) return false;
  for (const key of ['NextToken', 'nextToken', 'NextMarker', 'Marker']) {
    const v = data[key];
    if (typeof v === 'string' && v.length > 0) return true;
  }
  return data['IsTruncated'] === true;
}

export function classify(r: ProcessResult): Classified {
  if (r.aborted) return { kind: 'interrupted', code: 'Interrupted' };
  if (r.timedOut) return { kind: 'timeout', code: 'Timeout' };
  if (r.spawnError !== undefined) return { kind: 'error', code: `SpawnFailed:${r.spawnError}` };
  if (r.outputTooLarge) return { kind: 'error', code: 'OutputTooLarge' };
  if (r.exitCode === 0) {
    const out = r.stdout.trim();
    if (out === '') return { kind: 'ok', data: {}, truncated: false };
    try {
      const data: unknown = JSON.parse(out);
      return { kind: 'ok', data, truncated: isTruncated(data) };
    } catch {
      return { kind: 'error', code: 'InvalidJsonOutput' };
    }
  }
  const service = SERVICE_ERROR_RE.exec(r.stderr)?.[1];
  if (service) {
    if (CREDENTIALS.has(service)) return { kind: 'credentials', code: service };
    if (ACCESS_DENIED.has(service)) return { kind: 'access-denied', code: service };
    if (THROTTLED.has(service)) return { kind: 'throttled', code: service };
    if (service === 'AWSOrganizationsNotInUseException')
      return { kind: 'org-not-in-use', code: service };
    if (NOT_FOUND.has(service) || /\.NotFound$/.test(service))
      return { kind: 'not-found', code: service };
    // CloudFormation reports a missing stack as ValidationError "Stack with id X does not exist".
    if (service === 'ValidationError' && /does not exist/i.test(r.stderr)) {
      return { kind: 'not-found', code: service };
    }
    return { kind: 'error', code: service };
  }
  for (const [re, code] of CREDENTIAL_MESSAGES)
    if (re.test(r.stderr)) return { kind: 'credentials', code };
  for (const [re, code] of CONNECTION_MESSAGES)
    if (re.test(r.stderr)) return { kind: 'error', code };
  const byExit: Record<number, string> = {
    252: 'ParamValidation',
    253: 'Configuration',
    254: 'ClientError',
    255: 'GeneralError',
  };
  if (r.signal) return { kind: 'error', code: `Signal:${r.signal}` };
  return { kind: 'error', code: byExit[r.exitCode ?? -1] ?? `ExitCode:${r.exitCode ?? 'none'}` };
}

/** Evidence status of a classified (non-credential) result. */
export function statusOf(
  c: Classified,
): 'ok' | 'access-denied' | 'not-found' | 'error' | 'timeout' {
  switch (c.kind) {
    case 'ok':
      return 'ok';
    case 'access-denied':
      return 'access-denied';
    case 'not-found':
      return 'not-found';
    case 'timeout':
      return 'timeout';
    default:
      return 'error';
  }
}
