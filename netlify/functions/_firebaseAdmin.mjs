// Shared Firebase Admin SDK bootstrap for all Netlify scheduled functions.
//
// Uses a service account loaded from Netlify environment variables (Site
// configuration -> Environment variables — see SETUP.md Part 4), never a
// file on disk, since Netlify Functions get a fresh filesystem per
// invocation and you should never commit a service account JSON to git.
//
// Required variables:
//   FIREBASE_PROJECT_ID
//   FIREBASE_CLIENT_EMAIL
//   FIREBASE_PRIVATE_KEY     (paste the PEM block; Netlify's UI preserves
//                             newlines, but if yours got flattened to
//                             literal "\n" text, this file unflattens it)
//   FIREBASE_DATABASE_URL
//
// The Admin SDK bypasses database.rules.json entirely (same trust level
// Cloud Functions had), so these functions can read/write any path.

import { initializeApp, cert, getApps } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

let app;

export function getAdminApp() {
  if (app) return app;

  const existing = getApps();
  if (existing.length) {
    app = existing[0];
    return app;
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  const databaseURL = process.env.FIREBASE_DATABASE_URL;

  if (!projectId || !clientEmail || !rawKey || !databaseURL) {
    throw new Error(
      "Missing Firebase Admin env vars. Set FIREBASE_PROJECT_ID, " +
        "FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, and " +
        "FIREBASE_DATABASE_URL in Netlify -> Site configuration -> " +
        "Environment variables. See SETUP.md Part 4."
    );
  }

  const privateKey = rawKey.includes("\\n") ? rawKey.replace(/\\n/g, "\n") : rawKey;

  app = initializeApp({
    credential: cert({ projectId, clientEmail, privateKey }),
    databaseURL,
  });
  return app;
}

export function db() {
  return getDatabase(getAdminApp());
}
