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

async function request(path, options = {}) {
  const { server, endpoint } = await createServer();
  try {
    const response = await fetch(`${endpoint}${path}`, {
      method: options.method || 'GET',
      headers: options.headers || {},
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const body = await response.json().catch(() => ({}));
    return { response, body };
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function registerUser(email, password = 'AuthMiddlewarePass123') {
  return request('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { name: 'Auth Middleware User', email, password },
  });
}

async function loginUser(email, password = 'AuthMiddlewarePass123') {
  return request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { email, password },
  });
}

async function cleanupEmails(emails) {
  if (emails.length === 0) return;
  await database.query('DELETE FROM users WHERE email = ANY($1)', [emails]);
}

function createSignedToken({ subject, secret, payload = {}, expiresIn = '1h' }) {
  const tokenPayload = { ...payload };
  if (subject !== undefined) {
    tokenPayload.sub = subject;
  }

  return jwt.sign(tokenPayload, secret, { expiresIn });
}

test('valid bearer token populates req.user.id from the verified JWT sub claim', async () => {
  const email = `auth-mw-${Date.now()}@example.com`;
  const originalSecret = process.env.JWT_SECRET;

  try {
    process.env.JWT_SECRET = 'middleware-test-secret';

    const registration = await registerUser(email);
    assert.equal(registration.response.status, 201);

    const login = await loginUser(email);
    assert.equal(login.response.status, 200);
    assert.equal(typeof login.body.token, 'string');

    const { response, body } = await request('/auth/me', {
      headers: { Authorization: `Bearer ${login.body.token}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body.user, { id: login.body.user.id });
    assert.equal(body.user.id, login.body.user.id);
    assert.equal(body.user.password, undefined);
    assert.equal(body.user.password_hash, undefined);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
    await cleanupEmails([email]);
  }
});

test('missing and empty Authorization headers are rejected', async () => {
  const missing = await request('/auth/me');
  const empty = await request('/auth/me', { headers: { Authorization: '' } });

  assert.equal(missing.response.status, 401);
  assert.deepEqual(missing.body, { error: 'Authentication required.' });
  assert.equal(empty.response.status, 401);
  assert.deepEqual(empty.body, { error: 'Authentication required.' });
});

test('wrong scheme, missing bearer token, and malformed bearer values are rejected', async () => {
  const wrongScheme = await request('/auth/me', {
    headers: { Authorization: 'Basic abc' },
  });
  const missingToken = await request('/auth/me', {
    headers: { Authorization: 'Bearer' },
  });
  const malformed = await request('/auth/me', {
    headers: { Authorization: 'Bearer token extra' },
  });

  assert.equal(wrongScheme.response.status, 401);
  assert.deepEqual(wrongScheme.body, { error: 'Authentication required.' });
  assert.equal(missingToken.response.status, 401);
  assert.deepEqual(missingToken.body, { error: 'Authentication required.' });
  assert.equal(malformed.response.status, 401);
  assert.deepEqual(malformed.body, { error: 'Authentication required.' });
});

test('malformed, unsigned, expired, missing-sub, and invalid-sub JWTs are rejected', async () => {
  const email = `jwt-scenarios-${Date.now()}@example.com`;
  const originalSecret = process.env.JWT_SECRET;

  try {
    process.env.JWT_SECRET = 'middleware-test-secret';
    const registration = await registerUser(email);
    assert.equal(registration.response.status, 201);

    const validLogin = await loginUser(email);
    assert.equal(validLogin.response.status, 200);
    const userId = validLogin.body.user.id;

    const malformed = await request('/auth/me', {
      headers: { Authorization: 'Bearer not-a-jwt' },
    });
    const unsigned = await request('/auth/me', {
      headers: { Authorization: `Bearer ${createSignedToken({ subject: userId, secret: 'different-secret', payload: { role: 'user' } })}` },
    });
    const expired = await request('/auth/me', {
      headers: { Authorization: `Bearer ${createSignedToken({ subject: userId, secret: 'middleware-test-secret', payload: { role: 'user' }, expiresIn: '-1s' })}` },
    });
    const missingSub = await request('/auth/me', {
      headers: { Authorization: `Bearer ${createSignedToken({ secret: 'middleware-test-secret', payload: { role: 'user' } })}` },
    });
    const invalidSub = await request('/auth/me', {
      headers: { Authorization: `Bearer ${createSignedToken({ secret: 'middleware-test-secret', payload: { role: 'user', sub: 'not-a-uuid' } })}` },
    });

    for (const result of [malformed, unsigned, expired, missingSub, invalidSub]) {
      assert.equal(result.response.status, 401);
      assert.deepEqual(result.body, { error: 'Authentication required.' });
      assert.equal(result.body.token, undefined);
    }
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
    await cleanupEmails([email]);
  }
});

test('invalid authentication responses do not leak sensitive JWT details', async () => {
  const originalSecret = process.env.JWT_SECRET;

  try {
    process.env.JWT_SECRET = 'middleware-test-secret';

    const { response, body } = await request('/auth/me', {
      headers: { Authorization: 'Bearer invalid.token.signature' },
    });

    assert.equal(response.status, 401);
    assert.deepEqual(body, { error: 'Authentication required.' });
    assert.equal(JSON.stringify(body).includes('JsonWebTokenError'), false);
    assert.equal(JSON.stringify(body).includes('secret'), false);
    assert.equal(JSON.stringify(body).includes('stack'), false);
    assert.equal(JSON.stringify(body).includes('expired'), false);
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});

test('middleware ignores client-supplied identity values and derives req.user.id only from the verified JWT sub claim', async () => {
  const email = `identity-${Date.now()}@example.com`;
  const originalSecret = process.env.JWT_SECRET;

  try {
    process.env.JWT_SECRET = 'middleware-test-secret';
    const registration = await registerUser(email);
    assert.equal(registration.response.status, 201);

    const login = await loginUser(email);
    assert.equal(login.response.status, 200);

    const token = jwt.sign({ role: 'user' }, 'middleware-test-secret', {
      subject: login.body.user.id,
      expiresIn: '1h',
    });

    const { response, body } = await request(`/auth/me?userId=00000000-0000-0000-0000-000000000001`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(body.user, { id: login.body.user.id });
    assert.notEqual(body.user.id, '00000000-0000-0000-0000-000000000001');
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
    await cleanupEmails([email]);
  }
});
