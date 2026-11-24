const API = '';
let token = sessionStorage.getItem('clinicToken') || '';
let currentPatientId = '';
const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${API}/api${path}`, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function showSignedIn(user) {
  if (window.location.search.includes('register=1')) window.history.replaceState({}, '', '/');
  $('#login-view').classList.add('hidden');
  $('#account-area').classList.remove('hidden');
  $('#account-label').textContent = `${user.email} · ${user.role}`;
  $('#patient-register-shortcut').classList.toggle('hidden', user.role === 'patient');
  if (user.role === 'patient') {
    $('#app-view').classList.add('hidden');
    $('#patient-app-view').classList.remove('hidden');
    loadPatientPortal(user);
    return;
  }
  $('#patient-app-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  loadDashboard();
  loadPatients();
  loadAppointments();
}

function showSignedOut() {
  token = '';
  currentPatientId = '';
  sessionStorage.removeItem('clinicToken');
  $('#login-view').classList.remove('hidden');
  $('#app-view').classList.add('hidden');
  $('#patient-app-view').classList.add('hidden');
  $('#account-area').classList.add('hidden');
  $('#patient-detail').classList.add('hidden');
  $('#login-error').textContent = '';
  $('#register-error').textContent = '';
  $('#register-panel').classList.add('hidden');
  $('#show-register').classList.remove('hidden');
}

async function loadDashboard() {
  try {
    const data = await api('/dashboard/summary');
    $('#stat-patients').textContent = data.patientCount;
    $('#stat-today').textContent = data.appointmentsToday;
    $('#stat-pending').textContent = data.pendingAppointments;
    $('#stat-followups').textContent = data.dueFollowUps;
  } catch (err) { showNotice(err.message); }
}

async function loadPatients() {
  const search = encodeURIComponent($('#patient-search').value.trim());
  try {
    const data = await api(`/patients?search=${search}`);
    const body = $('#patients-body');
    if (!data.patients.length) { body.innerHTML = '<tr><td colspan="5">No patients found.</td></tr>'; return; }
    body.innerHTML = data.patients.map((p) => `<tr>
      <td>${esc(p.patient_code)}</td><td>${esc(p.full_name)}</td><td>${esc(p.phone || '-')}</td><td>${esc(p.email || '-')}</td>
      <td><button class="link-button" data-open-patient="${esc(p.id)}">Open record</button></td></tr>`).join('');
  } catch (err) { $('#patients-body').innerHTML = `<tr><td colspan="5">${esc(err.message)}</td></tr>`; }
}

async function loadAppointments() {
  try {
    const data = await api('/appointments');
    const body = $('#appointments-body');
    if (!data.appointments.length) { body.innerHTML = '<tr><td colspan="5">No appointments found.</td></tr>'; return; }
    body.innerHTML = data.appointments.map((a) => `<tr>
      <td>${esc(new Date(a.appointment_at).toLocaleString())}</td>
      <td>${esc(a.patient_name)}<div class="muted small">${esc(a.patient_code)}</div></td>
      <td>${esc(a.reason || '-')}</td><td>${esc(a.status)}</td>
      <td><select data-appointment-status="${esc(a.id)}" aria-label="Appointment status">
        ${['pending','confirmed','completed','cancelled'].map((s) => `<option value="${s}" ${a.status === s ? 'selected' : ''}>${s}</option>`).join('')}
      </select></td></tr>`).join('');
  } catch (err) { $('#appointments-body').innerHTML = `<tr><td colspan="5">${esc(err.message)}</td></tr>`; }
}

async function openPatient(id) {
  currentPatientId = id;
  $('#patient-detail').classList.remove('hidden');
  $('#detail-message').textContent = 'Loading patient record...';
  try {
    const [patientData, treatments, files, payments, consents, followups, chart] = await Promise.all([
      api(`/patients/${id}`), api(`/patients/${id}/treatments`), api(`/patients/${id}/files`), api(`/patients/${id}/payments`),
      api(`/patients/${id}/consents`), api(`/patients/${id}/follow-ups`), api(`/patients/${id}/dental-chart`)
    ]);
    const p = patientData.patient;
    $('#detail-name').textContent = p.full_name;
    $('#detail-meta').textContent = `${p.patient_code} · ${p.phone || 'No phone'} · ${p.email || 'No email'}`;
    const form = $('#history-form');
    ['allergies','conditions','medications','previousSurgeries','notes'].forEach((key) => {
      const dbKey = key === 'previousSurgeries' ? 'previous_surgeries' : (key === 'notes' ? 'history_notes' : key);
      form.elements[key].value = p[dbKey] || '';
    });
    $('#treatments-list').innerHTML = treatments.treatments.length ? treatments.treatments.map((t) =>
      `<div class="record-item"><span><strong>${esc(t.procedure_name)}</strong> · Tooth ${esc(t.tooth_number || '-')}<br><span class="muted small">${esc(t.diagnosis || t.treatment_notes || '')}</span></span><strong>₹${Number(t.charges).toFixed(2)}</strong></div>`
    ).join('') : '<p class="muted">No treatment entries.</p>';
    $('#files-list').innerHTML = files.files.length ? files.files.map((f) =>
      `<div class="record-item"><span>${esc(f.file_name)} <span class="muted small">(${esc(f.category)} · ${(Number(f.file_size)/1024/1024).toFixed(2)} MB)</span></span><button class="link-button" data-download-file="${esc(f.id)}">View</button></div>`
    ).join('') : '<p class="muted">No uploaded files.</p>';
    $('#payments-list').innerHTML = payments.payments.length ? payments.payments.map((pmt) =>
      `<div class="record-item"><span>${esc(pmt.status)} · ${esc(pmt.payment_method || 'Not specified')}</span><strong>₹${Number(pmt.amount).toFixed(2)}</strong></div>`
    ).join('') : '<p class="muted">No payment entries.</p>';
    $('#consents-list').innerHTML = consents.consents.length ? consents.consents.map((item) =>
      `<div class="record-item"><span>${esc(item.consent_text)}<br><span class="muted small">Status: ${esc(item.status)}</span></span></div>`
    ).join('') : '<p class="muted">No consent forms.</p>';
    $('#followups-list').innerHTML = followups.followUps.length ? followups.followUps.map((item) =>
      `<div class="record-item"><span>${esc(new Date(item.due_at).toLocaleString())}<br><span class="muted small">${esc(item.notes || '')}</span></span><strong>${esc(item.status)}</strong></div>`
    ).join('') : '<p class="muted">No follow-ups.</p>';
    $('#chart-json').value = JSON.stringify(chart.chart?.chart_data || {}, null, 2);
    $('#detail-message').textContent = '';
    $('#patient-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) { $('#detail-message').textContent = err.message; $('#detail-message').classList.add('error'); }
}

function showNotice(message, isError = false) {
  const node = $('#detail-message');
  node.textContent = message;
  node.classList.toggle('error', isError);
}

let patientPortalId = '';

function renderPatientInfo(label, value) {
  return `<div class="patient-info-item"><strong>${esc(label)}</strong>${esc(value || 'Not recorded')}</div>`;
}

async function loadPatientPortal(user) {
  patientPortalId = user.patient_id || '';
  try {
    const me = await api('/me');
    if (!patientPortalId && me.profile) patientPortalId = me.profile.id;
    if (!patientPortalId) throw new Error('No patient profile is linked to this account. Contact clinic staff.');
    const id = encodeURIComponent(patientPortalId);
    const [patientData, appointments, treatments, files, payments, consents, followups] = await Promise.all([
      api(`/patients/${id}`), api('/appointments'), api(`/patients/${id}/treatments`), api(`/patients/${id}/files`),
      api(`/patients/${id}/payments`), api(`/patients/${id}/consents`), api(`/patients/${id}/follow-ups`)
    ]);
    const p = patientData.patient;
    $('#patient-welcome-line').textContent = `Welcome, ${p.full_name}. Your appointments and dental records are available here.`;
    $('#patient-code-label').textContent = p.patient_code;
    $('#patient-stat-id').textContent = p.patient_code;
    $('#patient-stat-appointments').textContent = appointments.appointments.length;
    $('#patient-stat-consents').textContent = consents.consents.filter((c) => c.status === 'pending').length;
    $('#patient-stat-files').textContent = files.files.length;

    const history = [
      renderPatientInfo('Name', p.full_name), renderPatientInfo('Date of birth', p.date_of_birth ? new Date(p.date_of_birth).toLocaleDateString() : ''),
      renderPatientInfo('Gender', p.gender), renderPatientInfo('Phone', p.phone), renderPatientInfo('Email', p.email),
      renderPatientInfo('Address', p.address), renderPatientInfo('Allergies', p.allergies), renderPatientInfo('Medical conditions', p.conditions),
      renderPatientInfo('Current medications', p.medications), renderPatientInfo('Previous surgeries', p.previous_surgeries),
      renderPatientInfo('Medical notes', p.history_notes)
    ];
    $('#patient-history').innerHTML = history.join('');

    $('#patient-appointments').innerHTML = appointments.appointments.length ? appointments.appointments.map((a) =>
      `<div class="record-item"><span><strong>${esc(new Date(a.appointment_at).toLocaleString())}</strong><br><span class="muted small">${esc(a.reason || 'No reason provided')}</span></span><strong>${esc(a.status)}</strong></div>`
    ).join('') : '<p class="muted">No appointments yet.</p>';

    $('#patient-treatments').innerHTML = treatments.treatments.length ? treatments.treatments.map((t) =>
      `<div class="record-item"><span><strong>${esc(t.procedure_name)}</strong> · Tooth ${esc(t.tooth_number || '-')}<br><span class="muted small">${esc(t.diagnosis || '')}${t.treatment_notes ? ` · ${esc(t.treatment_notes)}` : ''}<br>${esc(new Date(t.created_at).toLocaleDateString())}</span></span><strong>₹${Number(t.charges).toFixed(2)}</strong></div>`
    ).join('') : '<p class="muted">No treatment records available.</p>';

    $('#patient-files').innerHTML = files.files.length ? files.files.map((f) =>
      `<div class="record-item"><span><strong>${esc(f.file_name)}</strong><br><span class="muted small">${esc(f.category)} · ${(Number(f.file_size) / 1024 / 1024).toFixed(2)} MB · ${esc(new Date(f.created_at).toLocaleDateString())}</span></span><button class="link-button" data-patient-download="${esc(f.id)}">View / download</button></div>`
    ).join('') : '<p class="muted">No files uploaded.</p>';

    $('#patient-payments').innerHTML = payments.payments.length ? payments.payments.map((pmt) =>
      `<div class="record-item"><span>${esc(pmt.payment_method || 'Payment')}<br><span class="muted small">${esc(new Date(pmt.created_at).toLocaleDateString())}</span></span><span><strong>₹${Number(pmt.amount).toFixed(2)}</strong><br><span class="muted small">${esc(pmt.status)}</span></span></div>`
    ).join('') : '<p class="muted">No payment entries available.</p>';

    $('#patient-consents').innerHTML = consents.consents.length ? consents.consents.map((c) =>
      `<div class="record-item consent-record"><span><strong>Consent · ${esc(new Date(c.created_at).toLocaleDateString())}</strong><br>${esc(c.consent_text)}<br><span class="muted small">Status: ${esc(c.status)}</span>${c.status === 'pending' ? `<span class="consent-actions"><button class="button button-primary button-small" data-consent-action="accepted" data-consent-id="${esc(c.id)}">Accept</button><button class="button button-danger button-small" data-consent-action="rejected" data-consent-id="${esc(c.id)}">Reject</button></span>` : ''}</span></div>`
    ).join('') : '<p class="muted">No consent forms available.</p>';

    $('#patient-followups').innerHTML = followups.followUps.length ? followups.followUps.map((f) =>
      `<div class="record-item"><span><strong>${esc(new Date(f.due_at).toLocaleString())}</strong><br><span class="muted small">${esc(f.notes || 'Follow-up visit')}</span></span><strong>${esc(f.status)}</strong></div>`
    ).join('') : '<p class="muted">No follow-up visits scheduled.</p>';
  } catch (err) {
    $('#patient-welcome-line').textContent = err.message;
  }
}

function getUploadMime(file) {
  if (file.type) return file.type;
  const extension = file.name.toLowerCase().split('.').pop();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' })[extension] || '';
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    const data = await api('/auth/login', { method: 'POST', body: JSON.stringify({ email: $('#login-email').value, password: $('#login-password').value }) });
    token = data.token;
    sessionStorage.setItem('clinicToken', token);
    showSignedIn(data.user);
  } catch (err) { $('#login-error').textContent = err.message; }
});

$('#show-register').addEventListener('click', () => {
  $('#register-panel').classList.remove('hidden');
  $('#show-register').classList.add('hidden');
  $('#register-error').textContent = '';
  $('#register-success').textContent = '';
});
$('#show-login').addEventListener('click', () => {
  $('#register-panel').classList.add('hidden');
  $('#show-register').classList.remove('hidden');
  if (window.location.search.includes('register=1')) window.history.replaceState({}, '', '/');
});
$('#register-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  $('#register-error').textContent = '';
  $('#register-success').textContent = '';
  if (values.password !== values.confirmPassword) {
    $('#register-error').textContent = 'Passwords do not match.';
    return;
  }
  delete values.confirmPassword;
  try {
    const data = await api('/auth/register', { method: 'POST', body: JSON.stringify(values) });
    token = data.token;
    sessionStorage.setItem('clinicToken', token);
    showSignedIn(data.user);
  } catch (err) { $('#register-error').textContent = err.message; }
});

$('#logout-button').addEventListener('click', showSignedOut);
$('#patient-register-shortcut').addEventListener('click', () => {
  // Explicitly leave the current staff/patient session before opening patient registration.
  window.location.href = '/?register=1';
});
$('#search-patients').addEventListener('click', loadPatients);
$('#patient-search').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadPatients(); });
$('#show-add-patient').addEventListener('click', () => $('#add-patient-panel').classList.remove('hidden'));
$('#cancel-add-patient').addEventListener('click', () => $('#add-patient-panel').classList.add('hidden'));
$('#add-patient-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    const data = await api('/patients', { method: 'POST', body: JSON.stringify(values) });
    event.currentTarget.reset();
    $('#add-patient-panel').classList.add('hidden');
    await loadPatients();
    await openPatient(data.patient.id);
  } catch (err) { alert(err.message); }
});

document.querySelectorAll('.tab').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b === button));
  document.querySelectorAll('.tab-content').forEach((section) => section.classList.toggle('hidden', section.id !== `${button.dataset.tab}-tab`));
  $('#patient-detail').classList.add('hidden');
  if (button.dataset.tab === 'appointments') loadAppointments();
  if (button.dataset.tab === 'patients') loadPatients();
}));

$('#patients-body').addEventListener('click', (event) => {
  const button = event.target.closest('[data-open-patient]');
  if (button) openPatient(button.dataset.openPatient);
});
$('#appointments-body').addEventListener('change', async (event) => {
  const select = event.target.closest('[data-appointment-status]');
  if (!select) return;
  try {
    await api(`/appointments/${select.dataset.appointmentStatus}/status`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) });
    await loadDashboard();
  } catch (err) { alert(err.message); loadAppointments(); }
});
$('#close-detail').addEventListener('click', () => $('#patient-detail').classList.add('hidden'));

$('#history-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const v = Object.fromEntries(new FormData(event.currentTarget).entries());
  try { await api(`/patients/${currentPatientId}/history`, { method: 'PUT', body: JSON.stringify(v) }); showNotice('Medical history saved.'); }
  catch (err) { showNotice(err.message, true); }
});

$('#treatment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const v = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await api('/treatments', { method: 'POST', body: JSON.stringify({ ...v, patientId: currentPatientId }) });
    event.currentTarget.reset(); event.currentTarget.elements.charges.value = '0';
    await openPatient(currentPatientId); showNotice('Treatment saved.');
  } catch (err) { showNotice(err.message, true); }
});

$('#upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = event.currentTarget.elements.file.files[0];
  const category = event.currentTarget.elements.category.value;
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) return showNotice('File must be 25 MB or smaller.', true);
  try {
    const signed = await api('/files/presign', { method: 'POST', body: JSON.stringify({ patientId: currentPatientId, category, fileName: file.name, contentType: file.type }) });
    const upload = await fetch(signed.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!upload.ok) throw new Error('Upload to R2 failed. Check the bucket CORS settings.');
    await api('/files/complete', { method: 'POST', body: JSON.stringify({ patientId: currentPatientId, category, fileName: file.name, objectKey: signed.objectKey }) });
    event.currentTarget.reset(); await openPatient(currentPatientId); showNotice('File uploaded successfully.');
  } catch (err) { showNotice(err.message, true); }
});

$('#files-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-download-file]');
  if (!button) return;
  try { const data = await api(`/files/${button.dataset.downloadFile}/download`); window.open(data.url, '_blank', 'noopener'); }
  catch (err) { showNotice(err.message, true); }
});

$('#payment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const v = Object.fromEntries(new FormData(event.currentTarget).entries());
  try {
    await api('/payments', { method: 'POST', body: JSON.stringify({ ...v, patientId: currentPatientId }) });
    event.currentTarget.reset(); await openPatient(currentPatientId); showNotice('Payment entry saved.');
  } catch (err) { showNotice(err.message, true); }
});

$('#consent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const consentText = event.currentTarget.elements.consentText.value.trim();
  try {
    await api('/consents', { method: 'POST', body: JSON.stringify({ patientId: currentPatientId, consentText }) });
    event.currentTarget.reset(); await openPatient(currentPatientId); showNotice('Consent form created.');
  } catch (err) { showNotice(err.message, true); }
});

$('#followup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const dueAt = values.dueAt ? new Date(values.dueAt).toISOString() : '';
  try {
    await api('/follow-ups', { method: 'POST', body: JSON.stringify({ ...values, dueAt, patientId: currentPatientId }) });
    event.currentTarget.reset(); await openPatient(currentPatientId); showNotice('Follow-up saved.');
  } catch (err) { showNotice(err.message, true); }
});

$('#save-chart').addEventListener('click', async () => {
  let chartData;
  try { chartData = JSON.parse($('#chart-json').value || '{}'); }
  catch { return showNotice('Dental chart must contain valid JSON.', true); }
  try {
    await api(`/patients/${currentPatientId}/dental-chart`, { method: 'PUT', body: JSON.stringify({ chartData }) });
    showNotice('Dental chart saved.');
  } catch (err) { showNotice(err.message, true); }
});

$('#patient-appointment-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  const appointmentAt = new Date(values.appointmentAt);
  if (Number.isNaN(appointmentAt.getTime())) {
    $('#patient-appointment-message').textContent = 'Choose a valid date and time.';
    return;
  }
  try {
    await api('/appointments', { method: 'POST', body: JSON.stringify({ appointmentAt: appointmentAt.toISOString(), reason: values.reason }) });
    event.currentTarget.reset();
    $('#patient-appointment-message').textContent = 'Appointment request sent. The clinic will confirm it.';
    const me = await api('/me');
    await loadPatientPortal({ patient_id: patientPortalId || me.profile?.id });
  } catch (err) { $('#patient-appointment-message').textContent = err.message; }
});

$('#patient-upload-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = event.currentTarget.elements.file.files[0];
  const category = event.currentTarget.elements.category.value;
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    $('#patient-upload-message').textContent = 'File must be 25 MB or smaller.';
    return;
  }
  const contentType = getUploadMime(file);
  if (!contentType) {
    $('#patient-upload-message').textContent = 'Use JPG, PNG, WEBP or PDF.';
    return;
  }
  try {
    const signed = await api('/files/presign', { method: 'POST', body: JSON.stringify({ category, fileName: file.name, contentType }) });
    const upload = await fetch(signed.uploadUrl, { method: 'PUT', headers: { 'Content-Type': contentType }, body: file });
    if (!upload.ok) throw new Error('Upload to R2 failed. Check the bucket CORS settings.');
    await api('/files/complete', { method: 'POST', body: JSON.stringify({ category, fileName: file.name, objectKey: signed.objectKey }) });
    event.currentTarget.reset();
    $('#patient-upload-message').textContent = 'File uploaded successfully.';
    await loadPatientPortal({ patient_id: patientPortalId });
  } catch (err) { $('#patient-upload-message').textContent = err.message; }
});

$('#patient-files').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-patient-download]');
  if (!button) return;
  try {
    const result = await api(`/files/${button.dataset.patientDownload}/download`);
    window.open(result.url, '_blank', 'noopener');
  } catch (err) { $('#patient-upload-message').textContent = err.message; }
});

$('#patient-consents').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-consent-action]');
  if (!button) return;
  const accepted = button.dataset.consentAction === 'accepted';
  const actionText = accepted ? 'accept' : 'reject';
  if (!window.confirm(`Are you sure you want to ${actionText} this consent?`)) return;
  try {
    await api(`/consents/${button.dataset.consentId}/acknowledge`, {
      method: 'PATCH', body: JSON.stringify({ status: button.dataset.consentAction })
    });
    $('#patient-consent-message').textContent = `Consent ${accepted ? 'accepted' : 'rejected'}.`;
    await loadPatientPortal({ patient_id: patientPortalId });
  } catch (err) { $('#patient-consent-message').textContent = err.message; }
});

const pageParams = new URLSearchParams(window.location.search);
if (pageParams.get('register') === '1') {
  // A saved staff session would normally skip the login page. The registration URL
  // intentionally clears this browser session so the patient form is always visible.
  showSignedOut();
  $('#register-panel').classList.remove('hidden');
  $('#show-register').classList.add('hidden');
} else if (token) {
  api('/me').then((data) => showSignedIn(data.user)).catch(showSignedOut);
}
