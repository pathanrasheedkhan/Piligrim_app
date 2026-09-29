const assert = require('node:assert/strict');
const { once } = require('node:events');
const test = require('node:test');

const pool = require('../db/pool');
const database = require('../db/database');
const { app } = require('../server');

test('query uses the existing PostgreSQL pool', async () => {
  const originalQuery = pool.query;
  let received;
  pool.query = async (...args) => {
    received = args;
    return { rows: [{ value: 7 }] };
  };

  try {
    const result = await database.query('SELECT $1 AS value', [7]);
    assert.deepEqual(received, ['SELECT $1 AS value', [7]]);
    assert.deepEqual(result.rows, [{ value: 7 }]);
  } finally {
    pool.query = originalQuery;
  }
});

test('health check executes SELECT NOW() through the existing pool', async () => {
  const originalQuery = pool.query;
  let received;
  const currentTime = new Date('2026-09-27T12:00:00.000Z');
  pool.query = async (statement) => {
    received = statement;
    return { rows: [{ now: currentTime }] };
  };

  try {
    assert.equal(await database.healthCheck(), currentTime);
    assert.equal(received, 'SELECT NOW()');
  } finally {
    pool.query = originalQuery;
  }
});

test('transaction commits and releases its pooled client', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  let released = false;
  pool.connect = async () => ({
    query: async (statement) => {
      statements.push(statement);
      return { rows: [] };
    },
    release: () => { released = true; },
  });

  try {
    const value = await database.withTransaction(async (client) => {
      await client.query('SELECT 1');
      return 'done';
    });
    assert.equal(value, 'done');
    assert.deepEqual(statements, ['BEGIN', 'SELECT 1', 'COMMIT']);
    assert.equal(released, true);
  } finally {
    pool.connect = originalConnect;
  }
});

test('transaction rolls back and releases its client after an error', async () => {
  const originalConnect = pool.connect;
  const statements = [];
  let released = false;
  pool.connect = async () => ({
    query: async (statement) => {
      statements.push(statement);
      return { rows: [] };
    },
    release: () => { released = true; },
  });

  try {
    await assert.rejects(
      database.withTransaction(async () => { throw new Error('transaction failed'); }),
      { message: 'transaction failed' },
    );
    assert.deepEqual(statements, ['BEGIN', 'ROLLBACK']);
    assert.equal(released, true);
  } finally {
    pool.connect = originalConnect;
  }
});

test('database health endpoint reports reachable and unavailable states', async () => {
  const originalHealthCheck = database.healthCheck;
  const server = app.listen(0);
  await once(server, 'listening');
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/health/db`;

  try {
    database.healthCheck = async () => new Date('2026-09-27T12:00:00.000Z');
    const healthyResponse = await fetch(endpoint);
    assert.equal(healthyResponse.status, 200);
    assert.deepEqual(await healthyResponse.json(), {
      status: 'ok',
      database: 'reachable',
      currentTime: '2026-09-27T12:00:00.000Z',
    });

    database.healthCheck = async () => { throw new Error('connection refused'); };
    const unavailableResponse = await fetch(endpoint);
    assert.equal(unavailableResponse.status, 503);
    assert.deepEqual(await unavailableResponse.json(), {
      status: 'error',
      database: 'unavailable',
      message: 'Database unavailable',
    });
  } finally {
    database.healthCheck = originalHealthCheck;
    server.close();
    await once(server, 'close');
  }
});