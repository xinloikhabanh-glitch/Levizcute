'use strict';

const crypto = require('crypto');
const { DURATIONS, DURATION_ALIASES } = require('./config');

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

// ---------- Chuẩn hoá input ----------

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

// ---------- Bảo mật ----------

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// 32 ký tự, bỏ các ký tự dễ nhầm (I, O, 0, 1) => mỗi nhóm 4 ký tự = 20 bit
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomGroup(len) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[bytes[i] & 31];
  return s;
}

// PREFIX-XXXX-XXXX-XXXX-XXXX  (80 bit ngẫu nhiên)
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

module.exports = {
  ApiError,
  DURATIONS,
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
};
