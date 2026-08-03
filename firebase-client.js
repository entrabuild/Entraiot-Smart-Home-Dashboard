// firebase-client.js
//
// Thin wrapper around the Firebase Web SDK (modular, loaded from the CDN as
// an ES module) that gives the dashboard everything it needs to go from
// "Math.random() simulation" to "live cloud data" without touching the
// existing backend, database schema, or security rules.
//
// SPARK PLAN NOTE (post Cloud-Functions removal): there is no server behind
// this database anymore — no onAlertCreated, no presenceCheck, no
// aggregateTelemetry. Every piece of that used to happen server-side is now
// handled entirely on-device (ESP32 firmware + esp32-emulator write their
// own hourly telemetry rollups and raw history samples) or client-side here
// / in the dashboard component (alert display enrichment, online/offline
// derived from heartbeat staleness, in-tab notifications). See
// docs/architecture/rtdb-schema.md and the backend implementation report
// for the full before/after.
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
//     homeId: "home_demo1",       // which /homes/{homeId} to show
//     deviceId: null,             // optional: pin to one controller; null = use the first one found
//     auth: {                     // OPTIONAL — omit if you already sign the user in yourself
//       email: "member@example.com",
//       password: "..."
//     }
//   };
//
// If window.__ENTRAIOT_CONFIG__ is missing, this module falls back to demo
// values that point at the local Firebase Emulator Suite (matching
// scripts/seed.js in the backend repo), so the dashboard still works for
// local development without any setup.
//
// Everything below is read-only from the dashboard's point of view — per
// rtdb-schema.md, only the ESP32 ever writes to
// sensors/devices/controllers/alerts/history/telemetry. sendCommand()/ackAlert() are provided
// for future UI (Part 8 of the spec) but the current dashboard UI does not
// call them, since the existing UI has no device-control screen to preserve.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signInAnonymously,
  connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getDatabase,
  ref,
  onValue,
  query,
  limitToLast,
  orderByChild,
  startAt,
  get,
  push,
  set,
  update,
  connectDatabaseEmulator,
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-database.js";

const DEFAULT_CONFIG = {
  firebaseConfig: {
    apiKey: "demo-key",
    authDomain: "entraiot-dev.firebaseapp.com",
    databaseURL: "http://127.0.0.1:9000/?ns=entraiot-dev-default-rtdb",
    projectId: "entraiot-dev",
  },
  homeId: "home_demo1",
  deviceId: null,
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
      // No credentials configured — fall back to anonymous auth so reads at
      // least resolve in local/demo setups where rules allow it. In a real
      // deployment, replace this with your normal sign-in flow and set
      // window.__ENTRAIOT_CONFIG__.auth (or sign the user in before this
      // module loads).
      await signInAnonymously(auth).catch(() => {});
    }
  } finally {
    readyResolve();
  }
}
boot();

function homePath(...segments) {
  return `homes/${cfg.homeId}/${segments.join("/")}`;
}

/** Resolves once auth has settled (signed in or attempted + failed). */
function whenReady() {
  return ready;
}

/** Live subscription to /homes/{homeId}/sensors. Fires on every change. */
function onSensors(cb) {
  return onValue(ref(db, homePath("sensors")), (snap) => cb(snap.val() || {}));
}

/**
 * Live subscription to a controller (ESP32). If cfg.deviceId is not set,
 * watches /controllers and auto-picks the first deviceId it sees, then
 * subscribes to that specific controller's info/heartbeat/status.
 */
function onController(cb) {
  const controllersRef = ref(db, homePath("controllers"));
  let innerUnsub = null;
  const outerUnsub = onValue(controllersRef, (snap) => {
    const all = snap.val() || {};
    const deviceId = cfg.deviceId || Object.keys(all)[0];
    if (!deviceId) {
      cb(null, null);
      return;
    }
    if (innerUnsub) return; // already watching the resolved device directly
    innerUnsub = onValue(ref(db, homePath("controllers", deviceId)), (dSnap) => {
      cb(deviceId, dSnap.val() || null);
    });
  });
  return () => {
    outerUnsub();
    if (innerUnsub) innerUnsub();
  };
}

/** Live subscription to /homes/{homeId}/devices (relay/light/fan/lock states). */
function onDevices(cb) {
  return onValue(ref(db, homePath("devices")), (snap) => cb(snap.val() || {}));
}

// Raw /homes/{homeId}/alerts/{id} records only ever carry the schema fields
// (type, severity, msg, ts, ack) — see rtdb-schema.md. The dashboard's
// render logic (Entraiot Dashboard.dc.html) expects a few extra
// display-ready aliases (t, level, color, icon, message). This is the one
// and only place that mapping happens, so the UI never has to guess.
const ALERT_ICON_BY_TYPE = { fire: "🔥", gas: "💨", vibration: "📳", rain: "🌧️", offline: "🔌" };
const ALERT_COLOR_BY_SEVERITY = { critical: "#f87171", warning: "#fbbf24", info: "#38bdf8" };

