require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { verifyLoginWidget, telegramName } = require('./telegram');

// ─── Firebase Init ────────────────────────────────────────────────────────────
let serviceAccount;

// Priority 1: Environment Variable (for Render/Production)
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Firebase initialized using Environment Variable');
  } catch (err) {
    console.error('❌ Failed to parse FIREBASE_SERVICE_ACCOUNT env var');
  }
}
// Priority 2: Service Account File (for Local Dev)
else {
  try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log('✅ Firebase initialized using serviceAccountKey.json');
  } catch (err) {
    console.warn('⚠️  serviceAccountKey.json not found');
  }
}

if (serviceAccount) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: process.env.DATABASE_URL
    });
  } catch (err) {
    console.error('❌ Firebase connection error:', err.message);
  }
} else {
  console.warn('⚠️  Running in DEMO mode (no Firebase credentials found)');
}

const db = admin.apps.length ? admin.database() : null;

// ─── Express Setup ────────────────────────────────────────────────────────────
const app = express();

// Restrict cross-origin requests to known web origins. Devices (Arduino/tablet)
// send a token header instead of relying on CORS.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    // Allow non-browser clients (curl, Arduino, Postman) which send no Origin.
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error('Origin not allowed by CORS'));
  }
}));
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Config ───────────────────────────────────────────────────────────────────
// "HH:MM" in Cairo time — a check-in at/after this is marked as late.
const CHECK_IN_DEADLINE = process.env.CHECK_IN_DEADLINE || '07:30';

const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';

// Telegram integration. The bot itself is owned by an n8n flow; this backend is
// only an authorization gateway. TELEGRAM_BOT_TOKEN is used to verify Telegram
// Login Widget payloads; N8N_AUTH_KEY secures the /telegram/check endpoint.
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const N8N_AUTH_KEY = process.env.N8N_AUTH_KEY || '';

/**
 * Protects device-facing endpoints (NFC scanner, tablet). Clients must send
 * the correct `x-device-token` header; comparison is done in constant time.
 */
function requireDeviceToken(req, res, next) {
  if (!DEVICE_TOKEN) {
    // Token not configured on the server: refuse to run insecure.
    return res.status(503).json({ status: 'error', message: 'DEVICE_TOKEN is not configured on the server' });
  }
  const provided = req.get('x-device-token') || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(DEVICE_TOKEN);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized device' });
  }
  return next();
}

/**
 * Protects the back-office user-provisioning API (POST/DELETE /users).
 * The signed-in dashboard user sends their Firebase ID token as
 * `Authorization: Bearer <idToken>`. We verify it server-side via the Admin
 * SDK and confirm the caller's role is a back-office role ('admin' or
 * 'affairs') before allowing the request.
 * This prevents students/parents (or unsigned users) from creating users.
 * Finer-grained role checks (which roles a caller may create/delete) are done
 * inside each route handler.
 */
