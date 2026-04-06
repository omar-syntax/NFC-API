require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ─── Helper: create attendance record ────────────────────────────────────────
async function createAttendanceRecord(studentId, studentName, method) {
  if (!db) {
    console.log(`[DEMO] Attendance logged – studentId: ${studentId}, name: ${studentName}, method: ${method}`);
    return;
  }

  const record = {
    studentId,
    studentName,
    method,          // 'nfc' | 'face'
    timestamp: admin.database.ServerValue.TIMESTAMP,
  };

  const ref = db.ref('attendance').push();
  await ref.set(record);
  console.log(`📝 Attendance record created: ${ref.key}`);
  return ref.key;
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
 */
app.post('/scan-nfc', async (req, res) => {
  const { nfcId } = req.body;

  if (!nfcId) {
    return res.status(400).json({ status: 'error', message: 'nfcId is required' });
  }

  console.log(`📡 NFC scan received – nfcId: ${nfcId}`);

  try {
    if (!db) {
      await createAttendanceRecord('DEMO_ID', 'Demo Student', 'nfc');
      return res.json({ status: 'success', name: 'Demo Student (Firebase not connected)' });
    }

    // ── RTDB: Lookup by nfcId ───────────────────────────────────────────────
    const snapshot = await db.ref('students')
      .orderByChild('nfcId')
      .equalTo(nfcId)
      .once('value');

    if (!snapshot.exists()) {
      console.warn(`⚠️  No student found for nfcId: ${nfcId}`);
      return res.status(404).json({ status: 'error', message: 'Student not found' });
    }

    // snapshot.val() is an object with { studentId: data }
    const studentId = Object.keys(snapshot.val())[0];
    const student = snapshot.val()[studentId];

    await createAttendanceRecord(studentId, student.name, 'nfc');

    console.log(`✅ NFC attendance marked – name: ${student.name}`);
    return res.json({ status: 'success', name: student.name });

  } catch (err) {
    console.error('❌ /scan-nfc error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * POST /scan-face
 */
app.post('/scan-face', async (req, res) => {
  const { studentId } = req.body;

  if (!studentId) {
    return res.status(400).json({ status: 'error', message: 'studentId is required' });
  }

  console.log(`🎭 Face scan received – studentId: ${studentId}`);

  try {
    if (!db) {
      await createAttendanceRecord(studentId, 'Demo Student', 'face');
      return res.json({ status: 'success', name: 'Demo Student (Firebase not connected)' });
    }

    // ── RTDB: Lookup by studentId ───────────────────────────────────────────
    const snapshot = await db.ref('students').child(studentId).once('value');

    if (!snapshot.exists()) {
      console.warn(`⚠️  No student found for studentId: ${studentId}`);
      return res.status(404).json({ status: 'error', message: 'Student not found' });
    }

    const student = snapshot.val();

    await createAttendanceRecord(studentId, student.name, 'face');

    console.log(`✅ Face attendance marked – name: ${student.name}`);
    return res.json({ status: 'success', name: student.name });

  } catch (err) {
    console.error('❌ /scan-face error:', err.message);
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

