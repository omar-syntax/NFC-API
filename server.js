require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

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
 * Protects the admin user-provisioning API (POST/DELETE /users).
 * The signed-in dashboard admin sends their Firebase ID token as
 * `Authorization: Bearer <idToken>`. We verify it server-side via the Admin
 * SDK and confirm the caller's role is `admin` before allowing the request.
 * This prevents non-admins (or unsigned users) from creating/promoting users.
 */
async function requireAdmin(req, res, next) {
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
    if (!caller || caller.role !== 'admin') {
      return res.status(403).json({ status: 'error', message: 'Forbidden: admin role required' });
    }

    req.auth = { uid: callerId, role: caller.role };
    return next();
  } catch (err) {
    console.error('❌ requireAdmin error:', err.code || err.message);
    return res.status(401).json({ status: 'error', message: 'Invalid or expired token' });
  }
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
app.post('/users', requireAdmin, async (req, res) => {
  const { id, name, role, email, phone, password, linkedStudentId } = req.body;

  if (!name || !email) {
    return res.status(400).json({ status: 'error', message: 'name and email are required' });
  }
  const validRoles = ['admin', 'affairs', 'behavior', 'student', 'parent'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ status: 'error', message: 'Invalid role' });
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
app.delete('/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ status: 'error', message: 'id is required' });
  }
  try {
    if (!admin.apps.length) {
      return res.status(500).json({ status: 'error', message: 'Firebase not connected' });
    }
    await admin.auth().deleteUser(id);
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