function enrichAlert(id, a) {
  const severity = a.severity || "info";
  return {
    id,
    type: a.type,
    severity,
    msg: a.msg,
    ts: a.ts,
    ack: a.ack || null,
    // Display aliases consumed by the dashboard template/component:
    t: a.ts,
    level: severity.toUpperCase(),
    color: ALERT_COLOR_BY_SEVERITY[severity] || "#64748b",
    icon: ALERT_ICON_BY_TYPE[a.type] || "⚠️",
    message: a.msg || "Alert",
  };
}

/** Live subscription to the most recent `limit` alerts, newest first. */
function onAlerts(cb, limit = 50) {
  const alertsQuery = query(ref(db, homePath("alerts")), limitToLast(limit));
  return onValue(alertsQuery, (snap) => {
    const val = snap.val() || {};
    const list = Object.entries(val)
      .map(([id, a]) => enrichAlert(id, a))
      .sort((a, b) => b.ts - a.ts);
    cb(list);
  });
}

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * One-shot fetch of hourly telemetry rollups for `sensor` over the last
 * `days` days, e.g. for the Analytics 7D/30D filters. Returns an array of
 * { date, hour, min, max, avg, n } sorted oldest -> newest. Backed entirely
 * by real /telemetry data — written directly by the ESP32 (or
 * esp32-emulator) once per completed hour, since Spark has no Cloud
 * Functions to do that rollup server-side anymore. No synthetic fallback.
 */
async function fetchTelemetryRange(sensor, days) {
  const out = [];
  const today = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000);
    const dStr = dateStr(d);
    // eslint-disable-next-line no-await-in-loop
    const snap = await get(ref(db, homePath("telemetry", sensor, dStr)));
    const hours = snap.val() || {};
    Object.keys(hours)
      .sort()
      .forEach((hh) => out.push({ date: dStr, hour: hh, ...hours[hh] }));
  }
  return out;
}

/**
 * One-shot fetch of today's telemetry (used to seed the in-memory rolling
 * history arrays on first load, so charts aren't empty before enough live
 * samples have streamed in).
 */
async function fetchTodayTelemetry(sensor) {
  const snap = await get(ref(db, homePath("telemetry", sensor, dateStr(new Date()))));
  const hours = snap.val() || {};
  return Object.keys(hours)
    .sort()
    .map((hh) => hours[hh].avg);
}

/**
 * Live subscription to the most recent `limit` raw samples for `sensor`
 * from /homes/{homeId}/history/{sensor} — written directly by the ESP32 (or
 * esp32-emulator) on the same cadence as /sensors, per rtdb-schema.md.
 * This is what backs the dashboard's "Recent History" table/log view.
 * Replaces the old Cloud-Functions-only /_raw staging path, which no
 * longer exists now that the backend runs on Spark.
 */
function onHistory(sensor, cb, limit = 30) {
  const q = query(ref(db, homePath("history", sensor)), limitToLast(limit));
  return onValue(q, (snap) => {
    const val = snap.val() || {};
    const list = Object.entries(val)
      .map(([id, v]) => ({ id, ...v }))
      .sort((a, b) => b.ts - a.ts);
    cb(list);
  });
}

/**
 * One-shot fetch of every /history/{sensor} sample at or after `sinceMs`.
 * Uses orderByChild('ts') + startAt so this scales without pulling the
 * entire node — useful for a custom date-range export.
 */
async function fetchHistoryRange(sensor, sinceMs) {
  const q = query(ref(db, homePath("history", sensor)), orderByChild("ts"), startAt(sinceMs));
  const snap = await get(q);
  const val = snap.val() || {};
  return Object.entries(val)
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Writes a command for the ESP32 to pick up (two-way command system, Part
 * 8). Not wired to any UI element in the current dashboard (there is no
 * device-control screen to preserve per the "do not redesign the UI"
 * requirement), but ready to call from future controls.
 */
function sendCommand(target, action) {
  const uid = auth.currentUser ? auth.currentUser.uid : "unknown";
  return push(ref(db, homePath("commands")), {
    target,
    action,
    by: uid,
    ts: Date.now(),
    status: "pending",
  });
}

/** Acknowledges an alert (Part 7). Also not wired to UI yet — see above. */
function ackAlert(alertId) {
  const uid = auth.currentUser ? auth.currentUser.uid : "unknown";
  return set(ref(db, homePath("alerts", alertId, "ack")), { by: uid, ts: Date.now() });
}

window.EntraIoT = {
  whenReady,
  onSensors,
  onController,
  onDevices,
  onAlerts,
  onHistory,
  fetchHistoryRange,
  fetchTelemetryRange,
  fetchTodayTelemetry,
  sendCommand,
  ackAlert,
  homeId: cfg.homeId,
};
