// firebase-client.js
//
// Thin wrapper around the Firebase Web SDK (modular, loaded from the CDN as
// an ES module) that connects the dashboard directly to the real Firebase
// Realtime Database. This file only ever READS. It never writes sensor,
// status, or alert data — only the ESP32 firmware writes those, under
// devices/{deviceId}, per database.rules.json.
//
// SCHEMA (see SETUP.md for the full contract):
//   devices/{deviceId}/
//     info/       { model, fw }                     — written occasionally
//     status/     { lastSeen (server ts), wifiRSSI } — written every sync
//     sensors/    { temperature, humidity, gas, fire, vibration, rain,
//                   soil, motion, distance }         — bare scalar values
//     heartbeat/  { uptimeS, freeHeap, ip, mac, fw, rssi } — written periodically
//     alerts/     { <pushId>: { type, message, value, ts (server ts) } }
//
// There is no "online" boolean stored in Firebase. Online/offline is a
// DASHBOARD-SIDE judgment call: if status/lastSeen hasn't advanced in the
// last OFFLINE_THRESHOLD_MS, the device is shown offline. This is more
// reliable than trusting the device to cleanly announce its own death (it
// usually can't — power loss, WiFi drop, and crashes all skip any
// "goodbye" write). See applyController()/tick() in the dashboard component.
//
// HOW TO CONFIGURE
// -----------------
// Before this file runs, define window.__ENTRAIOT_CONFIG__ somewhere in the
// page (e.g. a small inline <script> in the <head>, or a config.js file you
// load before this one):
//
//   window.__ENTRAIOT_CONFIG__ = {
//     firebaseConfig: {
//       apiKey: "...",
//       authDomain: "your-project.firebaseapp.com",
//       databaseURL: "https://your-project-default-rtdb.asia-southeast1.firebasedatabase.app",
//       projectId: "your-project",
//     },
//     deviceId: "esp32_001",   // which devices/{deviceId} to show
//     auth: null,              // OPTIONAL — omit to sign in anonymously
//   };
//
// Firebase Web API keys are not secret (they identify the project, not
// authorize access — see https://firebase.google.com/docs/projects/api-keys)
// so it's fine for firebaseConfig to live in this public file. What actually
// protects the data is database.rules.json, which requires `auth != null`
// to read anything under devices/. This module satisfies that by default
// with anonymous auth (no password needed in public frontend code at all).
// If you later want to restrict reads to specific people instead of "any
// signed-in browser", change the read rule to check auth.uid/auth.token and
// set window.__ENTRAIOT_CONFIG__.auth = { email, password } to sign in as
// a real account instead of anonymously.
//
// If window.__ENTRAIOT_CONFIG__ is missing, this module falls back to demo
// values that point at the local Firebase Emulator Suite, so the dashboard
// still works for local development without any setup.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  signInAnonymously,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getDatabase,
  ref,
  onValue,
  query,
  limitToLast,
  connectDatabaseEmulator,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

const DEFAULT_CONFIG = {
  firebaseConfig: {
    apiKey: "demo-key",
    authDomain: "entraiot-dev.firebaseapp.com",
    databaseURL: "http://127.0.0.1:9000/?ns=entraiot-dev-default-rtdb",
    projectId: "entraiot-dev",
  },
  deviceId: "esp32_001",
  useEmulator: true,
  auth: null,
};

const cfg = { ...DEFAULT_CONFIG, ...(window.__ENTRAIOT_CONFIG__ || {}) };

const app = initializeApp(cfg.firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

if (cfg.useEmulator) {
  try {
    connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
    connectDatabaseEmulator(db, "127.0.0.1", 9000);
  } catch (e) {
    // already connected — safe to ignore
  }
}

let readyResolve;
const ready = new Promise((res) => (readyResolve = res));

async function boot() {
  try {
    if (cfg.auth && cfg.auth.email && cfg.auth.password) {
      await signInWithEmailAndPassword(auth, cfg.auth.email, cfg.auth.password);
    } else if (!auth.currentUser) {
      // Default path: anonymous auth. The database rules only require
      // `auth != null` to read devices/*, and anonymous sign-in satisfies
      // that without any password living in this public file.
      await signInAnonymously(auth).catch((e) => {
        console.error("Firebase anonymous sign-in failed — reads will be denied by database.rules.json until auth succeeds:", e);
      });
    }
  } finally {
    readyResolve();
  }
}
boot();

function devicePath(...segments) {
  return `devices/${cfg.deviceId}/${segments.join("/")}`;
}

/** Resolves once auth has settled (signed in or attempted + failed). */
function whenReady() {
  return ready;
}

/** Live subscription to devices/{deviceId}/sensors. Fires on every change. */
function onSensors(cb) {
  return onValue(ref(db, devicePath("sensors")), (snap) => cb(snap.val() || {}));
}

/**
 * Live subscription to devices/{deviceId}'s info + status + heartbeat,
 * merged into one object: { info, status, heartbeat }. Online/offline is
 * NOT included here — it isn't stored in Firebase at all. The caller
 * derives it from status.lastSeen on its own clock (see tick() in the
 * dashboard component) so a device that goes silent is correctly shown
 * offline even though no new Firebase event ever arrives to trigger this
 * callback again.
 */
function onController(cb) {
  return onValue(ref(db, devicePath()), (snap) => {
    const all = snap.val() || {};
    cb(cfg.deviceId, {
      info: all.info || {},
      status: all.status || {},
      heartbeat: all.heartbeat || {},
    });
  });
}

/** Live subscription to the most recent `limit` alerts, newest first. */
function onAlerts(cb, limit = 50) {
  const alertsQuery = query(ref(db, devicePath("alerts")), limitToLast(limit));
  return onValue(alertsQuery, (snap) => {
    const val = snap.val() || {};
    const list = Object.entries(val)
      .map(([id, a]) => ({ id, ...a }))
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    cb(list);
  });
}

/**
 * No historical telemetry node exists in this schema (only current/latest
 * values are kept, per the "don't create unnecessary database history"
 * requirement — see SETUP.md for why, and how to add a telemetry node
 * later if you want charts of past data). These resolve to empty arrays so
 * the dashboard's chart-seeding code degrades gracefully instead of
 * erroring, and charts simply fill in from live samples going forward.
 */
async function fetchTelemetryRange(_sensor, _days) {
  return [];
}

async function fetchTodayTelemetry(_sensor) {
  return [];
}

window.EntraIoT = {
  whenReady,
  onSensors,
  onController,
  onAlerts,
  fetchTelemetryRange,
  fetchTodayTelemetry,
  deviceId: cfg.deviceId,
};
