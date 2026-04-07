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

/**
 * GET /students
 * Fetch all students for local face matching
 */
app.get('/students', async (req, res) => {
  try {
    if (!db) return res.json([]);
    const snapshot = await db.ref('students').once('value');
    if (!snapshot.exists()) return res.json([]);
    
    // Convert object to array
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
 * Register a new student with face descriptor and nfcId
 */
app.post('/students', async (req, res) => {
  const { name, className, nfcId, faceDescriptor } = req.body;

  if (!name || !nfcId || !faceDescriptor) {
    return res.status(400).json({ status: 'error', message: 'Missing required fields' });
  }

  try {
    if (!db) {
      return res.json({ status: 'success', message: 'Registered in DEMO mode' });
    }

    const studentData = {
      name,
      class: className || 'Unknown',
      nfcId,
      faceDescriptor, // Array of 128 numbers
      createdAt: admin.database.ServerValue.TIMESTAMP
    };

    const newStudentRef = db.ref('students').push();
    await newStudentRef.set(studentData);

    console.log(`👤 New student registered: ${name} (${newStudentRef.key})`);
    return res.json({ status: 'success', studentId: newStudentRef.key });

  } catch (err) {
    console.error('❌ /students POST error:', err.message);
    return res.status(500).json({ status: 'error', message: 'Internal server error' });
  }
});

/**
 * GET /attendance/report
 * Query attendance records for a specific date.
 * Query params:
 *   date  – YYYY-MM-DD (optional, defaults to today in Cairo time)
 * Returns: { date, totalScans, totalUniqueStudents, students[], rawRecords[] }
 */
app.get('/attendance/report', async (req, res) => {
  try {
    if (!db) {
      return res.json({ date: 'demo', totalScans: 0, totalUniqueStudents: 0, students: [], rawRecords: [] });
    }

    const CAIRO_OFFSET_MS = 2 * 60 * 60 * 1000; // UTC+2
    let startTs, endTs, reportDate;

    if (req.query.date && req.query.date !== 'today') {
      const [y, m, d] = req.query.date.split('-').map(Number);
      // Cairo midnight for that date, expressed in UTC ms
      startTs = Date.UTC(y, m - 1, d, 0, 0, 0) - CAIRO_OFFSET_MS;
      endTs   = startTs + 86400000 - 1;
      reportDate = req.query.date;
    } else {
      // Today in Cairo
      const cairoNow = Date.now() + CAIRO_OFFSET_MS;
      const cairoMidnight = Math.floor(cairoNow / 86400000) * 86400000;
      startTs = cairoMidnight - CAIRO_OFFSET_MS;
      endTs   = startTs + 86400000 - 1;
      const tmp = new Date(cairoMidnight);
      reportDate = `${tmp.getUTCFullYear()}-${String(tmp.getUTCMonth() + 1).padStart(2, '0')}-${String(tmp.getUTCDate()).padStart(2, '0')}`;
    }

    const snapshot = await db.ref('attendance')
      .orderByChild('timestamp')
      .startAt(startTs)
      .endAt(endTs)
      .once('value');

    const rawRecords = [];
    if (snapshot.exists()) {
      snapshot.forEach(child => {
        rawRecords.push({ id: child.key, ...child.val() });
      });
    }

    // Deduplicate – keep the FIRST check-in per student
    const seen = new Set();
    const uniqueStudents = [];
    for (const r of rawRecords) {
      if (!seen.has(r.studentId)) {
        seen.add(r.studentId);
        uniqueStudents.push({
          studentId: r.studentId,
          name: r.studentName,
          method: r.method,
          checkInTime: new Date(r.timestamp).toLocaleTimeString('en-EG', {
            timeZone: 'Africa/Cairo',
            hour: '2-digit',
            minute: '2-digit'
          })
        });
      }
    }

    console.log(`📊 /attendance/report – date: ${reportDate}, unique students: ${uniqueStudents.length}`);
    return res.json({
      date: reportDate,
      totalScans: rawRecords.length,
      totalUniqueStudents: uniqueStudents.length,
      students: uniqueStudents,
      rawRecords
    });

  } catch (err) {
    console.error('❌ /attendance/report error:', err.message);
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

