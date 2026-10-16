import { DB_BOOTSTRAP_ROLE_STEMS } from '@starter/config';
import { describe, expect, it } from 'vitest';
import {
  DB_LOGIN_ROLES,
  DB_MANAGED_ROLES,
  DB_ROLES,
  MIGRATION_OWNER_ROLE,
  isDbLoginRole,
} from '../../src/roles.js';

describe('role names (fixed, referenced by CDK and other packages)', () => {
  it('are the contract names', () => {
    expect(DB_ROLES).toEqual({
      owner: 'starter_owner',
      migrator: 'starter_migrator',
      app: 'starter_app',
      processor: 'starter_processor',
      retention: 'starter_retention',
    });
    expect(DB_MANAGED_ROLES).toEqual(Object.values(DB_ROLES));
    expect(MIGRATION_OWNER_ROLE).toBe('starter_owner');
  });

  it('login roles exclude the owner and match the bootstrap env names in @starter/config', () => {
    expect([...DB_LOGIN_ROLES]).toEqual([
      'starter_migrator',
      'starter_app',
      'starter_processor',
      'starter_retention',
    ]);
    expect(Object.keys(DB_BOOTSTRAP_ROLE_STEMS).sort()).toEqual([...DB_LOGIN_ROLES].sort());
    expect(isDbLoginRole('starter_owner')).toBe(false);
    expect(isDbLoginRole('starter_app')).toBe(true);
  });
});
