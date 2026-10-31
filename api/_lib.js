'use strict';

const crypto = require('crypto');

// ================= CONFIG =================
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Thời lượng key (ms). null = vĩnh viễn.
const DURATIONS = {
  hour: HOUR,
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
  year: 365 * DAY,
  lifetime: null,
};

const DURATION_ALIASES = {
  h: 'hour', hr: 'hour', hour: 'hour', hours: 'hour', gio: 'hour',
  d: 'day', day: 'day', days: 'day', ngay: 'day',
  w: 'week', week: 'week', weeks: 'week', tuan: 'week',
  m: 'month', month: 'month', months: 'month', thang: 'month',
  y: 'year', year: 'year', years: 'year', nam: 'year',
  lifetime: 'lifetime', permanent: 'lifetime', forever: 'lifetime', vinhvien: 'lifetime',
};

const TIERS = ['basic', 'premium'];
const COLLECTION = process.env.FIRESTORE_COLLECTION || 'license_keys';
// Danh sách thiết bị nằm trong 1 document Firestore (tối đa ~1 MiB, ~150 byte/thiết bị)
// nên 3000 là mức an toàn. Muốn không giới hạn: tắt deviceLock.
const MAX_DEVICES_LIMIT = 3000;
const MAX_CREATE_PER_REQUEST = 1000;
const MAX_TARGETS_PER_REQUEST = 500;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

// ================= UTIL =================
const HTTP_STATUS = {
  BAD_REQUEST: 400,
  HWID_REQUIRED: 400,
  UNAUTHORIZED: 401,
  INVALID_KEY: 404,
  KEY_BANNED: 403,
  KEY_EXPIRED: 403,
  DEVICE_LIMIT: 403,
  METHOD_NOT_ALLOWED: 405,
  PARTIAL: 500,
  SERVER_ERROR: 500,
};

const MESSAGES = {
  BAD_REQUEST: 'Yêu cầu không hợp lệ',
  HWID_REQUIRED: 'Thiếu hwid (key này đang bật khoá thiết bị)',
  UNAUTHORIZED: 'Sai hoặc thiếu ADMIN_SECRET',
  INVALID_KEY: 'Key không tồn tại',
  KEY_BANNED: 'Key đã bị khoá',
  KEY_EXPIRED: 'Key đã hết hạn',
  DEVICE_LIMIT: 'Key đã đạt số thiết bị tối đa',
  METHOD_NOT_ALLOWED: 'Sai phương thức HTTP',
  PARTIAL: 'Tạo key bị gián đoạn, chỉ một phần được tạo',
  SERVER_ERROR: 'Lỗi máy chủ',
};

class ApiError extends Error {
  constructor(code, message, extra) {
    super(message || MESSAGES[code] || code);
    this.code = code;
    this.extra = extra || null;
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function ok(res, payload) {
  sendJson(res, 200, { success: true, ...payload });
}

function fail(res, code, message, extra) {
  sendJson(res, HTTP_STATUS[code] || 500, {
    success: false,
    error: code,
    message: message || MESSAGES[code] || code,
    ...(extra || {}),
  });
}

function handleError(res, err) {
  if (err instanceof ApiError) return fail(res, err.code, err.message, err.extra);
  console.error(err);
  return fail(res, 'SERVER_ERROR');
}

function parseBody(req) {
  let b = req.body;
  if (b == null) return {};
  if (Buffer.isBuffer(b)) b = b.toString('utf8');
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      return {};
    }
  }
  return b && typeof b === 'object' && !Array.isArray(b) ? b : {};
}

function normalizeKey(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim().toUpperCase();
  return /^[A-Z0-9-]{8,80}$/.test(s) ? s : null;
}

function normalizeHwid(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (s.length < 6 || s.length > 256) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  return s;
}

function cleanText(v, max) {
  if (v == null) return '';
  return String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function sanitizePrefix(v) {
  return String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10);
}

function parseDuration(v) {
  if (typeof v !== 'string') return null;
  const k = v.toLowerCase().replace(/[\s_-]/g, '');
  if (!Object.prototype.hasOwnProperty.call(DURATION_ALIASES, k)) return null;
  return DURATION_ALIASES[k];
}

function toInt(v, min, max, name) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) {
    throw new ApiError('BAD_REQUEST', `${name} phải là số nguyên từ ${min} đến ${max}`);
  }
  return n;
}

function toBool(v, name) {
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  throw new ApiError('BAD_REQUEST', `${name} phải là true hoặc false`);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 32 ký tự, bỏ I, O, 0, 1 cho dễ đọc
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomGroup(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] & 31];
  return s;
}

