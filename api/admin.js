'use strict';

const L = require('./_lib');
const { ApiError, DURATIONS, TIERS, COLLECTION } = L;
const admin_FieldPath = () => require('firebase-admin').firestore.FieldPath;

// POST /api/admin?action=<health|create|list|stats|purge|events|config-get|config-set|gen-signing-key|shop-get|shop-set|orders|order-approve|order-reject|get|ban|unban|delete|reset-devices|extend|update>
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

  // Nhật ký hoạt động (kích hoạt, thiết bị mới, bị từ chối...). Phân trang giống "list".
  async events(db, p) {
    const limit = p.limit === undefined ? 100 : L.toInt(p.limit, 1, 500, 'limit');
    let q = db
      .collection(L.EVENTS_COLLECTION)
      .orderBy('createdAt', 'desc')
      .orderBy(admin_FieldPath().documentId(), 'desc');
    if (p.after && typeof p.after === 'object' && p.after.id) {
      const at = Number(p.after.createdAt);
      if (!Number.isFinite(at) || typeof p.after.id !== 'string') throw new ApiError('BAD_REQUEST', 'after không hợp lệ');
      q = q.startAfter(at, p.after.id);
    }
    const snap = await q.limit(limit).get();
    const events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const last = events[events.length - 1];
    const next = events.length === limit && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { count: events.length, events, next };
  },

  async 'config-get'(db) {
    return { config: await L.getConfig(db, true), signing: L.signingEnabled() };
  },

  // Công tắc khẩn cấp: bảo trì, bắt buộc cập nhật, thông báo
  async 'config-set'(db, p) {
    const cur = await L.getConfig(db, true);
    const next = { ...cur };
    if (p.maintenance !== undefined) next.maintenance = L.toBool(p.maintenance, 'maintenance');
    if (p.maintenanceMessage !== undefined) next.maintenanceMessage = L.cleanText(p.maintenanceMessage, 200);
    if (p.minVersion !== undefined) {
      const v = L.cleanText(p.minVersion, 20);
      if (v && !/^\d+(\.\d+){0,3}$/.test(v)) throw new ApiError('BAD_REQUEST', 'minVersion dạng 1.2.3');
      next.minVersion = v;
    }
    if (p.latestVersion !== undefined) {
      const v = L.cleanText(p.latestVersion, 20);
      if (v && !/^\d+(\.\d+){0,3}$/.test(v)) throw new ApiError('BAD_REQUEST', 'latestVersion dạng 1.2.3');
      next.latestVersion = v;
    }
    if (p.updateUrl !== undefined) {
      const u = L.cleanText(p.updateUrl, 300);
      if (u && !/^https:\/\//i.test(u)) throw new ApiError('BAD_REQUEST', 'updateUrl phải bắt đầu bằng https://');
      next.updateUrl = u;
    }
    if (p.announcement !== undefined) next.announcement = L.cleanText(p.announcement, 300);
    await db.collection(L.META_COLLECTION).doc('app').set(next);
    L.setConfigCache(next);
    return { config: next };
  },

  // Tạo cặp khoá ES256 để ký phản hồi. KHÔNG lưu ở server: bạn tự dán vào Vercel.
  async 'gen-signing-key'() {
    const k = L.generateSigningKeyPair();
    return {
      publicKey: k.publicKey,
      privateKeyBase64: k.privateKeyBase64,
      note: 'Dán privateKeyBase64 vào biến môi trường SIGNING_PRIVATE_KEY trên Vercel rồi Redeploy. publicKey dán vào app/trang web để kiểm tra chữ ký.',
    };
  },

  // ===== Cửa hàng web =====
  async 'shop-get'(db) {
    return { shop: await require('./_shop').getShop(db) };
  },
  async 'shop-set'(db, p) {
    return { shop: await require('./_shop').setShop(db, p) };
  },
  // status: claimed (chờ duyệt) | pending | approved | rejected | all
  async orders(db, p) {
    return require('./_shop').listOrders(db, String(p.status || 'claimed'));
  },
  async 'order-approve'(db, p) {
    const r = await require('./_shop').approveOrder(db, String(p.id || ''));
    if (r.err) throw new ApiError('BAD_REQUEST', r.err);
    return { key: r.key };
  },
  async 'order-reject'(db, p) {
    const r = await require('./_shop').rejectOrder(db, String(p.id || ''));
    if (r.err) throw new ApiError('BAD_REQUEST', r.err);
    return { rejected: true };
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

// Kiểm tra cấu hình (không cần mật khẩu, chỉ trả true/false, không lộ bí mật)
async function health() {
  const out = {
    api: '2.0',
    node: process.version,
    adminSecretSet: (process.env.ADMIN_SECRET || '').length >= 16,
    firebaseConfigured: false,
    firestoreReachable: false,
    signingKey: L.signingEnabled(),
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
  };
  try {
    const db = L.getDb();
    out.firebaseConfigured = true;
    await Promise.race([
      db.collection(L.META_COLLECTION).doc('app').get(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    out.firestoreReachable = true;
  } catch (e) {
    out.error = String(e && e.message ? e.message : e).slice(0, 160);
  }
  return out;
}

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

  const action = String((req.query && req.query.action) || '').toLowerCase();
  if (action === 'health') {
    try {
      return L.ok(res, { action, ...(await health()) });
    } catch (err) {
      return L.handleError(res, err);
    }
  }

  const secret = process.env.ADMIN_SECRET || '';
  if (secret.length < 16) {
    return L.fail(res, 'SERVER_ERROR', 'ADMIN_SECRET chưa được cấu hình (cần >= 16 ký tự, đúng tên biến ADMIN_SECRET)');
  }

  // Chặn dò mật khẩu: sai 8 lần trong 10 phút => khoá IP 15 phút
  let db = null;
  const ip = L.clientIp(req);
  try { db = L.getDb(); } catch (e) { db = null; }
  let hadFails = false;
  if (db) {
    try {
      const rc = await L.rateCheck(db, 'admin', ip);
      if (rc.locked) {
        res.setHeader('Retry-After', String(rc.retryAfterSec));
        return L.fail(res, 'RATE_LIMITED', `Nhập sai quá nhiều lần. Thử lại sau ${Math.ceil(rc.retryAfterSec / 60)} phút.`);
      }
      hadFails = rc.fails > 0;
    } catch (e) {
      console.error(e);
    }
  }

  const given = providedSecret(req);
  if (!given || !L.safeEqual(given, secret)) {
    if (db) { try { await L.rateFail(db, 'admin', ip); } catch (e) { console.error(e); } }
    await L.sleep(400); // làm chậm dò mật khẩu
    return L.fail(res, 'UNAUTHORIZED');
  }
  if (db && hadFails) { try { await L.rateClear(db, 'admin', ip); } catch (e) { /* ignore */ } }

  try {
    if (!Object.prototype.hasOwnProperty.call(actions, action)) {
      return L.fail(res, 'BAD_REQUEST', `Action không tồn tại: ${action.slice(0, 30)}`);
    }
    const params = { ...(req.query || {}), ...L.parseBody(req) };
    const h = req.headers || {};
    params.__host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim();
    const result = await actions[action](L.getDb(), params);
    return L.ok(res, { action, ...result });
  } catch (err) {
    return L.handleError(res, err);
  }
};
module.exports.actions = actions;
