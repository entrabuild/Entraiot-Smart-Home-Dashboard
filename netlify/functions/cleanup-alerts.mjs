// Netlify Scheduled Function — OPTIONAL. Not required for the core
// ESP32 -> Firebase -> Dashboard pipeline. Alerts are the only thing this
// project still writes an unbounded, ever-growing list of (sensor readings
// and heartbeat are single scalars that get overwritten in place, so they
// never grow). Left completely unmanaged, a device that trips a lot of
// alerts over months could accumulate enough entries to matter for the free
// tier's 1GB storage cap.
//
// This function keeps that bounded by (a) hard-capping each device to its
// MAX_ALERTS_PER_DEVICE most recent alerts, and (b) dropping anything older
// than MAX_ALERT_AGE_DAYS regardless of count. Both are generous for a
// hobby/home project; tune them down if you want tighter storage.
//
// Safe to delete this file (and its entry in netlify.toml) — the dashboard
// and firmware both work fine with an unbounded alerts list; you'd just
// slowly use more of the free 1GB over a period of years.
//
// Runs once daily (schedule in netlify.toml).

import { db } from "./_firebaseAdmin.mjs";

const MAX_ALERTS_PER_DEVICE = 200;
const MAX_ALERT_AGE_DAYS = 90;

export default async () => {
  const database = db();
  const devicesSnap = await database.ref("devices").get();
  const devices = devicesSnap.val() || {};
  const cutoff = Date.now() - MAX_ALERT_AGE_DAYS * 24 * 60 * 60 * 1000;

  for (const deviceId of Object.keys(devices)) {
    const alerts = devices[deviceId]?.alerts || {};
    const entries = Object.entries(alerts); // [id, {type, message, ts, ...}]
    if (entries.length === 0) continue;

    entries.sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0)); // newest first

    const toDelete = [];
    entries.forEach(([id, alert], i) => {
      const tooOld = typeof alert?.ts === "number" && alert.ts < cutoff;
      const overCap = i >= MAX_ALERTS_PER_DEVICE;
      if (tooOld || overCap) toDelete.push(id);
    });

    if (toDelete.length === 0) continue;

    console.log(`[cleanup-alerts] ${deviceId}: removing ${toDelete.length} of ${entries.length} alerts (over cap or older than ${MAX_ALERT_AGE_DAYS}d)`);
    const updates = {};
    for (const id of toDelete) updates[id] = null; // null = delete this child
    await database.ref(`devices/${deviceId}/alerts`).update(updates);
  }

  return new Response("ok");
};

// Schedule is declared once, in netlify.toml, as the single source of
// truth (rather than duplicating it here too).
