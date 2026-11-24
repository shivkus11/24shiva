require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const db = require('./db');
const { signToken, authenticate, allowRoles, canAccessPatient } = require('./auth');
const r2 = require('./r2');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  throw new Error('Set JWT_SECRET to a random value of at least 32 characters.');
}

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
const STAFF = ['admin', 'staff', 'doctor'];
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const clean = (value, max = 5000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const isUuid = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
const allowedMime = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);

const configuredOrigins = (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const allowedOrigins = configuredOrigins.length ? configuredOrigins :
  (process.env.NODE_ENV === 'production' ? [process.env.RENDER_EXTERNAL_URL].filter(Boolean) : [`http://localhost:${PORT}`]);
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Origin is not allowed by CORS.'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }));

async function audit(userId, action, entityType, entityId, details = {}) {
  try {
    await db.query(
      'INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5)',
      [userId || null, action, entityType, entityId ? String(entityId) : null, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('Audit log write failed:', err.message);
  }
}

async function requirePatientAccess(req, res, patientId) {
  if (!isUuid(patientId)) {
    res.status(400).json({ error: 'Invalid patient ID.' });
    return false;
  }
  const allowed = await canAccessPatient(req.user, patientId);
  if (!allowed) {
    res.status(403).json({ error: 'You can only access your own patient record.' });
    return false;
  }
  const exists = await db.query('SELECT id FROM patients WHERE id = $1', [patientId]);
  if (!exists.rowCount) {
    res.status(404).json({ error: 'Patient not found.' });
    return false;
  }
  return true;
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ status: 'ok', database: 'connected', fileStorageConfigured: r2.isConfigured() });
}));

