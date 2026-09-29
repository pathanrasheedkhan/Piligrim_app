const assert = require('node:assert/strict');
const test = require('node:test');

const database = require('../db/database');
const authConfig = require('../auth/auth_config');
const authService = require('../auth/auth_service');

test('existing users table remains compatible with stable UUID-based identity', async () => {
  const columnsResult = await database.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users'
    ORDER BY ordinal_position
  `);
  const columns = columnsResult.rows.map((row) => row.column_name);

  assert.ok(columns.includes('id'));
  assert.ok(columns.includes('name'));
  assert.ok(columns.includes('created_at'));
  assert.ok(columns.includes('updated_at'));

  const idTypeResult = await database.query(`
    SELECT data_type
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'id'
  `);
  assert.equal(idTypeResult.rows[0].data_type, 'uuid');

  const groupForeignKeyResult = await database.query(`
    SELECT ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.table_name = 'groups'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'creator_user_id'
  `);
  const memberForeignKeyResult = await database.query(`
    SELECT ccu.table_name AS foreign_table_name,
           ccu.column_name AS foreign_column_name
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.table_schema = tc.table_schema
    WHERE tc.table_name = 'group_members'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'user_id'
  `);

  assert.deepEqual(groupForeignKeyResult.rows[0], {
    foreign_table_name: 'users',
    foreign_column_name: 'id',
  });
  assert.deepEqual(memberForeignKeyResult.rows[0], {
    foreign_table_name: 'users',
    foreign_column_name: 'id',
  });
});

test('password hashing produces a one-way hash that verifies correctly', async () => {
  const plainTextPassword = 'S3cur3Pass!';
  const hash = await authService.hashPassword(plainTextPassword);

  assert.notEqual(hash, plainTextPassword);
  assert.match(hash, /^\$2[aby]\$/);
  assert.equal(await authService.verifyPassword(plainTextPassword, hash), true);
  assert.equal(await authService.verifyPassword('wrong-password', hash), false);
});

test('password hashes are not reversible and only support verification', async () => {
  const plainTextPassword = 'AnotherStrongPass!';
  const hash = await authService.hashPassword(plainTextPassword);

  assert.notEqual(hash, plainTextPassword);
  assert.equal(typeof authService.decryptPassword, 'undefined');
  assert.equal(await authService.verifyPassword(plainTextPassword, hash), true);
});

test('JWT config is loaded from environment settings and rejects missing secrets', async () => {
  const originalSecret = process.env.JWT_SECRET;
  const originalExpiresIn = process.env.JWT_EXPIRES_IN;

  try {
    delete process.env.JWT_SECRET;
    delete process.env.JWT_EXPIRES_IN;
    assert.throws(() => authConfig.getJwtConfig(), /JWT_SECRET/);

    process.env.JWT_SECRET = 'dev-local-secret';
    process.env.JWT_EXPIRES_IN = '2h';
    assert.deepEqual(authConfig.getJwtConfig(), {
      secret: 'dev-local-secret',
      expiresIn: '2h',
    });
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }

    if (originalExpiresIn === undefined) {
      delete process.env.JWT_EXPIRES_IN;
    } else {
      process.env.JWT_EXPIRES_IN = originalExpiresIn;
    }
  }
});
