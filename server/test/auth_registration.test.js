const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');

const database = require('../db/database');
const authService = require('../auth/auth_service');
const { app } = require('../server');

async function createServer() {
  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  return { server, endpoint: `http://127.0.0.1:${address.port}/auth/register` };
}

async function cleanupEmails(emails) {
  if (emails.length === 0) return;
  await database.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
}

async function registerUser(payload) {
  const { server, endpoint } = await createServer();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test('successful registration creates a user with a UUID identity and safe response', async () => {
  const email = `success-${Date.now()}@example.com`;

  try {
    const { response, body } = await registerUser({
      name: 'Test User',
      email,
      password: 'SecurePass123',
    });

    assert.equal(response.status, 201);
    assert.equal(typeof body.user.id, 'string');
    assert.equal(body.user.name, 'Test User');
    assert.equal(body.user.email, email.toLowerCase());
    assert.ok(body.user.createdAt);
    assert.ok(body.user.updatedAt);
    assert.equal(body.user.password, undefined);
    assert.equal(body.user.password_hash, undefined);

    const result = await database.query(
      'SELECT id, name, email, password_hash FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].name, 'Test User');
    assert.equal(result.rows[0].email, email.toLowerCase());
    assert.equal(typeof result.rows[0].password_hash, 'string');
    assert.notEqual(result.rows[0].password_hash, 'SecurePass123');
    assert.notEqual(result.rows[0].password_hash, '');
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('stored password hash verifies the original password without exposing it in the response', async () => {
  const email = `verify-${Date.now()}@example.com`;

  try {
    const { response, body } = await registerUser({
      name: 'Verify User',
      email,
      password: 'VerifyPass456',
    });

    assert.equal(response.status, 201);
    assert.equal(body.user.password, undefined);
    assert.equal(body.user.password_hash, undefined);

    const result = await database.query(
      'SELECT password_hash FROM users WHERE email = $1',
      [email.toLowerCase()],
    );
    assert.equal(result.rows.length, 1);
    assert.equal(await authService.verifyPassword('VerifyPass456', result.rows[0].password_hash), true);
    assert.equal(await authService.verifyPassword('WrongPass456', result.rows[0].password_hash), false);
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('response does not leak password or password_hash fields', async () => {
  const email = `safe-${Date.now()}@example.com`;

  try {
    const { response, body } = await registerUser({
      name: 'Safe User',
      email,
      password: 'SafePass789',
    });

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(body.user).sort(), ['createdAt', 'email', 'id', 'name', 'updatedAt']);
    assert.equal(body.user.password, undefined);
    assert.equal(body.user.password_hash, undefined);
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('duplicate registration rejects the same email and ignores case differences', async () => {
  const email = `duplicate-${Date.now()}@example.com`;

  try {
    const first = await registerUser({
      name: 'First User',
      email,
      password: 'StrongPass123',
    });
    assert.equal(first.response.status, 201);

    const second = await registerUser({
      name: 'Second User',
      email: email.toUpperCase(),
      password: 'AnotherPass123',
    });

    assert.equal(second.response.status, 409);
    assert.match(second.body.error || second.body.message, /already exists|email/i);

    const total = await database.query('SELECT COUNT(*) AS total FROM users WHERE email = $1', [email.toLowerCase()]);
    assert.equal(Number(total.rows[0].total), 1);
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('missing name is rejected without creating a user', async () => {
  const email = `missing-name-${Date.now()}@example.com`;

  try {
    const { response, body } = await registerUser({
      email,
      password: 'ValidPass123',
    });

    assert.equal(response.status, 400);
    assert.match(body.error || body.message, /name/i);
    const result = await database.query('SELECT COUNT(*) AS total FROM users WHERE email = $1', [email.toLowerCase()]);
    assert.equal(Number(result.rows[0].total), 0);
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('missing email is rejected without creating a user', async () => {
  const email = `missing-email-${Date.now()}@example.com`;

  try {
    const { response, body } = await registerUser({
      name: 'No Email User',
      password: 'ValidPass123',
    });

    assert.equal(response.status, 400);
    assert.match(body.error || body.message, /email/i);
    const result = await database.query('SELECT COUNT(*) AS total FROM users WHERE email = $1', [email.toLowerCase()]);
    assert.equal(Number(result.rows[0].total), 0);
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('missing password is rejected without creating a user', async () => {
  const email = `missing-password-${Date.now()}@example.com`;

  try {
    const { response, body } = await registerUser({
      name: 'No Password User',
      email,
    });

    assert.equal(response.status, 400);
    assert.match(body.error || body.message, /password/i);
    const result = await database.query('SELECT COUNT(*) AS total FROM users WHERE email = $1', [email.toLowerCase()]);
    assert.equal(Number(result.rows[0].total), 0);
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('invalid email format is rejected', async () => {
  const email = `invalid-${Date.now()}@example.com`;

  try {
    const { response, body } = await registerUser({
      name: 'Bad Email User',
      email: 'not-an-email',
      password: 'ValidPass123',
    });

    assert.equal(response.status, 400);
    assert.match(body.error || body.message, /email/i);
    const result = await database.query('SELECT COUNT(*) AS total FROM users WHERE email = $1', [email.toLowerCase()]);
    assert.equal(Number(result.rows[0].total), 0);
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('whitespace-only name, email, and password inputs are rejected', async () => {
  const email = `whitespace-${Date.now()}@example.com`;

  try {
    const nameOnly = await registerUser({
      name: '   ',
      email,
      password: 'ValidPass123',
    });
    assert.equal(nameOnly.response.status, 400);

    const emailOnly = await registerUser({
      name: 'Whitespace User',
      email: '   ',
      password: 'ValidPass123',
    });
    assert.equal(emailOnly.response.status, 400);

    const passwordOnly = await registerUser({
      name: 'Whitespace User',
      email,
      password: '   ',
    });
    assert.equal(passwordOnly.response.status, 400);
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('password policy rejects passwords shorter than the configured minimum', async () => {
  const email = `short-pass-${Date.now()}@example.com`;

  try {
    const { response, body } = await registerUser({
      name: 'Short Password User',
      email,
      password: 'Short1',
    });

    assert.equal(response.status, 400);
    assert.match(body.error || body.message, /password|length/i);
    const result = await database.query('SELECT COUNT(*) AS total FROM users WHERE email = $1', [email.toLowerCase()]);
    assert.equal(Number(result.rows[0].total), 0);
  } finally {
    await cleanupEmails([email.toLowerCase()]);
  }
});

test('database failure returns a safe error and never leaks hashes', async () => {
  const email = `db-failure-${Date.now()}@example.com`;
  const originalQuery = database.query;

  try {
    database.query = async () => { throw new Error('database exploded'); };
    const { response, body } = await registerUser({
      name: 'Failure User',
      email,
      password: 'ValidPass123',
    });

    assert.equal(response.status, 500);
    assert.equal(body.password, undefined);
    assert.equal(body.password_hash, undefined);
    assert.match(body.error || body.message, /unable|register|database/i);
  } finally {
    database.query = originalQuery;
    await cleanupEmails([email.toLowerCase()]);
  }
});
