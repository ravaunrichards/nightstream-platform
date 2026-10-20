'use strict';
require('dotenv').config();
const { Pool } = require('pg');

(async () => {
  const email = process.argv[2];
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    console.error('Usage: npm run promote-moderator -- registered-email@example.com');
    process.exitCode = 2;
    return;
  }
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const result = await pool.query(
      "UPDATE users SET role = 'moderator', updated_at = NOW() WHERE LOWER(email) = LOWER($1) RETURNING email, role",
      [email]
    );
    if (!result.rowCount) {
      console.error('No registered account found for that email.');
      process.exitCode = 1;
    } else {
      console.log(`Moderator role assigned to ${result.rows[0].email}.`);
    }
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
