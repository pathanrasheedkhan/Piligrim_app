const fs = require('node:fs');
const path = require('node:path');
const pool = require('../db/pool');

async function migrate() {
  const migrationDir = path.join(__dirname, '../db/migrations');
  const migrationFiles = fs.readdirSync(migrationDir)
    .filter((fileName) => fileName.endsWith('.sql'))
    .sort();

  if (migrationFiles.length === 0) {
    console.log('No PostgreSQL migrations found.');
    return;
  }

  const client = await pool.connect();

  try {
    for (const fileName of migrationFiles) {
      const migrationPath = path.join(migrationDir, fileName);
      const migrationSql = fs.readFileSync(migrationPath, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(migrationSql);
        await client.query('COMMIT');
        console.log(`Applied migration: ${fileName}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(`PostgreSQL schema migration failed: ${error.message}`);
  process.exitCode = 1;
});