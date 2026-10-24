'use strict';

const { getDb } = require('../../lib/firebase');
const {
  COLLECTION,
  DURATIONS,
  TIERS,
  MAX_DEVICES_LIMIT,
  MAX_CREATE_PER_REQUEST,
  MAX_TARGETS_PER_REQUEST,
} = require('../../lib/config');
const {
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
  sleep,
} = require('../../lib/util');
const { describe } = require('../../lib/license');

// ---------- helpers ----------

function providedSecret(req) {
  const h = req.headers || {};
  if (typeof h['x-admin-secret'] === 'string') return h['x-admin-secret'];
  const a = h.authorization;
  if (typeof a === 'string' && /^bearer\s+/i.test(a)) return a.replace(/^bearer\s+/i, '');
  return '';
}

function collectKeys(p) {
  let raw = [];
  if (Array.isArray(p.keys)) raw = p.keys;
  else if (typeof p.keys === 'string') raw = p.keys.split(/[\s,]+/).filter(Boolean);
  else if (p.key !== undefined) raw = [p.key];

  const out = new Set();
  for (const r of raw) {
    const k = normalizeKey(r);
    if (!k) throw new ApiError('BAD_REQUEST', `Key không hợp lệ: ${String(r).slice(0, 40)}`);
    out.add(k);
  }
  if (out.size === 0) throw new ApiError('BAD_REQUEST', 'Thiếu key (dùng "key" hoặc "keys")');
  if (out.size > MAX_TARGETS_PER_REQUEST) {
    throw new ApiError('BAD_REQUEST', `Tối đa ${MAX_TARGETS_PER_REQUEST} key mỗi lần`);
  }
  return [...out];
}

/**
 * Đọc-sửa-ghi nhiều key trong 1 transaction (tránh ghi đè lẫn nhau với /api/verify).
 * fn(data, now) => { updates } | { delete: true } | { error: 'CODE' }
 */
async function mutate(db, keys, fn) {
  const col = db.collection(COLLECTION);
  return db.runTransaction(async (t) => {
    const refs = keys.map((k) => col.doc(k));
    const snaps = await t.getAll(...refs);
    const now = Date.now();
    const res = { updated: 0, notFound: [], errors: {} };

    snaps.forEach((snap, i) => {
      const key = keys[i];
      if (!snap.exists) {
        res.notFound.push(key);
        return;
      }
      const out = fn(snap.data(), now);
      if (out.error) {
        res.errors[key] = out.error;
        return;
      }
      if (out.delete) t.delete(refs[i]);
      else t.update(refs[i], out.updates);
      res.updated++;
    });
    return res;
  });
}

// ---------- actions ----------