async function requireBackoffice(req, res, next) {
  const header = req.get('authorization') || '';
  const parts = header.split(' ');
  const token = parts.length === 2 && parts[0].toLowerCase() === 'bearer' ? parts[1] : null;

  if (!token) {
    return res.status(401).json({ status: 'error', message: 'Missing Authorization header' });
  }

  if (!admin.apps.length) {
    return res.status(500).json({ status: 'error', message: 'Firebase not connected' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    const callerId = decoded.uid;

    const callerSnap = await db.ref(`users/${callerId}`).once('value');
    const caller = callerSnap.val();
    if (!caller || !['admin', 'affairs'].includes(caller.role)) {
      return res.status(403).json({ status: 'error', message: 'Forbidden: back-office role required' });
    }

    req.auth = { uid: callerId, role: caller.role };
    return next();
  } catch (err) {
    console.error('❌ requireBackoffice error:', err.code || err.message);
    return res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
  }
}

/**
 * Protects the n8n-facing authorization endpoint (/telegram/check). The n8n
 * flow sends the shared secret in `x-telegram-auth-key`; comparison is done in
 * constant time. This endpoint is intentionally NOT behind the Firebase token
 * flow — n8n has no signed-in dashboard user.
 */
function requireN8n(req, res, next) {
  if (!N8N_AUTH_KEY) {
    return res.status(503).json({ status: 'error', message: 'N8N_AUTH_KEY is not configured on the server' });
  }
  const provided = req.get('x-telegram-auth-key') || '';
  const a = Buffer.from(String(provided));
  const b = Buffer.from(N8N_AUTH_KEY);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    return res.status(401).json({ status: 'error', message: 'Unauthorized' });
  }
  return next();
}

// ─── Time helpers (Cairo = UTC+2) ────────────────────────────────────────────
const CAIRO_OFFSET_MS = 2 * 60 * 60 * 1000;

function cairoDateKey(timestamp) {
  const t = new Date(timestamp + CAIRO_OFFSET_MS);
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

function cairoTimeHM(timestamp) {
  const t = new Date(timestamp + CAIRO_OFFSET_MS);
  return `${String(t.getUTCHours()).padStart(2, '0')}:${String(t.getUTCMinutes()).padStart(2, '0')}`;
}

function minutesFromHHMM(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function computeStatus(checkInTime) {
  const minutesLate = Math.max(0, minutesFromHHMM(checkInTime) - minutesFromHHMM(CHECK_IN_DEADLINE));
  return minutesLate > 0 ? { status: 'late', minutesLate } : { status: 'present', minutesLate: 0 };
}

// ─── Attendance (new schema) ─────────────────────────────────────────────────
// attendance/{YYYY-MM-DD}/{studentId}: { studentId, status, checkInTime, method, minutesLate }
// First check-in of the day wins; later scans do not overwrite it.
async function markAttendance(student, method) {
  const timestamp = Date.now();
  const dateKey = cairoDateKey(timestamp);
  const checkInTime = cairoTimeHM(timestamp);
  const { status, minutesLate } = computeStatus(checkInTime);

  const ref = db.ref(`attendance/${dateKey}/${student.id}`);
  const existing = await ref.once('value');
  if (existing.exists()) {
    return { skipped: true, existing: existing.val() };
  }

  const record = { studentId: student.id, status, checkInTime, method, minutesLate };
  await ref.set(record);
  console.log(`📝 Attendance marked – ${student.name} (${dateKey}) ${checkInTime} via ${method}`);
  return { skipped: false, record };
}

// ─── Routes ──────────────────────────────────────────────────────────────────

/**
 * GET /
 * Health check
 */
app.get('/', (req, res) => {
  res.json({ message: 'API Running 🚀', database: 'RealtimeDB', status: 'ok' });
});

/**
 * POST /scan-nfc
 * Two modes:
 *  - If /settings/nfcListeningMode is true → capture the UID for a NEW student
 *    registration (writes /settings/lastScannedNFC) and NOT mark attendance.
 *  - Otherwise → normal attendance marking using the new day-keyed schema.
 */
app.post('/scan-nfc', requireDeviceToken, async (req, res) => {
  const { nfcId } = req.body;

  if (!nfcId) {
    return res.status(400).json({ status: 'error', message: 'nfcId is required' });
  }

  console.log(`📡 NFC scan received – nfcId: ${nfcId}`);

  try {
    if (!db) {
      return res.json({ status: 'success', name: 'Demo Student (Firebase not connected)' });
    }

    // ── Registration listening mode ────────────────────────────────────────
    const listening = await db.ref('settings/nfcListeningMode').once('value');
    if (listening.val() === true) {
      await db.ref('settings').update({ nfcListeningMode: false, lastScannedNFC: nfcId });
      console.log(`🎴 NFC captured for student registration – nfcId: ${nfcId}`);
      return res.json({ status: 'registration', nfcId, message: 'Card captured for registration' });
    }

    // ── Normal attendance: lookup student by nfcId ─────────────────────────
    const snapshot = await db.ref('students')
      .orderByChild('nfcId')
      .equalTo(nfcId)
      .once('value');

    if (!snapshot.exists()) {
      console.warn(`⚠️  No student found for nfcId: ${nfcId}`);
      return res.status(404).json({ status: 'error', message: 'Student not found' });
    }

    const studentId = Object.keys(snapshot.val())[0];
    const student = snapshot.val()[studentId];

    const result = await markAttendance({ id: studentId, name: student.name }, 'nfc');

    if (result.skipped) {
      return res.json({ status: 'success', name: student.name, alreadyCheckedIn: true });
    }
    return res.json({ status: 'success', name: student.name, attendance: result.record });

  } catch (err) {
    console.error('❌ /scan-nfc error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * POST /scan-face
 */
app.post('/scan-face', requireDeviceToken, async (req, res) => {
  const { studentId } = req.body;

  if (!studentId) {
    return res.status(400).json({ status: 'error', message: 'studentId is required' });
  }

  console.log(`🎭 Face scan received – studentId: ${studentId}`);

  try {
    if (!db) {
      return res.json({ status: 'success', name: 'Demo Student (Firebase not connected)' });
    }

    const snapshot = await db.ref('students').child(studentId).once('value');

    if (!snapshot.exists()) {
      console.warn(`⚠️  No student found for studentId: ${studentId}`);
      return res.status(404).json({ status: 'error', message: 'Student not found' });
    }

    const student = snapshot.val();

    const result = await markAttendance({ id: studentId, name: student.name || student.stdName }, 'face');

    if (result.skipped) {
      return res.json({ status: 'success', name: student.name, alreadyCheckedIn: true });
    }
    return res.json({ status: 'success', name: student.name, attendance: result.record });

  } catch (err) {
    console.error('❌ /scan-face error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * GET /students
 * Fetch all students for local face matching (tablet-web keeps using this contract).
 */
app.get('/students', requireDeviceToken, async (req, res) => {
  try {
    if (!db) return res.json([]);
    const snapshot = await db.ref('students').once('value');
    if (!snapshot.exists()) return res.json([]);

    const data = snapshot.val();
    const students = Object.keys(data).map(id => ({
      studentId: id,
      ...data[id]
    }));

    return res.json(students);
  } catch (err) {
    console.error('❌ /students error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * POST /students
 * Register a new student (new schema) with face descriptor and nfcId.
 * Also initializes the behavior record for the student.
 */
app.post('/students', requireDeviceToken, async (req, res) => {
  const { name, className, phone, nfcId, faceDescriptor } = req.body;

  if (!name || !nfcId || !faceDescriptor) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }

  try {
    if (!db) {
      return res.json({ status: 'success', message: 'Registered in DEMO mode' });
    }

    const settings = await db.ref('settings/initialBehaviorScore').once('value');
    const initialScore = typeof settings.val() === 'number' ? settings.val() : 100;

    const newStudentRef = db.ref('students').push();
    const studentData = {
      id: newStudentRef.key,
      name,
      className: className || 'Unknown',
      phone: phone || '',
      nfcId,
      faceEnrolled: true,       // has a stored descriptor
      faceDescriptor,           // keep for tablet-web face matching
      createdAt: admin.database.ServerValue.TIMESTAMP
    };

    await newStudentRef.set(studentData);
    await db.ref(`studentBehavior/${newStudentRef.key}`).set({
      currentScore: initialScore,
      logs: {}
    });

    console.log(`👤 New student registered: ${name} (${newStudentRef.key})`);
    return res.json({ status: 'success', studentId: newStudentRef.key });

  } catch (err) {
    console.error('❌ /students POST error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * GET /attendance/report
 * Query attendance for a specific date (new day-keyed schema).
 * Query params:
 *   date – YYYY-MM-DD (optional, defaults to today in Cairo time)
 */
app.get('/attendance/report', requireDeviceToken, async (req, res) => {
  try {
    if (!db) {
      return res.json({ date: 'demo', totalScans: 0, totalUniqueStudents: 0, students: [] });
    }

    const reportDate = req.query.date && req.query.date !== 'today'
      ? req.query.date
      : cairoDateKey(Date.now());

    const snapshot = await db.ref(`attendance/${reportDate}`).once('value');

    const rawRecords = [];
    if (snapshot.exists()) {
      snapshot.forEach(child => {
        rawRecords.push({ id: child.key, ...child.val() });
      });
    }

    // Resolve names for display
    const studentsSnap = await db.ref('students').once('value');
    const nameById = {};
    if (studentsSnap.exists()) {
      studentsSnap.forEach(child => {
        nameById[child.key] = child.val().name || child.key;
      });
    }

    const students = rawRecords.map(r => ({
      studentId: r.studentId,
      name: nameById[r.studentId] || r.studentId,
      method: r.method,
      checkInTime: r.checkInTime,
      status: r.status,
      minutesLate: r.minutesLate || 0
    }));

    console.log(`📊 /attendance/report – date: ${reportDate}, students: ${students.length}`);
    return res.json({
      date: reportDate,
      totalScans: rawRecords.length,
      totalUniqueStudents: students.length,
      students,
      rawRecords
    });

  } catch (err) {
    console.error('❌ /attendance/report error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * POST /users
 * Provision a user: create/update (or get the UID of) a Firebase Auth account
 * and write the profile to `users/{uid}`. Uses the Admin SDK (bypasses rules).
 * Only reachable by an authenticated admin (verified via Firebase ID token).
 * Never stores plaintext passwords — credentials live only in Firebase Auth.
 * Body: { id?, name, role, email, phone?, password?, linkedStudentId? }
 */
app.post('/users', requireBackoffice, async (req, res) => {
  const { id, name, role, email, phone, password, linkedStudentId } = req.body;

  if (!name || !email) {
    return res.status(400).json({ status: 'error', message: 'name and email are required' });
  }
  const validRoles = ['admin', 'affairs', 'behavior', 'student', 'parent'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ status: 'error', message: 'Invalid role' });
  }

  // Back-office role authorization:
  //   - admin may provision/update any role.
  //   - affairs may only provision/update student and parent accounts.
  if (req.auth.role === 'affairs' && !['student', 'parent'].includes(role)) {
    return res.status(403).json({ status: 'error', message: 'Forbidden: affairs can only manage student/parent accounts' });
  }

  try {
    if (!admin.apps.length) {
      return res.status(500).json({ status: 'error', message: 'Firebase not connected' });
    }

    const auth = admin.auth();
    let uid = id || null;

    if (uid) {
      // Update existing Auth user's email/password if provided.
      const updateData = {};
      if (email) updateData.email = email;
      if (password) updateData.password = password;
      await auth.updateUser(uid, updateData);
    } else {
      if (!password) {
        return res.status(400).json({ status: 'error', message: 'password is required for new users' });
      }
      const created = await auth.createUser({ email, password });
      uid = created.uid;
    }

    // Write the profile node (Admin SDK bypasses RTDB rules).
    const profile = {
      id: uid,
      name,
      email,
      role,
      active: true,
      phone: phone || '',
      linkedStudentId: linkedStudentId || null,
      createdAt: admin.database.ServerValue.TIMESTAMP
    };
    await db.ref(`users/${uid}`).set(profile);

    console.log(`👤 User provisioned: ${name} (${uid}, ${role})`);
    return res.json({ status: 'success', uid });
  } catch (err) {
    console.error('❌ /users POST error:', err.code || err.message);
    const code = err.code || '';
    if (code.startsWith('auth/')) {
      return res.status(400).json({ status: 'error', message: err.message });
    }
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * DELETE /users/:id
 * Delete the Firebase Auth account and its profile node. Admin only.
 */
app.delete('/users/:id', requireBackoffice, async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ status: 'error', message: 'id is required' });
  }
  // Deleting users is a sensitive operation: admin only.
  if (req.auth.role !== 'admin') {
    return res.status(403).json({ status: 'error', message: 'Forbidden: admin role required' });
  }
  try {
    if (!admin.apps.length) {
      return res.status(500).json({ status: 'error', message: 'Firebase not connected' });
    }
    await admin.auth().deleteUser(id);
    const userSnap = await db.ref(`users/${id}`).once('value');
    const user = userSnap.val();
    if (user?.telegramUserId) {
      await db.ref(`telegramLinks/${String(user.telegramUserId)}`).remove();
    }
    await db.ref(`users/${id}`).remove();
    console.log(`🗑️  User deleted from Auth + users/${id}`);
    return res.json({ status: 'success' });
  } catch (err) {
    console.error('❌ /users DELETE error:', err.code || err.message);
    if (err.code === 'auth/user-not-found') {
      // Still clean up the profile node even if Auth already removed the user.
      await db.ref(`users/${id}`).remove();
      return res.json({ status: 'success' });
    }
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * POST /telegram/link
 * Link the signed-in back-office user's platform account to a Telegram account.
 * The body is the raw object produced by Telegram's official Login Widget
 * (`id, first_name, last_name, username, auth_date, hash`). The signature and
 * freshness are verified server-side against the bot token, so a client-supplied
 * Telegram ID is never trusted on its own. Only admin/affairs may link.
 */
app.post('/telegram/link', requireBackoffice, async (req, res) => {
  if (!TELEGRAM_BOT_TOKEN) {
    return res.status(503).json({ status: 'error', message: 'TELEGRAM_BOT_TOKEN is not configured on the server' });
  }

  const payload = req.body || {};
  if (!verifyLoginWidget(payload, TELEGRAM_BOT_TOKEN, Date.now())) {
    return res.status(400).json({ status: 'error', message: 'Invalid Telegram authorization data' });
  }

  const telegramUserId = String(payload.id);
  const uid = req.auth.uid;

  try {
    if (!admin.apps.length) {
      return res.status(500).json({ status: 'error', message: 'Firebase not connected' });
    }

    // If this user already had a different Telegram account linked, drop it so
    // the OLD id is freed for re-linking (but keep the link valid until step
    // below completes — the new id owns the current session).
    const userSnap = await db.ref(`users/${uid}`).once('value');
    const user = userSnap.val() || {};
    const staleId = user.telegramUserId ? String(user.telegramUserId) : null;

    // Reserve the Telegram id atomically so one Telegram account can never end
    // up linked to two platform users (race-safe under concurrent requests).
    const linkRef = db.ref(`telegramLinks/${telegramUserId}`);
    let takenByOther = false;
    const result = await linkRef.transaction((current) => {
      if (current && current.uid !== uid) {
        takenByOther = true;
        return undefined; // abort: existing link belongs to someone else
      }
      return { uid, linkedAt: Date.now() };
    });

    if (!result.committed) {
      // Aborted. Re-check to distinguish "owned by another user" from
      // "already linked to the same user" (idempotent re-link is allowed).
      const existing = (await linkRef.once('value')).val();
      if (existing && existing.uid !== uid) {
        return res.status(409).json({ status: 'error', message: 'Telegram account is already linked to another user' });
      }
      takenByOther = false;
    }

    if (takenByOther) {
      return res.status(409).json({ status: 'error', message: 'Telegram account is already linked to another user' });
    }

    const linkedAt = Date.now();
    await linkRef.set({ uid, linkedAt });

    const updates = {
      telegramUserId: payload.id,
      telegramUsername: payload.username || '',
      telegramName: telegramName(payload),
      telegramLinkedAt: linkedAt
    };
    if (staleId && staleId !== telegramUserId) {
      await db.ref(`telegramLinks/${staleId}`).remove();
    }
    await db.ref(`users/${uid}`).update(updates);

    console.log(`🔗 Telegram linked – ${req.auth.role} ${uid} ↔ tg ${telegramUserId}`);
    return res.json({ status: 'success', telegramUserId });
  } catch (err) {
    console.error('❌ /telegram/link error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * DELETE /telegram/link
 * Disconnect the signed-in user's account from Telegram. This immediately
 * revokes bot access (the next /telegram/check finds no link).
 */
app.delete('/telegram/link', requireBackoffice, async (req, res) => {
  const uid = req.auth.uid;
  try {
    if (!admin.apps.length) {
      return res.status(500).json({ status: 'error', message: 'Firebase not connected' });
    }
    const userSnap = await db.ref(`users/${uid}`).once('value');
    const user = userSnap.val() || {};
    const oldId = user.telegramUserId ? String(user.telegramUserId) : null;

    const updates = {
      telegramUserId: null,
      telegramUsername: null,
      telegramName: null,
      telegramLinkedAt: null
    };
    await db.ref(`users/${uid}`).update(updates);
    if (oldId) {
      await db.ref(`telegramLinks/${oldId}`).remove();
    }

    console.log(`🔗 Telegram unlinked – ${req.auth.role} ${uid}`);
    return res.json({ status: 'success' });
  } catch (err) {
    console.error('❌ /telegram/link DELETE error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * GET /telegram/status
 * Return the current user's Telegram linking state.
 */
app.get('/telegram/status', requireBackoffice, async (req, res) => {
  try {
    if (!admin.apps.length) {
      return res.status(500).json({ status: 'error', message: 'Firebase not connected' });
    }
    const userSnap = await db.ref(`users/${req.auth.uid}`).once('value');
    const user = userSnap.val() || {};
    const linked = Boolean(user.telegramUserId);
    return res.json({
      linked,
      telegramUserId: linked ? user.telegramUserId : null,
      telegramUsername: linked ? user.telegramUsername || null : null,
      telegramName: linked ? user.telegramName || null : null,
      telegramLinkedAt: linked ? user.telegramLinkedAt || null : null
    });
  } catch (err) {
    console.error('❌ /telegram/status error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * GET /telegram/check
 * Authorization gateway for the n8n Telegram flow. Given the numeric Telegram
 * user id that sent a message, returns whether that person may interact with
 * the bot. Every call re-reads live platform data: link exists → linked user
 * exists and is active → role is admin/affairs. No hardcoded whitelist.
 * Secured by `x-telegram-auth-key` (shared secret with n8n), not the Firebase
 * ID-token flow.
 */
app.get('/telegram/check', requireN8n, async (req, res) => {
  const telegramUserId = String(req.query.telegram_user_id || '');
  if (!telegramUserId) {
    return res.status(400).json({ status: 'error', message: 'telegram_user_id is required' });
  }
  try {
    if (!admin.apps.length) {
      return res.status(500).json({ status: 'error', message: 'Firebase not connected' });
    }
    const linkSnap = await db.ref(`telegramLinks/${telegramUserId}`).once('value');
    if (!linkSnap.exists()) {
      console.log(`🔍 /telegram/check – denied (unlinked), tg ${telegramUserId}`);
      return res.json({ authorized: false });
    }
    const link = linkSnap.val();
    const userSnap = await db.ref(`users/${link.uid}`).once('value');
    const user = userSnap.val();
    if (!user || user.active === false || !['admin', 'affairs'].includes(user.role)) {
      const reason = !user ? 'no user' : user.active === false ? 'inactive' : 'role';
      console.log(`🔍 /telegram/check – denied (${reason}), tg ${telegramUserId}`);
      return res.json({ authorized: false });
    }
    console.log(`🔍 /telegram/check – granted: tg ${telegramUserId} → ${user.role}`);
    return res.json({ authorized: true, user: { uid: link.uid, name: user.name, role: user.role } });
  } catch (err) {
    console.error('❌ /telegram/check error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * POST /users/:id/status
 * Enable or disable an account. Disabling immediately revokes Telegram bot
 * access (checked live on every /telegram/check) while keeping data intact.
 * Admin only.
 * Body: { active: boolean }
 */
app.post('/users/:id/status', requireBackoffice, async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;
  if (req.auth.role !== 'admin') {
    return res.status(403).json({ status: 'error', message: 'Forbidden: admin role required' });
  }
  if (typeof active !== 'boolean') {
    return res.status(400).json({ status: 'error', message: 'active must be a boolean' });
  }
  try {
    if (!admin.apps.length) {
      return res.status(500).json({ status: 'error', message: 'Firebase not connected' });
    }
    await db.ref(`users/${id}`).update({ active });
    console.log(`⚙️  User ${id} active=${active}`);
    return res.json({ status: 'success' });
  } catch (err) {
    console.error('❌ /users/:id/status error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

app.use((req, res) => {
  res.status(404).json({ status: 'error', message: `Route ${req.method} ${req.path} not found` });
});

app.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║  🚀  Smart Attendance API (RTDB)         ║`);
  console.log(`║  📡  Running on http://localhost:${PORT}    ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});