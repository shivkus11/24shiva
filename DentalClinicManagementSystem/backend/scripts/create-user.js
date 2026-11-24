require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

(async () => {
  const email = (arg('email') || '').trim().toLowerCase();
  const password = arg('password') || '';
  const role = (arg('role') || 'admin').trim().toLowerCase();
  const name = (arg('name') || 'Clinic Staff').trim();
  if (!email || !password || password.length < 10 || !['admin', 'doctor', 'staff'].includes(role)) {
    console.error('Usage: npm run create-user -- --email admin@example.com --password "LongPassword123!" --role admin --name "Clinic Admin"');
    process.exitCode = 1;
    await db.pool.end();
    return;
  }
  try {
    const hash = await bcrypt.hash(password, 12);
    const result = await db.query(
      'INSERT INTO users(email,password_hash,role) VALUES($1,$2,$3) RETURNING id,email,role',
      [email, hash, role]
    );
    if (role === 'doctor') {
      await db.query('INSERT INTO doctors(user_id,full_name) VALUES($1,$2)', [result.rows[0].id, name]);
    }
    console.log('Created:', result.rows[0]);
  } catch (err) {
    console.error('Could not create user:', err.message);
    process.exitCode = 1;
  } finally {
    await db.pool.end();
  }
})();
