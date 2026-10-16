import { describe, expect, it } from 'vitest';
import { DatabaseCredentialError } from '../../src/credentials.js';
import {
  classifyDbError,
  isAuthenticationFailure,
  isPermissionDenied,
  isTransientDbError,
  quoteIdent,
  quoteLiteral,
  sqlState,
} from '../../src/errors.js';
import { DatabaseTlsError } from '../../src/tls.js';

const pgError = (code: string, message = 'server error') =>
  Object.assign(new Error(message), { code });

describe('classifyDbError', () => {
  it.each([
    ['53300 too_many_connections (also a role CONNECTION LIMIT)', pgError('53300')],
    ['57P01 admin_shutdown (failover)', pgError('57P01')],
    ['57P02 crash_shutdown', pgError('57P02')],
    ['57P03 cannot_connect_now (starting up)', pgError('57P03')],
    ['08006 connection_failure', pgError('08006')],
    ['08001 sqlclient_unable_to_establish_sqlconnection', pgError('08001')],
    ['ECONNREFUSED', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['ECONNRESET', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['ETIMEDOUT', Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' })],
    ['EAI_AGAIN', Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' })],
    ['pg connect timeout', new Error('Connection terminated due to connection timeout')],
    ['pg-pool connect timeout', new Error('timeout exceeded when trying to connect')],
    ['pg client connect timeout', new Error('timeout expired')],
    ['dropped connection', new Error('Connection terminated unexpectedly')],
    ['read timeout', new Error('Query read timeout')],
    ['IAM signing hiccup', new DatabaseCredentialError('x', { transient: true })],
  ])('transient: %s', (_name, error) => {
    expect(classifyDbError(error)).toBe('transient');
    expect(isTransientDbError(error)).toBe(true);
  });

  it.each([
    ['42501 insufficient_privilege', pgError('42501')],
    ['28P01 invalid_password', pgError('28P01')],
    ['28000 invalid_authorization_specification', pgError('28000')],
    ['42P01 undefined_table', pgError('42P01')],
    ['42883 undefined_function', pgError('42883')],
    ['22P02 invalid_text_representation', pgError('22P02')],
    ['23505 unique_violation', pgError('23505')],
    ['57014 query_canceled (statement_timeout)', pgError('57014')],
    ['XX000 internal_error', pgError('XX000')],
    [
      'TLS: certificate host name mismatch',
      Object.assign(new Error('Hostname/IP does not match'), {
        code: 'ERR_TLS_CERT_ALTNAME_INVALID',
      }),
    ],
    [
      'TLS: unknown CA',
      Object.assign(new Error('self-signed certificate in certificate chain'), {
        code: 'SELF_SIGNED_CERT_IN_CHAIN',
      }),
    ],
    ['TLS configuration', new DatabaseTlsError('cannot read DB_SSL_ROOT_CERT')],
    ['configuration credential error', new DatabaseCredentialError('DB_PASSWORD_FILE is empty')],
    ['DNS: unknown host', Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })],
    ['anything else', new Error('boom')],
    ['a non-error', 'boom'],
    ['undefined', undefined],
  ])('permanent: %s', (_name, error) => {
    expect(classifyDbError(error)).toBe('permanent');
  });
});

describe('SQLSTATE helpers', () => {
  it('reads only well-formed SQLSTATEs', () => {
    expect(sqlState(pgError('42501'))).toBe('42501');
    expect(sqlState(Object.assign(new Error(), { code: 'ECONNREFUSED' }))).toBeUndefined();
    expect(isPermissionDenied(pgError('42501'))).toBe(true);
    expect(isAuthenticationFailure(pgError('28P01'))).toBe(true);
    expect(isAuthenticationFailure(pgError('42501'))).toBe(false);
  });

  it('quotes identifiers and literals like PostgreSQL', () => {
    expect(quoteIdent('starter_app')).toBe('"starter_app"');
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(quoteLiteral("it's")).toBe("'it''s'");
    expect(quoteLiteral('a\\b')).toBe("E'a\\\\b'");
    expect(() => quoteIdent('')).toThrow();
    expect(() => quoteLiteral('\u0000')).toThrow();
  });
});
