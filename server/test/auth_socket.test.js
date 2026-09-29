const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const jwt = require('jsonwebtoken');
const test = require('node:test');
const { io } = require('socket.io-client');

const { app, createSocketServer } = require('../server');

async function createSocketTestServer() {
  const httpServer = http.createServer(app);
  const ioServer = createSocketServer(httpServer);
  await new Promise((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  return {
    httpServer,
    ioServer,
    url: `http://127.0.0.1:${address.port}`,
  };
}

function createValidToken({ subject, secret = 'socket-auth-test-secret', expiresIn = '1h', payload = {} }) {
  const claims = { ...payload };
  if (subject !== undefined) {
    claims.sub = subject;
  }
  return jwt.sign(claims, secret, { expiresIn });
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('valid JWT authenticates the socket and establishes socket.userId from the verified sub claim', async () => {
  const originalSecret = process.env.JWT_SECRET;
  const userId = '01234567-89ab-41cd-82ef-0123456789ab';

  try {
    process.env.JWT_SECRET = 'socket-auth-test-secret';
    const { httpServer, url } = await createSocketTestServer();
    try {
      const socket = io(url, {
        transports: ['websocket'],
        forceNew: true,
        auth: { token: createValidToken({ subject: userId, secret: 'socket-auth-test-secret' }) },
      });

      const [event] = await once(socket, 'authenticated_user');
      assert.equal(event.userId, userId);
      assert.equal(socket.connected, true);
      socket.disconnect();
    } finally {
      await closeServer(httpServer);
    }
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});

test('missing token is rejected during the Socket.IO handshake', async () => {
  const originalSecret = process.env.JWT_SECRET;

  try {
    process.env.JWT_SECRET = 'socket-auth-test-secret';
    const { httpServer, url } = await createSocketTestServer();
    try {
      const socket = io(url, { transports: ['websocket'], forceNew: true, auth: {} });
      const error = await Promise.race([
        once(socket, 'connect_error').then(([event]) => event),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]);

      assert.notEqual(error, 'timeout');
      assert.equal(error.message, 'Authentication required');
      assert.equal(socket.connected, false);
    } finally {
      await closeServer(httpServer);
    }
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});

test('empty, malformed, unsigned, expired, missing-sub, and invalid-sub tokens are rejected', async () => {
  const originalSecret = process.env.JWT_SECRET;
  const userId = '01234567-89ab-41cd-82ef-0123456789ab';

  try {
    process.env.JWT_SECRET = 'socket-auth-test-secret';
    const { httpServer, url } = await createSocketTestServer();
    try {
      const scenarios = [
        { label: 'empty-token', auth: { token: '' } },
        { label: 'malformed-token', auth: { token: 'abc' } },
        { label: 'unsigned-token', auth: { token: createValidToken({ subject: userId, secret: 'different-secret' }) } },
        { label: 'expired-token', auth: { token: createValidToken({ subject: userId, secret: 'socket-auth-test-secret', expiresIn: '-1s' }) } },
        { label: 'missing-sub', auth: { token: createValidToken({ secret: 'socket-auth-test-secret', payload: { role: 'user' } }) } },
        { label: 'invalid-sub', auth: { token: createValidToken({ subject: 'not-a-uuid', secret: 'socket-auth-test-secret' }) } },
      ];

      for (const scenario of scenarios) {
        const socket = io(url, { transports: ['websocket'], forceNew: true, auth: scenario.auth });
        const error = await Promise.race([
          once(socket, 'connect_error').then(([event]) => event),
          new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
        ]);

        assert.notEqual(error, 'timeout', `${scenario.label} did not fail`);
        assert.equal(error.message, 'Authentication required', `${scenario.label} leaked an unexpected error`);
        assert.equal(socket.connected, false, `${scenario.label} unexpectedly connected`);
      }
    } finally {
      await closeServer(httpServer);
    }
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});

test('client-supplied userId is ignored and the verified JWT subject remains the socket identity', async () => {
  const originalSecret = process.env.JWT_SECRET;
  const verifiedUserId = '01234567-89ab-41cd-82ef-0123456789ab';
  const clientUserId = '11111111-1111-4111-8111-111111111111';

  try {
    process.env.JWT_SECRET = 'socket-auth-test-secret';
    const { httpServer, url } = await createSocketTestServer();
    try {
      const socket = io(url, {
        transports: ['websocket'],
        forceNew: true,
        auth: {
          token: createValidToken({ subject: verifiedUserId, secret: 'socket-auth-test-secret' }),
          userId: clientUserId,
        },
      });

      const [event] = await once(socket, 'authenticated_user');
      assert.equal(event.userId, verifiedUserId);
      assert.notEqual(event.userId, clientUserId);
      assert.equal(socket.connected, true);
      socket.disconnect();
    } finally {
      await closeServer(httpServer);
    }
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});

test('authentication failures do not leak JWT secrets or stack traces', async () => {
  const originalSecret = process.env.JWT_SECRET;

  try {
    process.env.JWT_SECRET = 'socket-auth-test-secret';
    const { httpServer, url } = await createSocketTestServer();
    try {
      const socket = io(url, {
        transports: ['websocket'],
        forceNew: true,
        auth: { token: 'invalid.token.signature' },
      });

      const error = await Promise.race([
        once(socket, 'connect_error').then(([event]) => event),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 2000)),
      ]);

      assert.notEqual(error, 'timeout');
      assert.equal(error.message, 'Authentication required');
      assert.equal(String(error).includes('JsonWebTokenError'), false);
      assert.equal(String(error).includes('secret'), false);
      assert.equal(String(error).includes('stack'), false);
      assert.equal(String(error).includes('password'), false);
    } finally {
      await closeServer(httpServer);
    }
  } finally {
    if (originalSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = originalSecret;
    }
  }
});
