const pool = require('../db/pool');

async function checkDatabaseConnection() {
  try {
    const result = await pool.query('SELECT NOW() AS current_time');
    console.log(`PostgreSQL connection successful: ${result.rows[0].current_time}`);
  } catch (error) {
    console.error(`PostgreSQL connection failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

checkDatabaseConnection();