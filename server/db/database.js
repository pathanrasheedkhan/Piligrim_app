const pool = require('./pool');

pool.on('error', () => {
  console.error('Unexpected PostgreSQL pool error.');
});

function query(text, params) {
  return params === undefined ? pool.query(text) : pool.query(text, params);
}

async function withTransaction(callback) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        error.rollbackError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function healthCheck() {
  const result = await query('SELECT NOW()');
  return result.rows[0].now;
}

module.exports = { query, withTransaction, healthCheck };