# ☁️ Render Deployment Guide

Follow these steps to host your **Smart Attendance API** on Render.

---

## 1. Prepare your GitHub Repository

1.  Create a new, **private** repository on GitHub.
2.  Push only the `backend/` folder contents to the root of your repo.
    *   **Note**: Ensure `node_modules` and `serviceAccountKey.json` are NOT uploaded (they are already in your `.gitignore`).

---

## 2. Create a Web Service on Render

1.  Log in to [Render.com](https://render.com).
2.  Click **New +** → **Web Service**.
3.  Connect your GitHub account and select your repository.
4.  **Configuration**:
    *   **Name**: `smart-attendance-api` (or any name you like)
    *   **Runtime**: `Node`
    *   **Build Command**: `npm install`
    *   **Start Command**: `npm start`
    *   **Plan**: `Free` (or any plan)

---

## 3. Configure Environment Variables

This is the **most important** step. In the Render dashboard for your service, go to the **Environment** tab and add:

| Key | Value |
| :--- | :--- |
| `DATABASE_URL` | Your Realtime Database URL (ends in `.firebasedatabase.app/`) |
| `FIREBASE_SERVICE_ACCOUNT` | The **entire content** of your `serviceAccountKey.json` file. |

> [!TIP]
> To get the value for `FIREBASE_SERVICE_ACCOUNT`, open your `serviceAccountKey.json` file, select all the text, and copy-paste it into the Render value field.

---

## 4. Test your Live API

Once Render finishes building (it will say `Live`), you can test it by replacing `localhost:3000` with your Render URL:

*   `GET https://your-service-name.onrender.com/` → Should see "API Running"
*   `POST https://your-service-name.onrender.com/scan-nfc` → Test with mock data

---

**Everything is now prepared in your local code to support this deployment!**
