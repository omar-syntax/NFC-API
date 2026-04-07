require('dotenv').config();
const admin = require('firebase-admin');

// ─── Firebase Init ────────────────────────────────────────────────────────────
try {
  const serviceAccount = require('./serviceAccountKey.json');
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.DATABASE_URL
  });
  console.log('✅ Firebase connected. Seeding Realtime Database...');
} catch (err) {
  console.error('❌ serviceAccountKey.json not found!');
  process.exit(1);
}

const db = admin.database();

// ─── Seed Data ────────────────────────────────────────────────────────────────
const sampleStudents = [
  {
    id: "201102606832",
    name: "Omar",
    nfcId: "04A3B21C",
    faceDescriptors: [0.1, -0.2, 0.45]
  },
  {
    id: "202400112233",
    name: "Aisha",
    nfcId: "A1B2C3D4",
    faceDescriptors: [0.5, 0.12, -0.3]
  },
  {
    id: "20240001",
    name: "Omar (Admin/Real Card)",
    nfcId: "AA223F02",
    faceDescriptors: [0.0, 0.0, 0.0]
  }
];

async function seed() {
  try {
    const studentsRef = db.ref('students');
    
    for (const student of sampleStudents) {
      const { id, ...data } = student;
      await studentsRef.child(id).set(data);
      console.log(`✅ Seeded student: ${student.name} (ID: ${id})`);
    }

    console.log('\n🌟 Realtime Database seeding complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error seeding database:', error);
    process.exit(1);
  }
}

seed();
