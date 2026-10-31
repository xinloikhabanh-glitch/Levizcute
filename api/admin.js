'use strict';

const L = require('./_lib');
const { ApiError, DURATIONS, TIERS, COLLECTION } = L;
const admin_FieldPath = () => require('firebase-admin').firestore.FieldPath;

// POST /api/admin?action=<create|list|stats|purge|get|ban|unban|delete|reset-devices|extend|update>
// Header: x-admin-secret: <ADMIN_SECRET>

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
    const k = L.normalizeKey(r);
    if (!k) throw new ApiError('BAD_REQUEST', `Key không hợp lệ: ${String(r).slice(0, 40)}`);
    out.add(k);
  }
  if (out.size === 0) throw new ApiError('BAD_REQUEST', 'Thiếu key (dùng "key" hoặc "keys")');
  if (out.size > L.MAX_TARGETS_PER_REQUEST) {
    throw new ApiError('BAD_REQUEST', `Tối đa ${L.MAX_TARGETS_PER_REQUEST} key mỗi lần`);
  }
  return [...out];
}

// Đọc-sửa-ghi nhiều key trong 1 transaction (không ghi đè lẫn nhau với /api/verify)
// fn(data, now) => { updates } | { delete: true } | { error: 'CODE' }
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

const actions = {
  async create(db, p) {
    const tier = typeof p.tier === 'string' ? p.tier.toLowerCase().trim() : '';
    if (!TIERS.includes(tier)) throw new ApiError('BAD_REQUEST', 'tier phải là "basic" hoặc "premium"');

    const duration = L.parseDuration(p.duration);
    if (!duration) {
      throw new ApiError('BAD_REQUEST', 'duration phải là: hour, day, week, month, year hoặc lifetime');
    }

    const quantity =
      duration === 'lifetime' ? 1 : p.quantity === undefined ? 1 : L.toInt(p.quantity, 1, 10000, 'quantity');
    const count = p.count === undefined ? 1 : L.toInt(p.count, 1, L.MAX_CREATE_PER_REQUEST, 'count');
    const maxDevices =
      p.maxDevices === undefined ? 1 : L.toInt(p.maxDevices, 1, L.MAX_DEVICES_LIMIT, 'maxDevices');
    const deviceLock = p.deviceLock === undefined ? true : L.toBool(p.deviceLock, 'deviceLock');
    const note = L.cleanText(p.note, 200);
    const prefix = L.sanitizePrefix(p.prefix) || (tier === 'premium' ? 'PREM' : 'BASIC');
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
            const key = L.generateKey(prefix);
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
            // 6 = ALREADY_EXISTS (trùng key, cực hiếm) => sinh lại
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

  // Phân trang: truyền lại "next" của lần trước vào "after" để lấy trang kế tiếp
  async list(db, p) {
    const limit = p.limit === undefined ? 200 : L.toInt(p.limit, 1, 1000, 'limit');
    let q = db.collection(COLLECTION).orderBy('createdAt', 'desc').orderBy(admin_FieldPath().documentId(), 'desc');
    if (p.after && typeof p.after === 'object' && p.after.key) {
      const at = Number(p.after.createdAt);
      if (!Number.isFinite(at)) throw new ApiError('BAD_REQUEST', 'after không hợp lệ');
      const k = L.normalizeKey(p.after.key);
      if (!k) throw new ApiError('BAD_REQUEST', 'after không hợp lệ');
      q = q.startAfter(at, k);
    }
    const snap = await q.limit(limit).get();
    const now = Date.now();
    const keys = snap.docs.map((doc) => L.describe(doc.data(), now, doc.id));
    const last = keys[keys.length - 1];
    const next = keys.length === limit && last ? { createdAt: last.createdAt, key: last.key } : null;
    return { count: keys.length, keys, next, serverTime: now };
  },

  // Đếm toàn bộ key (không tải danh sách)
  async stats(db) {
    const col = db.collection(COLLECTION);
    const now = Date.now();
    const cnt = async (q) => {
      try { return (await q.count().get()).data().count; } catch (e) { return null; }
    };
    const [total, banned, unused, expired, basic, premium] = await Promise.all([
      cnt(col),
      cnt(col.where('status', '==', 'banned')),
      cnt(col.where('activatedAt', '==', null)),
      cnt(col.where('expiresAt', '<=', now)),
      cnt(col.where('tier', '==', 'basic')),
      cnt(col.where('tier', '==', 'premium')),
    ]);
    return { stats: { total, banned, unused, expired, basic, premium }, serverTime: now };
  },

  // Dọn key hàng loạt: mỗi lần tối đa 400, lặp lại cho tới khi done = true
  async purge(db, p) {
    const state = String(p.state || '').toLowerCase();
    if (p.confirm !== true) throw new ApiError('BAD_REQUEST', 'Cần confirm: true để xoá hàng loạt');
    const col = db.collection(COLLECTION);
    const now = Date.now();
    let q;
    if (state === 'expired') q = col.where('expiresAt', '<=', now);
    else if (state === 'banned') q = col.where('status', '==', 'banned');
    else if (state === 'unused') q = col.where('activatedAt', '==', null);
    else throw new ApiError('BAD_REQUEST', 'state phải là expired, banned hoặc unused');
    const snap = await q.limit(400).get();
    if (snap.empty) return { deleted: 0, done: true };
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    return { deleted: snap.size, done: snap.size < 400 };
  },

  async get(db, p) {
    const key = L.normalizeKey(p.key);
    if (!key) throw new ApiError('BAD_REQUEST', 'Key không hợp lệ');
    const snap = await db.collection(COLLECTION).doc(key).get();
    if (!snap.exists) throw new ApiError('INVALID_KEY');
    return { key: L.describe(snap.data(), Date.now(), snap.id) };
  },

  async ban(db, p) {
    const keys = collectKeys(p);
    const reason = L.cleanText(p.reason, 200);
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
      hwid = L.normalizeHwid(p.hwid);
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
    const duration = L.parseDuration(p.duration);
    if (!duration || duration === 'lifetime') {
      throw new ApiError('BAD_REQUEST', 'duration phải là: hour, day, week, month hoặc year');
    }
    const quantity = p.quantity === undefined ? 1 : L.toInt(p.quantity, 1, 10000, 'quantity');
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
    if (p.maxDevices !== undefined) patch.maxDevices = L.toInt(p.maxDevices, 1, L.MAX_DEVICES_LIMIT, 'maxDevices');
    if (p.deviceLock !== undefined) patch.deviceLock = L.toBool(p.deviceLock, 'deviceLock');
    if (p.note !== undefined) patch.note = L.cleanText(p.note, 200);
    if (Object.keys(patch).length === 0) {
      throw new ApiError('BAD_REQUEST', 'Không có trường nào để sửa (tier, maxDevices, deviceLock, note)');
    }
    return mutate(db, keys, () => ({ updates: patch }));
  },
};

module.exports = async function handler(req, res) {
  // Không bật CORS cho admin: chỉ trang admin cùng domain gọi được từ trình duyệt
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return L.fail(res, 'METHOD_NOT_ALLOWED');
  }

  const secret = process.env.ADMIN_SECRET || '';
  if (secret.length < 16) {
    return L.fail(res, 'SERVER_ERROR', 'ADMIN_SECRET chưa được cấu hình (cần >= 16 ký tự, đúng tên biến ADMIN_SECRET)');
  }

  const given = providedSecret(req);
  if (!given || !L.safeEqual(given, secret)) {
    await L.sleep(400); // làm chậm dò mật khẩu
    return L.fail(res, 'UNAUTHORIZED');
  }

  try {
    const action = String((req.query && req.query.action) || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(actions, action)) {
      return L.fail(res, 'BAD_REQUEST', `Action không tồn tại: ${action.slice(0, 30)}`);
    }
    const params = { ...(req.query || {}), ...L.parseBody(req) };
    const result = await actions[action](L.getDb(), params);
    return L.ok(res, { action, ...result });
  } catch (err) {
    return L.handleError(res, err);
  }
};
