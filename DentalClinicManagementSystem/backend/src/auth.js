const jwt = require('jsonwebtoken');
const db = require('./db');

function signToken(user) {
  return jwt.sign(
    { role: user.role, patientId: user.patient_id || null },
    process.env.JWT_SECRET,
    { subject: user.id, expiresIn: process.env.JWT_EXPIRES_IN || '12h', issuer: 'dental-clinic-api' }
  );
}

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Please sign in.' });
    const payload = jwt.verify(token, process.env.JWT_SECRET, { issuer: 'dental-clinic-api' });
    const result = await db.query(
      `SELECT u.id, u.email, u.role, u.is_active, p.id AS patient_id
       FROM users u LEFT JOIN patients p ON p.user_id = u.id WHERE u.id = $1`,
      [payload.sub]
    );
    const user = result.rows[0];
    if (!user || !user.is_active) return res.status(401).json({ error: 'This account is unavailable.' });
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Your session is invalid or expired. Please sign in again.' });
  }
}

function allowRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission for this action.' });
    }
    next();
  };
}

async function canAccessPatient(user, patientId) {
  if (['admin', 'staff', 'doctor'].includes(user.role)) return true;
  return user.role === 'patient' && user.patient_id === patientId;
}

module.exports = { signToken, authenticate, allowRoles, canAccessPatient };