app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const name = clean(req.body.name, 160);
  const email = clean(req.body.email, 255).toLowerCase();
  const password = String(req.body.password || '');
  const phone = clean(req.body.phone, 30);
  if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || phone.replace(/\D/g, '').length < 8) {
    return res.status(400).json({ error: 'Enter a name, valid email, phone number and password with at least 10 characters.' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Link to an existing clinic-created patient record only when email AND phone match.
    // This avoids creating a duplicate profile when a registered clinic patient signs up online.
    const existingPatients = await client.query(
      `SELECT id,user_id,phone FROM patients WHERE LOWER(email)=LOWER($1) ORDER BY created_at ASC FOR UPDATE`,
      [email]
    );
    const phoneDigits = phone.replace(/\D/g, '');
    const matchingPatient = existingPatients.rows.find((row) =>
      !row.user_id && row.phone && row.phone.replace(/\D/g, '') === phoneDigits
    );
    if (existingPatients.rows.some((row) => !row.user_id) && !matchingPatient) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'A clinic record uses this email, but the phone number did not match. Please contact clinic staff to link your account.' });
    }

    const hash = await bcrypt.hash(password, 12);
    const userResult = await client.query(
      "INSERT INTO users(email,password_hash,role) VALUES($1,$2,'patient') RETURNING id,email,role",
      [email, hash]
    );

    let patient;
    if (matchingPatient) {
      const linked = await client.query(
        `UPDATE patients SET user_id=$1,updated_at=NOW()
         WHERE id=$2 AND user_id IS NULL
         RETURNING id,patient_code,full_name,phone,email`,
        [userResult.rows[0].id, matchingPatient.id]
      );
      if (!linked.rowCount) throw new Error('The clinic patient record was linked by another account. Please sign in or contact the clinic.');
      patient = linked.rows[0];
    } else {
      const code = `SGD-${new Date().getFullYear().toString().slice(-2)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const patientResult = await client.query(
        `INSERT INTO patients(user_id,patient_code,full_name,phone,email)
         VALUES($1,$2,$3,$4,$5) RETURNING id,patient_code,full_name,phone,email`,
        [userResult.rows[0].id, code, name, phone || null, email]
      );
      patient = patientResult.rows[0];
    }

    await client.query('COMMIT');
    const user = { ...userResult.rows[0], patient_id: patient.id };
    await audit(user.id, 'register', 'patient', patient.id, { linkedExistingRecord: Boolean(matchingPatient) });
    res.status(201).json({ token: signToken(user), user, patient });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') return res.status(409).json({ error: 'This email is already registered. Please sign in instead.' });
    throw err;
  } finally {
    client.release();
  }
}));

app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = clean(req.body.email, 255).toLowerCase();
  const password = String(req.body.password || '');
  const result = await db.query(
    `SELECT u.id,u.email,u.password_hash,u.role,u.is_active,p.id AS patient_id
     FROM users u LEFT JOIN patients p ON p.user_id = u.id WHERE u.email = $1`, [email]
  );
  const user = result.rows[0];
  if (!user || !user.is_active || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  delete user.password_hash;
  await audit(user.id, 'login', 'user', user.id);
  res.json({ token: signToken(user), user });
}));

app.get('/api/me', authenticate, asyncRoute(async (req, res) => {
  let profile = null;
  if (req.user.role === 'patient' && req.user.patient_id) {
    const result = await db.query('SELECT * FROM patients WHERE id=$1', [req.user.patient_id]);
    profile = result.rows[0] || null;
  }
  res.json({ user: req.user, profile });
}));

app.get('/api/dashboard/summary', authenticate, allowRoles(...STAFF), asyncRoute(async (_req, res) => {
  const [patients, today, pending, openFollowups] = await Promise.all([
    db.query('SELECT COUNT(*)::int AS count FROM patients'),
    db.query("SELECT COUNT(*)::int AS count FROM appointments WHERE appointment_at::date = CURRENT_DATE"),
    db.query("SELECT COUNT(*)::int AS count FROM appointments WHERE status = 'pending'"),
    db.query("SELECT COUNT(*)::int AS count FROM follow_ups WHERE status = 'open' AND due_at::date <= CURRENT_DATE")
  ]);
  res.json({
    patientCount: patients.rows[0].count,
    appointmentsToday: today.rows[0].count,
    pendingAppointments: pending.rows[0].count,
    dueFollowUps: openFollowups.rows[0].count
  });
}));

app.get('/api/patients', authenticate, allowRoles(...STAFF), asyncRoute(async (req, res) => {
  const search = `%${clean(req.query.search, 100)}%`;
  const result = await db.query(
    `SELECT id,patient_code,full_name,date_of_birth,gender,phone,email,created_at
     FROM patients WHERE full_name ILIKE $1 OR patient_code ILIKE $1 OR phone ILIKE $1
     ORDER BY created_at DESC LIMIT 200`, [search]
  );
  res.json({ patients: result.rows });
}));

app.post('/api/patients', authenticate, allowRoles('admin', 'staff'), asyncRoute(async (req, res) => {
  const name = clean(req.body.fullName, 160);
  const phone = clean(req.body.phone, 30);
  const email = clean(req.body.email, 255).toLowerCase();
  if (name.length < 2) return res.status(400).json({ error: 'Patient name is required.' });
  const code = `SGD-${new Date().getFullYear().toString().slice(-2)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const result = await db.query(
    `INSERT INTO patients(patient_code,full_name,date_of_birth,gender,phone,email,address)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     RETURNING id,patient_code,full_name,date_of_birth,gender,phone,email,address,created_at`,
    [code, name, req.body.dateOfBirth || null, clean(req.body.gender, 30) || null, phone || null, email || null, clean(req.body.address, 2000) || null]
  );
  await audit(req.user.id, 'create', 'patient', result.rows[0].id);
  res.status(201).json({ patient: result.rows[0] });
}));

