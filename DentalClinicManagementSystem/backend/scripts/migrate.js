require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '../migrations/001_initial.sql'), 'utf8');
  try {
    await db.query(sql);
    console.log('Database schema is ready.');
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
