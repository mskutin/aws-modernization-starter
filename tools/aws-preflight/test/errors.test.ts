import { describe, expect, it } from 'vitest';
import { classify, isTruncated } from '../src/errors.ts';
import type { ProcessResult } from '../src/executor.ts';

const result = (patch: Partial<ProcessResult>): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  aborted: false,
  outputTooLarge: false,
  durationMs: 1,
  ...patch,
});
const serviceError = (code: string, message = 'details') =>
  result({
    exitCode: 254,
    stderr: `\naws: [ERROR]: An error occurred (${code}) when calling the GetRole operation: ${message}\n`,
  });

describe('classify', () => {
  it('parses JSON output and detects truncation', () => {
    expect(classify(result({ stdout: '{"Vpcs":[]}' }))).toEqual({
      kind: 'ok',
      data: { Vpcs: [] },
      truncated: false,
    });
    expect(classify(result({ stdout: '{"Vpcs":[],"NextToken":"abc"}' }))).toMatchObject({
      truncated: true,
    });
    expect(classify(result({ stdout: '' }))).toEqual({ kind: 'ok', data: {}, truncated: false });
    expect(classify(result({ stdout: 'not json' }))).toEqual({
      kind: 'error',
      code: 'InvalidJsonOutput',
    });
  });

  it.each([
    ['AccessDenied', 'access-denied'],
    ['AccessDeniedException', 'access-denied'],
    ['UnauthorizedOperation', 'access-denied'],
    ['NoSuchEntity', 'not-found'],
    ['ParameterNotFound', 'not-found'],
    ['InvalidVpcID.NotFound', 'not-found'],
    ['NoSuchResourceException', 'not-found'],
    ['Throttling', 'throttled'],
    ['TooManyRequestsException', 'throttled'],
    ['RequestLimitExceeded', 'throttled'],
    ['ExpiredToken', 'credentials'],
    ['ExpiredTokenException', 'credentials'],
    ['InvalidClientTokenId', 'credentials'],
    ['UnrecognizedClientException', 'credentials'],
    ['AuthFailure', 'credentials'],
    ['AWSOrganizationsNotInUseException', 'org-not-in-use'],
    ['OptInRequired', 'error'],
    ['InternalFailure', 'error'],
  ])('service error %s -> %s', (code, kind) => {
    expect(classify(serviceError(code))).toEqual({ kind, code });
  });

  it('treats a missing CloudFormation stack (ValidationError ... does not exist) as not-found', () => {
    expect(
      classify(serviceError('ValidationError', 'Stack with id CDKToolkit does not exist')),
    ).toEqual({
      kind: 'not-found',
      code: 'ValidationError',
    });
    expect(classify(serviceError('ValidationError', '1 validation error detected'))).toEqual({
      kind: 'error',
      code: 'ValidationError',
    });
  });

  it.each([
    [
      'Error when retrieving token from sso: Token has expired and refresh failed',
      'SSOTokenRetrievalError',
    ],
    [
      'The SSO session associated with this profile has expired or is otherwise invalid. To refresh this SSO session run aws sso login with the corresponding profile.',
      'SSOSessionExpired',
    ],
    ['Error loading SSO Token: Token for x does not exist', 'SSOTokenLoadError'],
    [
      'Unable to locate credentials. You can configure credentials by running "aws login".',
      'NoCredentials',
    ],
    ['The config profile (starter-sandbox) could not be found', 'ProfileNotFound'],
    ["Your session has expired. Please reauthenticate using 'aws login'.", 'LoginSessionExpired'],
  ])('credential failure "%s" -> credentials %s', (message, code) => {
    expect(classify(result({ exitCode: 255, stderr: `\naws: [ERROR]: ${message}\n` }))).toEqual({
      kind: 'credentials',
      code,
    });
  });

  it('maps process-level failures', () => {
    expect(classify(result({ timedOut: true, exitCode: null, signal: 'SIGKILL' }))).toEqual({
      kind: 'timeout',
      code: 'Timeout',
    });
    expect(classify(result({ aborted: true, exitCode: null }))).toEqual({
      kind: 'interrupted',
      code: 'Interrupted',
    });
    expect(classify(result({ spawnError: 'ENOENT', exitCode: null }))).toEqual({
      kind: 'error',
      code: 'SpawnFailed:ENOENT',
    });
    expect(classify(result({ outputTooLarge: true, exitCode: null }))).toEqual({
      kind: 'error',
      code: 'OutputTooLarge',
    });
    expect(
      classify(result({ exitCode: 252, stderr: 'aws: [ERROR]: argument --foo: invalid' })),
    ).toEqual({ kind: 'error', code: 'ParamValidation' });
    expect(
      classify(
        result({
          exitCode: 255,
          stderr: 'aws: [ERROR]: Could not connect to the endpoint URL: "https://sts.example"',
        }),
      ),
    ).toEqual({
      kind: 'error',
      code: 'EndpointConnectionError',
    });
  });

  it('never returns the AWS error message', () => {
    const c = classify(
      serviceError(
        'AccessDenied',
        'User: arn:aws:sts::111122223333:assumed-role/x/jane.doe@example.com is not authorized',
      ),
    );
    expect(JSON.stringify(c)).not.toMatch(/111122223333|jane\.doe/);
  });
});

describe('isTruncated', () => {
  it.each([
    [{ NextToken: 'x' }, true],
    [{ nextToken: 'x' }, true],
    [{ NextMarker: 'x' }, true],
    [{ IsTruncated: true }, true],
    [{ Marker: '' }, false],
    [{ Items: [] }, false],
    [[], false],
  ])('%o -> %s', (data, expected) => {
    expect(isTruncated(data)).toBe(expected);
  });
});