app.get('/api/patients/:id', authenticate, asyncRoute(async (req, res) => {
  if (!(await requirePatientAccess(req, res, req.params.id))) return;
  const result = await db.query(
    `SELECT p.*, mh.allergies,mh.conditions,mh.medications,mh.previous_surgeries,mh.notes AS history_notes,mh.updated_at AS history_updated_at
     FROM patients p LEFT JOIN medical_histories mh ON mh.patient_id=p.id WHERE p.id=$1`, [req.params.id]
  );
  res.json({ patient: result.rows[0] });
}));

app.put('/api/patients/:id/history', authenticate, allowRoles('admin', 'staff', 'doctor'), asyncRoute(async (req, res) => {
  const patientId = req.params.id;
  if (!(await requirePatientAccess(req, res, patientId))) return;
  const values = [
    clean(req.body.allergies), clean(req.body.conditions), clean(req.body.medications),
    clean(req.body.previousSurgeries), clean(req.body.notes), req.user.id, patientId
  ];
  const result = await db.query(
    `INSERT INTO medical_histories(allergies,conditions,medications,previous_surgeries,notes,updated_by,patient_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(patient_id) DO UPDATE SET allergies=EXCLUDED.allergies,conditions=EXCLUDED.conditions,
       medications=EXCLUDED.medications,previous_surgeries=EXCLUDED.previous_surgeries,notes=EXCLUDED.notes,
       updated_by=EXCLUDED.updated_by,updated_at=NOW()
     RETURNING *`, values
  );
  await audit(req.user.id, 'update', 'medical_history', result.rows[0].id);
  res.json({ history: result.rows[0] });
}));

app.get('/api/appointments', authenticate, asyncRoute(async (req, res) => {
  let sql = `SELECT a.*,p.patient_code,p.full_name AS patient_name,p.phone,d.full_name AS doctor_name
             FROM appointments a JOIN patients p ON p.id=a.patient_id
             LEFT JOIN doctors d ON d.id=a.doctor_id`;
  const params = [];
  if (req.user.role === 'patient') {
    sql += ' WHERE a.patient_id=$1'; params.push(req.user.patient_id);
  }
  sql += ' ORDER BY a.appointment_at DESC LIMIT 250';
  const result = await db.query(sql, params);
  res.json({ appointments: result.rows });
}));

app.post('/api/appointments', authenticate, asyncRoute(async (req, res) => {
  const patientId = req.user.role === 'patient' ? req.user.patient_id : req.body.patientId;
  if (!patientId || !(await requirePatientAccess(req, res, patientId))) return;
  const at = new Date(req.body.appointmentAt);
  if (Number.isNaN(at.getTime())) return res.status(400).json({ error: 'Select a valid appointment date and time.' });
  const result = await db.query(
    `INSERT INTO appointments(patient_id,appointment_at,reason,status)
     VALUES($1,$2,$3,'pending') RETURNING *`,
    [patientId, at.toISOString(), clean(req.body.reason, 1000) || null]
  );
  await audit(req.user.id, 'create', 'appointment', result.rows[0].id);
  res.status(201).json({ appointment: result.rows[0] });
}));

app.patch('/api/appointments/:id/status', authenticate, allowRoles(...STAFF), asyncRoute(async (req, res) => {
  const status = clean(req.body.status, 20).toLowerCase();
  if (!['pending', 'confirmed', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: 'Invalid appointment status.' });
  }
  const result = await db.query(
    'UPDATE appointments SET status=$1,staff_notes=$2,updated_at=NOW() WHERE id=$3 RETURNING *',
    [status, clean(req.body.staffNotes, 1000) || null, req.params.id]
  );
  if (!result.rowCount) return res.status(404).json({ error: 'Appointment not found.' });
  await audit(req.user.id, 'update_status', 'appointment', req.params.id, { status });
  res.json({ appointment: result.rows[0] });
}));

app.get('/api/patients/:id/treatments', authenticate, asyncRoute(async (req, res) => {
  if (!(await requirePatientAccess(req, res, req.params.id))) return;
  const result = await db.query(
    `SELECT t.*,d.full_name AS doctor_name FROM treatments t LEFT JOIN doctors d ON d.id=t.doctor_id
     WHERE t.patient_id=$1 ORDER BY t.created_at DESC`, [req.params.id]
  );
  res.json({ treatments: result.rows });
}));

