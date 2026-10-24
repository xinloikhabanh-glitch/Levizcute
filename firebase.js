'use strict';

const admin = require('firebase-admin');
const { ApiError } = require('./util');

let db = null;

function loadCredential() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    // Cho phép dán JSON thẳng hoặc base64 của file JSON
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const sa = JSON.parse(text);
    if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
    return admin.credential.cert(sa);
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  if (projectId && clientEmail && privateKey) {
    return admin.credential.cert({ projectId, clientEmail, privateKey });
  }
  return null;
}

function getDb() {
  if (db) return db;

  if (!admin.apps.length) {
    let credential;
    try {
      credential = loadCredential();
    } catch (e) {
      console.error('Firebase credential parse error:', e.message);
      throw new ApiError('SERVER_ERROR', 'FIREBASE_SERVICE_ACCOUNT không đọc được (sai JSON/base64)');
    }
    if (!credential) {
      throw new ApiError(
        'SERVER_ERROR',
        'Chưa cấu hình Firebase: cần FIREBASE_SERVICE_ACCOUNT hoặc FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY'
      );
    }
    admin.initializeApp({ credential });
  }

  const instance = admin.firestore();
  instance.settings({ ignoreUndefinedProperties: true });
  db = instance;
  return db;
}

module.exports = { getDb };