const actions = {
  // Tạo key: tier, duration, quantity, count, maxDevices, deviceLock, prefix, note
  async create(db, p) {
    const tier = typeof p.tier === 'string' ? p.tier.toLowerCase().trim() : '';
    if (!TIERS.includes(tier)) throw new ApiError('BAD_REQUEST', 'tier phải là "basic" hoặc "premium"');

    const duration = parseDuration(p.duration);
    if (!duration) {
      throw new ApiError('BAD_REQUEST', 'duration phải là: hour, day, week, month, year hoặc lifetime');
    }

    const quantity =
      duration === 'lifetime' ? 1 : p.quantity === undefined ? 1 : toInt(p.quantity, 1, 10000, 'quantity');
    const count = p.count === undefined ? 1 : toInt(p.count, 1, MAX_CREATE_PER_REQUEST, 'count');
    const maxDevices =
      p.maxDevices === undefined ? 1 : toInt(p.maxDevices, 1, MAX_DEVICES_LIMIT, 'maxDevices');
    const deviceLock = p.deviceLock === undefined ? true : toBool(p.deviceLock, 'deviceLock');
    const note = cleanText(p.note, 200);
    const prefix = sanitizePrefix(p.prefix) || (tier === 'premium' ? 'PREM' : 'BASIC');
    const durationMs = DURATIONS[duration] === null ? null : DURATIONS[duration] * quantity;

    const col = db.collection(COLLECTION);
    const now = Date.now();
    const created = [];
    const seen = new Set();

    try {
      while (created.length < count) {
        const size = Math.min(400, count - created.length);
        let attempt = 0;
        for (;;) {
          const batch = db.batch();
          const part = [];
          while (part.length < size) {
            const key = generateKey(prefix);
            if (seen.has(key)) continue;
            seen.add(key);
            part.push(key);
            batch.create(col.doc(key), {
              key,
              tier,
              duration,
              quantity,
              durationMs,
              deviceLock,
              maxDevices,
              status: 'active',
              note,
              devices: [],
              createdAt: now,
              activatedAt: null,
              expiresAt: null,
              lastUsedAt: null,
            });
          }
          try {
            await batch.commit();
            created.push(...part);
            break;
          } catch (e) {
            attempt++;
            // 6 = ALREADY_EXISTS (trùng key cực hiếm) => sinh lại
            if (!(e && e.code === 6 && attempt < 3)) throw e;
          }
        }
      }
    } catch (e) {
      if (created.length > 0) {
        console.error(e);
        throw new ApiError('PARTIAL', undefined, { created });
      }
      throw e;
    }

    return { count: created.length, tier, duration, quantity, maxDevices, deviceLock, keys: created };
  },

  async list(db, p) {
    const limit = p.limit === undefined ? 200 : toInt(p.limit, 1, 1000, 'limit');
    const snap = await db.collection(COLLECTION).orderBy('createdAt', 'desc').limit(limit).get();
    const now = Date.now();
    const keys = snap.docs.map((doc) => describe(doc.data(), now, doc.id));
    return { count: keys.length, keys, serverTime: now };
  },

  async get(db, p) {
    const key = normalizeKey(p.key);
    if (!key) throw new ApiError('BAD_REQUEST', 'Key không hợp lệ');
    const snap = await db.collection(COLLECTION).doc(key).get();
    if (!snap.exists) throw new ApiError('INVALID_KEY');
    return { key: describe(snap.data(), Date.now(), snap.id) };
  },

  async ban(db, p) {
    const keys = collectKeys(p);
    const reason = cleanText(p.reason, 200);
    return mutate(db, keys, (d, now) => ({
      updates: { status: 'banned', bannedAt: now, banReason: reason },
    }));
  },

  async unban(db, p) {
    const keys = collectKeys(p);
    return mutate(db, keys, () => ({
      updates: { status: 'active', bannedAt: null, banReason: '' },
    }));
  },

  async delete(db, p) {
    const keys = collectKeys(p);
    return mutate(db, keys, () => ({ delete: true }));
  },

  // Gỡ toàn bộ thiết bị, hoặc chỉ 1 thiết bị nếu truyền hwid
  async 'reset-devices'(db, p) {
    const keys = collectKeys(p);
    let hwid = null;
    if (p.hwid !== undefined && p.hwid !== null && p.hwid !== '') {
      hwid = normalizeHwid(p.hwid);
      if (!hwid) throw new ApiError('BAD_REQUEST', 'hwid không hợp lệ');
    }
    return mutate(db, keys, (d) => {
      const cur = Array.isArray(d.devices) ? d.devices : [];
      return { updates: { devices: hwid ? cur.filter((x) => x && x.hwid !== hwid) : [] } };
    });
  },

  // Cộng thêm thời gian: duration + quantity
  async extend(db, p) {
    const keys = collectKeys(p);
    const duration = parseDuration(p.duration);
    if (!duration || duration === 'lifetime') {
      throw new ApiError('BAD_REQUEST', 'duration phải là: hour, day, week, month hoặc year');
    }
    const quantity = p.quantity === undefined ? 1 : toInt(p.quantity, 1, 10000, 'quantity');
    const addMs = DURATIONS[duration] * quantity;

    return mutate(db, keys, (d, now) => {
      if (d.durationMs == null) return { error: 'LIFETIME_KEY' };
      if (!d.activatedAt) return { updates: { durationMs: d.durationMs + addMs } };
      const base = Math.max(d.expiresAt || 0, now); // key đã hết hạn thì tính từ bây giờ
      return { updates: { expiresAt: base + addMs } };
    });
  },

  // Sửa tier / maxDevices / deviceLock / note
  async update(db, p) {
    const keys = collectKeys(p);
    const patch = {};
    if (p.tier !== undefined) {
      const tier = typeof p.tier === 'string' ? p.tier.toLowerCase().trim() : '';
      if (!TIERS.includes(tier)) throw new ApiError('BAD_REQUEST', 'tier phải là "basic" hoặc "premium"');
      patch.tier = tier;
    }
    if (p.maxDevices !== undefined) patch.maxDevices = toInt(p.maxDevices, 1, MAX_DEVICES_LIMIT, 'maxDevices');
    if (p.deviceLock !== undefined) patch.deviceLock = toBool(p.deviceLock, 'deviceLock');
    if (p.note !== undefined) patch.note = cleanText(p.note, 200);
    if (Object.keys(patch).length === 0) {
      throw new ApiError('BAD_REQUEST', 'Không có trường nào để sửa (tier, maxDevices, deviceLock, note)');
    }
    return mutate(db, keys, () => ({ updates: patch }));
  },
};

// ---------- handler ----------

module.exports = async function handler(req, res) {
  // Không bật CORS cho admin: chỉ admin panel cùng domain được gọi từ trình duyệt
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return fail(res, 'METHOD_NOT_ALLOWED');
  }

  const secret = process.env.ADMIN_SECRET || '';
  if (secret.length < 16) {
    return fail(res, 'SERVER_ERROR', 'ADMIN_SECRET chưa được cấu hình (cần >= 16 ký tự)');
  }

  const given = providedSecret(req);
  if (!given || !safeEqual(given, secret)) {
    await sleep(400); // làm chậm dò mật khẩu
    return fail(res, 'UNAUTHORIZED');
  }

  try {
    const action = String((req.query && req.query.action) || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(actions, action)) {
      return fail(res, 'BAD_REQUEST', `Action không tồn tại: ${action.slice(0, 30)}`);
    }
    const params = { ...(req.query || {}), ...parseBody(req) };
    const result = await actions[action](getDb(), params);
    return ok(res, { action, ...result });
  } catch (err) {
    return handleError(res, err);
  }
};
