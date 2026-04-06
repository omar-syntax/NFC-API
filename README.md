# Smart Attendance System – Backend API

> Node.js + Express + Firebase Realtime Database
> Accepts NFC scans from ESP32 and Face scans from Tablet

---

## 🚀 Quick Start

```bash
cd backend
npm install
node server.js
```

Server runs at: `http://localhost:3000`

---

## 🔑 Firebase Setup

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project → **Project Settings** → **Service Accounts**
3. Click **Generate new private key** → save as `serviceAccountKey.json`
4. Place `serviceAccountKey.json` inside the `backend/` folder

> ⚠️ The server starts in **DEMO mode** if `serviceAccountKey.json` is missing.  
> Everything works but no data is written to Firebase.

---

## 📡 API Endpoints

| Method | Route        | Description              |
|--------|-------------|--------------------------|
| GET    | `/`          | Health check             |
| POST   | `/scan-nfc`  | NFC card attendance      |
| POST   | `/scan-face` | Face recognition attendance |

### GET /
```json
{ "message": "API Running 🚀", "status": "ok" }
```

### POST /scan-nfc
```json
// Request
{ "nfcId": "04A3B21C" }

// Success Response
{ "status": "success", "name": "Omar" }

// Error – student not found
{ "status": "error", "message": "Student not found" }
```

### POST /scan-face
```json
// Request
{ "studentId": "201102606832" }

// Success Response
{ "status": "success", "name": "Omar" }
```

---

## 🗂️ Firebase Realtime Database Structure

### `students` node
```
students/
  {studentId}/
    name:            "Omar"
    nfcId:           "04A3B21C"
    faceDescriptors: [...]
```

### `attendance` node
```
attendance/
  {push-id}/
    studentId:   "201102606832"
    studentName: "Omar"
    method:      "nfc" | "face"
    timestamp:   1712431234567  (Server Value)
```

---

## ☁️ Deploy to Render

1. Push `backend/` folder to GitHub
2. Create a new **Web Service** on [Render](https://render.com)
3. Set:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
4. Add environment variable `PORT` = `3000` (Render sets this automatically)
5. Upload `serviceAccountKey.json` contents as an environment variable (advanced – see docs)

---

## 🧪 Test with Postman / Thunder Client

Import and test:

- `POST http://localhost:3000/scan-nfc` → body `{ "nfcId": "04A3B21C" }`
- `POST http://localhost:3000/scan-face` → body `{ "studentId": "201102606832" }`