app.post('/api/treatments', authenticate, allowRoles('admin', 'doctor', 'staff'), asyncRoute(async (req, res) => {
  const patientId = req.body.patientId;
  if (!(await requirePatientAccess(req, res, patientId))) return;
  const procedure = clean(req.body.procedureName, 180);
  const charges = Number(req.body.charges || 0);
  if (!procedure || !Number.isFinite(charges) || charges < 0) return res.status(400).json({ error: 'Enter a procedure and valid charge.' });
  const doctorResult = await db.query('SELECT id FROM doctors WHERE user_id=$1', [req.user.id]);
  const doctorId = doctorResult.rows[0]?.id || null;
  const result = await db.query(
    `INSERT INTO treatments(patient_id,doctor_id,appointment_id,tooth_number,procedure_name,diagnosis,treatment_notes,charges)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [patientId, doctorId, isUuid(req.body.appointmentId) ? req.body.appointmentId : null,
      clean(req.body.toothNumber, 12) || null, procedure, clean(req.body.diagnosis) || null,
      clean(req.body.treatmentNotes) || null, charges]
  );
  await audit(req.user.id, 'create', 'treatment', result.rows[0].id);
  res.status(201).json({ treatment: result.rows[0] });
}));

app.get('/api/patients/:id/files', authenticate, asyncRoute(async (req, res) => {
  if (!(await requirePatientAccess(req, res, req.params.id))) return;
  const result = await db.query(
    `SELECT id,patient_id,treatment_id,file_name,content_type,category,file_size,created_at
     FROM dental_files WHERE patient_id=$1 ORDER BY created_at DESC`, [req.params.id]
  );
  res.json({ files: result.rows });
}));

app.post('/api/files/presign', authenticate, asyncRoute(async (req, res) => {
  const patientId = req.user.role === 'patient' ? req.user.patient_id : req.body.patientId;
  if (!(await requirePatientAccess(req, res, patientId))) return;
  if (!r2.isConfigured()) return res.status(503).json({ error: 'Cloudflare R2 is not configured on the server yet.' });
  const category = clean(req.body.category, 20).toLowerCase();
  const contentType = clean(req.body.contentType, 120).toLowerCase();
  const fileName = path.basename(clean(req.body.fileName, 255) || 'upload');
  if (!['xray', 'photo', 'document'].includes(category) || !allowedMime.has(contentType)) {
    return res.status(400).json({ error: 'Choose X-ray, photo or document and use JPG, PNG, WEBP or PDF.' });
  }
  const objectKey = `patients/${patientId}/${category}/${crypto.randomUUID()}`;
  const uploadUrl = await r2.createUploadUrl({ key: objectKey, contentType });
  res.json({ uploadUrl, objectKey, fileName, expiresIn: Math.min(Number(process.env.R2_PRESIGN_SECONDS || 300), 900) });
}));

app.post('/api/files/complete', authenticate, asyncRoute(async (req, res) => {
  const patientId = req.user.role === 'patient' ? req.user.patient_id : req.body.patientId;
  if (!(await requirePatientAccess(req, res, patientId))) return;
  const objectKey = clean(req.body.objectKey, 1000);
  const category = clean(req.body.category, 20).toLowerCase();
  const fileName = path.basename(clean(req.body.fileName, 255) || 'upload');
  if (!objectKey.startsWith(`patients/${patientId}/`) || !['xray', 'photo', 'document'].includes(category)) {
    return res.status(400).json({ error: 'Invalid uploaded file reference.' });
  }
  const info = await r2.getObjectInfo(objectKey);
  const fileSize = Number(info.ContentLength || 0);
  const contentType = String(info.ContentType || 'application/octet-stream').toLowerCase();
  if (!allowedMime.has(contentType) || fileSize < 1 || fileSize > MAX_UPLOAD_BYTES) {
    return res.status(400).json({ error: 'File type or size is not allowed. Maximum size is 25 MB.' });
  }
  const result = await db.query(
    `INSERT INTO dental_files(patient_id,uploaded_by,file_name,content_type,category,object_key,file_size)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     RETURNING id,patient_id,file_name,content_type,category,file_size,created_at`,
    [patientId, req.user.id, fileName, contentType, category, objectKey, fileSize]
  );
  await audit(req.user.id, 'upload', 'dental_file', result.rows[0].id, { category });
  res.status(201).json({ file: result.rows[0] });
}));

app.get('/api/files/:id/download', authenticate, asyncRoute(async (req, res) => {
  const result = await db.query('SELECT * FROM dental_files WHERE id=$1', [req.params.id]);
  const file = result.rows[0];
  if (!file) return res.status(404).json({ error: 'File not found.' });
  if (!(await canAccessPatient(req.user, file.patient_id))) return res.status(403).json({ error: 'You cannot access this file.' });
  const url = await r2.createDownloadUrl(file.object_key);
  res.json({ url, expiresIn: 300 });
}));

app.get('/api/patients/:id/payments', authenticate, asyncRoute(async (req, res) => {
  if (!(await requirePatientAccess(req, res, req.params.id))) return;
  const result = await db.query('SELECT * FROM payments WHERE patient_id=$1 ORDER BY created_at DESC', [req.params.id]);
  res.json({ payments: result.rows });
}));

app.post('/api/payments', authenticate, allowRoles('admin', 'staff'), asyncRoute(async (req, res) => {
  const patientId = req.body.patientId;
  if (!(await requirePatientAccess(req, res, patientId))) return;
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'Enter a valid payment amount.' });
  const result = await db.query(
    `INSERT INTO payments(patient_id,treatment_id,amount,status,payment_method,reference_note,paid_at)
     VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $4='paid' THEN NOW() ELSE NULL END) RETURNING *`,
    [patientId, isUuid(req.body.treatmentId) ? req.body.treatmentId : null, amount,
      ['pending','paid','partial','refunded'].includes(req.body.status) ? req.body.status : 'pending',
      clean(req.body.paymentMethod, 40) || null, clean(req.body.referenceNote) || null]
  );
  await audit(req.user.id, 'create', 'payment', result.rows[0].id);
  res.status(201).json({ payment: result.rows[0] });
}));

app.get('/api/patients/:id/consents', authenticate, asyncRoute(async (req, res) => {
  if (!(await requirePatientAccess(req, res, req.params.id))) return;
  const result = await db.query('SELECT * FROM consents WHERE patient_id=$1 ORDER BY created_at DESC', [req.params.id]);
  res.json({ consents: result.rows });
}));

app.post('/api/consents', authenticate, allowRoles('admin', 'doctor', 'staff'), asyncRoute(async (req, res) => {
  const patientId = req.body.patientId;
  if (!(await requirePatientAccess(req, res, patientId))) return;
  const text = clean(req.body.consentText, 10000);
  if (!text) return res.status(400).json({ error: 'Consent text is required.' });
  const result = await db.query(
    'INSERT INTO consents(patient_id,treatment_id,consent_text) VALUES($1,$2,$3) RETURNING *',
    [patientId, isUuid(req.body.treatmentId) ? req.body.treatmentId : null, text]
  );
  await audit(req.user.id, 'create', 'consent', result.rows[0].id);
  res.status(201).json({ consent: result.rows[0] });
}));

app.patch('/api/consents/:id/acknowledge', authenticate, asyncRoute(async (req, res) => {
  const status = clean(req.body.status, 20).toLowerCase();
  if (!['accepted', 'rejected'].includes(status)) return res.status(400).json({ error: 'Choose accepted or rejected.' });
  const consentResult = await db.query('SELECT * FROM consents WHERE id=$1', [req.params.id]);
  const consent = consentResult.rows[0];
  if (!consent) return res.status(404).json({ error: 'Consent not found.' });
  if (req.user.role !== 'patient' || req.user.patient_id !== consent.patient_id) {
    return res.status(403).json({ error: 'Only the linked patient account can acknowledge this consent.' });
  }
  const result = await db.query(
    'UPDATE consents SET status=$1,acknowledged_by=$2,acknowledged_at=NOW() WHERE id=$3 RETURNING *',
    [status, req.user.id, req.params.id]
  );
  await audit(req.user.id, 'acknowledge', 'consent', req.params.id, { status });
  res.json({ consent: result.rows[0] });
}));

app.get('/api/patients/:id/follow-ups', authenticate, asyncRoute(async (req, res) => {
  if (!(await requirePatientAccess(req, res, req.params.id))) return;
  const result = await db.query('SELECT * FROM follow_ups WHERE patient_id=$1 ORDER BY due_at DESC', [req.params.id]);
  res.json({ followUps: result.rows });
}));

app.post('/api/follow-ups', authenticate, allowRoles('admin', 'doctor', 'staff'), asyncRoute(async (req, res) => {
  const patientId = req.body.patientId;
  if (!(await requirePatientAccess(req, res, patientId))) return;
  const dueAt = new Date(req.body.dueAt);
  if (Number.isNaN(dueAt.getTime())) return res.status(400).json({ error: 'Enter a valid follow-up date.' });
  const result = await db.query(
    'INSERT INTO follow_ups(patient_id,due_at,notes,created_by) VALUES($1,$2,$3,$4) RETURNING *',
    [patientId, dueAt.toISOString(), clean(req.body.notes) || null, req.user.id]
  );
  await audit(req.user.id, 'create', 'follow_up', result.rows[0].id);
  res.status(201).json({ followUp: result.rows[0] });
}));

app.get('/api/patients/:id/dental-chart', authenticate, asyncRoute(async (req, res) => {
  if (!(await requirePatientAccess(req, res, req.params.id))) return;
  const result = await db.query('SELECT * FROM dental_charts WHERE patient_id=$1', [req.params.id]);
  res.json({ chart: result.rows[0] || { chart_data: {} } });
}));

app.put('/api/patients/:id/dental-chart', authenticate, allowRoles('admin', 'doctor', 'staff'), asyncRoute(async (req, res) => {
  const patientId = req.params.id;
  if (!(await requirePatientAccess(req, res, patientId))) return;
  const chartData = req.body.chartData && typeof req.body.chartData === 'object' ? req.body.chartData : {};
  const result = await db.query(
    `INSERT INTO dental_charts(patient_id,chart_data,updated_by) VALUES($1,$2,$3)
     ON CONFLICT(patient_id) DO UPDATE SET chart_data=EXCLUDED.chart_data,updated_by=EXCLUDED.updated_by,updated_at=NOW()
     RETURNING *`, [patientId, JSON.stringify(chartData), req.user.id]
  );
  await audit(req.user.id, 'update', 'dental_chart', result.rows[0].id);
  res.json({ chart: result.rows[0] });
}));

app.get('/api/audit-logs', authenticate, allowRoles('admin'), asyncRoute(async (_req, res) => {
  const result = await db.query(
    `SELECT a.id,a.action,a.entity_type,a.entity_id,a.details,a.created_at,u.email AS actor_email
     FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC LIMIT 200`
  );
  res.json({ logs: result.rows });
}));

const webRoot = path.resolve(__dirname, '../../web');
app.use(express.static(webRoot));
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(webRoot, 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err.stack || err.message || err);
  if (res.headersSent) return;
  const status = err.status || 500;
  res.status(status).json({ error: status >= 500 ? 'Server error. Check the server logs.' : err.message });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Dental Clinic API and web portal listening on port ${PORT}`);
});

async function shutdown() {
  server.close(async () => {
    await db.pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