// PREFIX-XXXX-XXXX-XXXX-XXXX (80 bit ngẫu nhiên)
function generateKey(prefix) {
  return `${prefix}-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ================= FIREBASE =================
let db = null;

function loadCredential(admin) {
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
  const admin = require('firebase-admin');

  if (!admin.apps.length) {
    let credential;
    try {
      credential = loadCredential(admin);
    } catch (e) {
      console.error('Firebase credential parse error:', e.message);
      throw new ApiError('SERVER_ERROR', 'FIREBASE_SERVICE_ACCOUNT không đọc được (sai JSON/base64)');
    }
    if (!credential) {
      throw new ApiError(
        'SERVER_ERROR',
        'Chưa cấu hình Firebase: cần FIREBASE_SERVICE_ACCOUNT (hoặc FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)'
      );
    }
    admin.initializeApp({ credential });
  }

  const instance = admin.firestore();
  instance.settings({ ignoreUndefinedProperties: true });
  db = instance;
  return db;
}

// ================= LICENSE LOGIC =================
function maxDevicesOf(d) {
  const n = parseInt(d.maxDevices, 10);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, MAX_DEVICES_LIMIT);
}

// banned | unused (chưa kích hoạt) | expired | active
function stateOf(d, now) {
  if (d.status === 'banned') return 'banned';
  if (!d.activatedAt) return 'unused';
  if (d.expiresAt != null && now >= d.expiresAt) return 'expired';
  return 'active';
}

function describe(d, now, id) {
  const devices = Array.isArray(d.devices) ? d.devices : [];
  return {
    key: d.key || id,
    tier: d.tier,
    duration: d.duration,
    quantity: d.quantity == null ? 1 : d.quantity,
    state: stateOf(d, now),
    deviceLock: d.deviceLock !== false,
    maxDevices: maxDevicesOf(d),
    devicesUsed: devices.length,
    devices,
    note: d.note || '',
    createdAt: d.createdAt || null,
    activatedAt: d.activatedAt || null,
    expiresAt: d.expiresAt == null ? null : d.expiresAt,
    lastUsedAt: d.lastUsedAt || null,
    bannedAt: d.bannedAt || null,
    banReason: d.banReason || '',
  };
}

/**
 * Kiểm tra key + gắn thiết bị, chạy trong transaction nên 2 máy gọi cùng lúc
 * không thể vượt quá maxDevices. Trả về { error, extra? } hoặc { data }.
 */
async function verifyKey(database, { key, hwid, deviceName }) {
  const ref = database.collection(COLLECTION).doc(key);
  const name = cleanText(deviceName, 64) || null;

  return database.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) return { error: 'INVALID_KEY' };

    const d = snap.data();
    const now = Date.now();
    if (d.status === 'banned') return { error: 'KEY_BANNED' };

    const updates = {};
    let activatedAt = d.activatedAt || null;
    let expiresAt = d.expiresAt == null ? null : d.expiresAt;

    if (!activatedAt) {
      // Lần đầu dùng: bắt đầu tính thời hạn từ lúc này
      activatedAt = now;
      expiresAt = d.durationMs ? now + d.durationMs : null;
      updates.activatedAt = activatedAt;
      updates.expiresAt = expiresAt;
    } else if (expiresAt !== null && now >= expiresAt) {
      return { error: 'KEY_EXPIRED' };
    }

    const lockOn = d.deviceLock !== false;
    const maxDevices = maxDevicesOf(d);
    let devices = Array.isArray(d.devices) ? d.devices : [];

    if (lockOn) {
      if (!hwid) return { error: 'HWID_REQUIRED' };

      const idx = devices.findIndex((x) => x && x.hwid === hwid);
      if (idx >= 0) {
        const cur = devices[idx];
        const stale = now - (cur.lastSeen || 0) >= TOUCH_INTERVAL_MS;
        const renamed = name && name !== cur.name;
        if (stale || renamed) {
          devices = devices.map((x, i) =>
            i === idx ? { ...x, lastSeen: now, name: name || x.name || null } : x
          );
          updates.devices = devices;
        }
      } else {
        if (devices.length >= maxDevices) return { error: 'DEVICE_LIMIT', extra: { maxDevices } };
        devices = devices.concat([{ hwid, name, firstSeen: now, lastSeen: now }]);
        updates.devices = devices;
      }
    }

    if (Object.keys(updates).length > 0) {
      updates.lastUsedAt = now;
      t.update(ref, updates);
    }

    return {
      data: {
        key,
        tier: d.tier,
        duration: d.duration,
        lifetime: expiresAt === null,
        activatedAt,
        expiresAt,
        remainingMs: expiresAt === null ? null : Math.max(0, expiresAt - now),
        deviceLock: lockOn,
        maxDevices,
        devicesUsed: devices.length,
        serverTime: now,
      },
    };
  });
}

module.exports = {
  DURATIONS,
  TIERS,
  COLLECTION,
  MAX_DEVICES_LIMIT,
  MAX_CREATE_PER_REQUEST,
  MAX_TARGETS_PER_REQUEST,
  ApiError,
  ok,
  fail,
  handleError,
  parseBody,
  normalizeKey,
  normalizeHwid,
  cleanText,
  sanitizePrefix,
  parseDuration,
  toInt,
  toBool,
  safeEqual,
  generateKey,
  setCors,
  sleep,
  getDb,
  describe,
  verifyKey,
};
