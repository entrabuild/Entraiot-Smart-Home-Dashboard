// Netlify Scheduled Function — OPTIONAL. Not required for the core
// ESP32 -> Firebase -> Dashboard pipeline: the dashboard already computes
// online/offline for itself, live, from devices/{deviceId}/status/lastSeen
// (see tick()/applyController() in the frontend). This function does NOT
// feed that — it exists only to leave a durable record in the device's own
// alert log when it goes offline for an extended period, so "device was
// offline from X to Y" shows up in the Alerts history/notification list
// even if nobody had the dashboard open to see it happen live.
//
// Safe to delete this file (and its entry in netlify.toml) if you don't
// want that history and would rather rely purely on the dashboard's live
// status. Deleting it changes nothing about basic sensor data delivery.
//
// Runs every 5 minutes on Netlify's free plan (schedule in netlify.toml),
// well within the free 300 build/function-minutes-equivalent credits per
// month for a single small project like this.

import { db } from "./_firebaseAdmin.mjs";

// Longer than the dashboard's own 15s "offline" threshold on purpose — this
// function only records genuinely extended outages as history, not the
// normal jitter of a 3-5s sync cadence occasionally running a few seconds
// late.
const OFFLINE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

export default async () => {
  const database = db();
  const devicesSnap = await database.ref("devices").get();
  const devices = devicesSnap.val() || {};
  const now = Date.now();

  for (const deviceId of Object.keys(devices)) {
    const device = devices[deviceId] || {};
    const lastSeen = device.status?.lastSeen || 0;
    const age = now - lastSeen;
    const alreadyFlagged = device._offlineFlagged === true;

    if (age > OFFLINE_THRESHOLD_MS && !alreadyFlagged) {
      console.log(`[offline-check] ${deviceId} has not synced in ${Math.round(age / 1000)}s — logging offline alert`);
      await database.ref(`devices/${deviceId}/alerts`).push({
        type: "offline",
        message: `Device has not reported in for over ${Math.round(OFFLINE_THRESHOLD_MS / 60000)} minutes.`,
        ts: { ".sv": "timestamp" },
      });
      // Marker so we don't push a duplicate "offline" alert every 5 minutes
      // while the outage continues — cleared below once the device syncs
      // again (lastSeen advances, so age drops back under the threshold).
      await database.ref(`devices/${deviceId}/_offlineFlagged`).set(true);
    } else if (age <= OFFLINE_THRESHOLD_MS && alreadyFlagged) {
      console.log(`[offline-check] ${deviceId} is back (age=${Math.round(age / 1000)}s) — clearing offline flag`);
      await database.ref(`devices/${deviceId}/_offlineFlagged`).remove();
    }
  }

  return new Response("ok");
};

// Schedule is declared once, in netlify.toml, as the single source of
// truth (rather than duplicating it here too).
