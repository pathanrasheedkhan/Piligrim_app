const assert = require('node:assert/strict');
const { once } = require('node:events');
const jwt = require('jsonwebtoken');
const test = require('node:test');

const database = require('../db/database');
const authService = require('../auth/auth_service');
const { app } = require('../server');

async function createServer() {
  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  return { server, endpoint: `http://127.0.0.1:${address.port}` };
}

async function post(path, payload) {
  const { server, endpoint } = await createServer();
  try {
    const response = await fetch(`${endpoint}${path}`, {
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

async function registerUser(email, password = 'LoginPass123') {
  return post('/auth/register', { name: 'Login Test User', email, password });
}

async function cleanupEmails(emails) {
  if (emails.length === 0) return;
  await database.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
}

test('successful login normalizes email and returns a verified JWT for the stable user UUID', async () => {
  const email = `login-${Date.now()}@example.com`;
  const originalSecret = process.env.JWT_SECRET;

  try {
    process.env.JWT_SECRET = 'login-test-only-secret';
    const registration = await registerUser(email.toUpperCase());
    assert.equal(registration.response.status, 201);

    const { response, body } = await post('/auth/login', {
      email: `  ${email.toUpperCase()}  `,
      password: 'LoginPass123',
    });

    assert.equal(response.status, 200);
    assert.equal(typeof body.token, 'string');
    assert.equal(body.user.id, registration.body.user.id);
    assert.equal(body.user.name, 'Login Test User');
    assert.equal(body.user.email, email);

    const claims = jwt.verify(body.token, authService.getJwtSecret());
    assert.equal(claims.sub, registration.body.user.id);
    assert.deepEqual(Object.keys(body.user).sort(), ['email', 'id', 'name']);
    assert.equal(body.user.password, undefined);
    assert.equal(body.user.password_hash, undefined);
    assert.equal(JSON.stringify(body).includes('password_hash'), false);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
    await cleanupEmails([email]);
  }
});

test('incorrect password and unknown email return the same generic 401 without a token', async () => {
  const email = `invalid-credentials-${Date.now()}@example.com`;
  const unknownEmail = `unknown-${Date.now()}@example.com`;

  try {
    const registration = await registerUser(email);
    assert.equal(registration.response.status, 201);

    const wrongPassword = await post('/auth/login', { email, password: 'WrongPass123' });
    const unknownUser = await post('/auth/login', { email: unknownEmail, password: 'LoginPass123' });

    assert.equal(wrongPassword.response.status, 401);
    assert.equal(unknownUser.response.status, 401);
    assert.deepEqual(wrongPassword.body, { error: 'Invalid email or password.' });
    assert.deepEqual(unknownUser.body, wrongPassword.body);
    assert.equal(wrongPassword.body.token, undefined);
    assert.equal(unknownUser.body.token, undefined);
  } finally {
    await cleanupEmails([email]);
  }
});

test('login rejects missing, invalid, non-string, and whitespace-only credentials', async () => {
  const invalidInputs = [
    {},
    { password: 'LoginPass123' },
    { email: 'user@example.com' },
    { email: 'not-an-email', password: 'LoginPass123' },
    { email: '   ', password: 'LoginPass123' },
    { email: 'user@example.com', password: '   ' },
    { email: 42, password: 'LoginPass123' },
    { email: 'user@example.com', password: 42 },
  ];

  for (const input of invalidInputs) {
    const { response } = await post('/auth/login', input);
    assert.equal(response.status, 400);
  }
});

test('database failure returns a safe server error without a token or raw details', async () => {
  const originalQuery = database.query;

  try {
    database.query = async () => {
      throw new Error('sensitive postgres connection detail');
    };

    const { response, body } = await post('/auth/login', {
      email: 'database-failure@example.com',
      password: 'LoginPass123',
    });

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: 'Unable to log in at this time.' });
    assert.equal(body.token, undefined);
    assert.equal(JSON.stringify(body).includes('sensitive'), false);
    assert.equal(JSON.stringify(body).includes('stack'), false);
  } finally {
    database.query = originalQuery;
  }
});

test('JWT configuration failure does not return a successful login response', async () => {
  const email = `jwt-failure-${Date.now()}@example.com`;
  const originalSecret = process.env.JWT_SECRET;

  try {
    const registration = await registerUser(email);
    assert.equal(registration.response.status, 201);

    delete process.env.JWT_SECRET;
    const { response, body } = await post('/auth/login', {
      email,
      password: 'LoginPass123',
    });

    assert.equal(response.status, 500);
    assert.deepEqual(body, { error: 'Unable to log in at this time.' });
    assert.equal(body.token, undefined);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
    await cleanupEmails([email]);
  }
});
