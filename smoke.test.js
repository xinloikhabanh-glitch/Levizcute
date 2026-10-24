'use strict';
// Chạy: node test/smoke.test.js  (dùng Firestore giả lập trong bộ nhớ, không cần Firebase thật)

const assert = require('node:assert/strict');

process.env.ADMIN_SECRET = 'test-secret-1234567890';

// ---------- Firestore giả ----------
const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

class FakeDb {
  constructor() { this.cols = new Map(); }
  store(name) {
    if (!this.cols.has(name)) this.cols.set(name, new Map());
    return this.cols.get(name);
  }
  collection(name) {
    const store = this.store(name);
    return {
      doc: (id) => ({ id, store, get: async () => this.snap({ id, store }) }),
      orderBy: (field, dir) => ({
        limit: (n) => ({
          get: async () => {
            const docs = [...store.entries()]
              .filter(([, v]) => v[field] !== undefined)
              .sort((a, b) => (dir === 'desc' ? b[1][field] - a[1][field] : a[1][field] - b[1][field]))
              .slice(0, n);
            return { docs: docs.map(([id, v]) => ({ id, data: () => clone(v) })) };
          },
        }),
      }),
    };
  }
  snap(ref) {
    const v = ref.store.get(ref.id);
    return { exists: v !== undefined, id: ref.id, data: () => clone(v) };
  }
  batch() {
    const ops = [];
    return {
      create: (ref, d) => ops.push(() => {
        if (ref.store.has(ref.id)) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
        ref.store.set(ref.id, clone(d));
      }),
      commit: async () => { ops.forEach((o) => o()); },
    };
  }
  async runTransaction(fn) {
    const ops = [];
    const t = {
      get: async (ref) => this.snap(ref),
      getAll: async (...refs) => refs.map((r) => this.snap(r)),
      update: (ref, u) => ops.push(() => {
        if (!ref.store.has(ref.id)) throw new Error('NOT_FOUND');
        ref.store.set(ref.id, { ...ref.store.get(ref.id), ...clone(u) });
      }),
      delete: (ref) => ops.push(() => ref.store.delete(ref.id)),
    };
    const result = await fn(t);
    ops.forEach((o) => o());
    return result;
  }
}

const fake = new FakeDb();
const fbPath = require.resolve('../lib/firebase');
require.cache[fbPath] = { id: fbPath, filename: fbPath, loaded: true, exports: { getDb: () => fake } };

const verify = require('../api/verify');
const admin = require('../api/admin/[action]');
const { COLLECTION } = require('../lib/config');

// ---------- helpers ----------
function call(handler, { method = 'POST', headers = {}, query = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(b) { resolve({ status: this.statusCode, headers: this.headers, json: b ? JSON.parse(b) : null }); },
    };
    Promise.resolve(handler({ method, headers, query, body }, res)).catch(reject);
  });
}
const A = (action, body, secret = process.env.ADMIN_SECRET) =>
  call(admin, { query: { action }, headers: { 'x-admin-secret': secret }, body });
const V = (body) => call(verify, { body });
const DAY = 86400000;
const stored = (key) => fake.store(COLLECTION).get(key);

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n', e); process.exitCode = 1; }
}

(async () => {
  await t('admin: sai secret => 401, thiếu secret => 401', async () => {
    assert.equal((await A('list', {}, 'sai-secret-sai-secret')).status, 401);
    assert.equal((await call(admin, { query: { action: 'list' }, body: {} })).status, 401);
  });

  await t('admin: tham số sai => 400', async () => {
    assert.equal((await A('create', { tier: 'gold', duration: 'day' })).status, 400);
    assert.equal((await A('create', { tier: 'basic', duration: 'decade' })).status, 400);
    assert.equal((await A('create', { tier: 'basic', duration: 'day', count: 1001 })).status, 400);
    assert.equal((await A('create', { tier: 'basic', duration: 'day', maxDevices: 0 })).status, 400);
    assert.equal((await A('nope', {})).status, 400);
    assert.equal((await A('constructor', {})).status, 400);
  });

  let premKeys;
  await t('admin: tạo 3 key premium 1 ngày, 2 thiết bị', async () => {
    const r = await A('create', { tier: 'premium', duration: 'day', count: 3, maxDevices: 2, note: 'khách A' });
    assert.equal(r.status, 200);
    assert.equal(r.json.keys.length, 3);
    assert.equal(new Set(r.json.keys).size, 3);
    assert.match(r.json.keys[0], /^PREM(-[A-Z2-9]{4}){4}$/);
    premKeys = r.json.keys;
    assert.equal(stored(premKeys[0]).activatedAt, null);
    assert.equal(stored(premKeys[0]).durationMs, DAY);
  });

  await t('verify: kích hoạt + gắn máy A, thời hạn tính từ lần đầu', async () => {
    const r = await V({ key: premKeys[0].toLowerCase(), hwid: 'HWID-AAAAAA', deviceName: 'PC-A' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.tier, 'premium');
    assert.equal(r.json.devicesUsed, 1);
    assert.equal(r.json.lifetime, false);
    assert.ok(Math.abs(r.json.expiresAt - (Date.now() + DAY)) < 5000);
  });

  await t('verify: máy B ok, máy C bị DEVICE_LIMIT, máy A gọi lại vẫn ok', async () => {
    assert.equal((await V({ key: premKeys[0], hwid: 'HWID-BBBBBB' })).json.devicesUsed, 2);
    const c = await V({ key: premKeys[0], hwid: 'HWID-CCCCCC' });
    assert.equal(c.status, 403);
    assert.equal(c.json.error, 'DEVICE_LIMIT');
    const a = await V({ key: premKeys[0], hwid: 'HWID-AAAAAA' });
    assert.equal(a.status, 200);
    assert.equal(a.json.devicesUsed, 2);
  });

  await t('verify: 4 máy mới lần lượt vào key 2 máy => chỉ 2 máy được gắn', async () => {
    const k = premKeys[1];
    const rs = [];
    for (const h of ['HW-111111', 'HW-222222', 'HW-333333', 'HW-444444']) rs.push(await V({ key: k, hwid: h }));
    assert.deepEqual(rs.map((x) => x.status), [200, 200, 403, 403]);
    assert.equal(stored(k).devices.length, 2);
  });

  await t('verify: thiếu hwid => HWID_REQUIRED và KHÔNG kích hoạt key', async () => {
    const k = premKeys[2];
    const r = await V({ key: k });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'HWID_REQUIRED');
    assert.equal(stored(k).activatedAt, null);
  });

  await t('verify: key sai / sai định dạng / hwid ngắn / sai method', async () => {
    assert.equal((await V({ key: 'PREM-AAAA-BBBB-CCCC-DDDD', hwid: 'HWID-AAAAAA' })).json.error, 'INVALID_KEY');
    assert.equal((await V({ key: '../etc/passwd', hwid: 'HWID-AAAAAA' })).json.error, 'INVALID_KEY');
    assert.equal((await V({ key: premKeys[2], hwid: 'x' })).json.error, 'BAD_REQUEST');
    assert.equal((await call(verify, { method: 'GET' })).status, 405);
    const o = await call(verify, { method: 'OPTIONS' });
    assert.equal(o.status, 204);
    assert.equal(o.headers['access-control-allow-origin'], '*');
  });

  await t('ban / unban', async () => {
    const k = premKeys[0];
    const b = await A('ban', { key: k, reason: 'test' });
    assert.equal(b.json.updated, 1);
    assert.equal((await V({ key: k, hwid: 'HWID-AAAAAA' })).json.error, 'KEY_BANNED');
    await A('unban', { key: k });
    assert.equal((await V({ key: k, hwid: 'HWID-AAAAAA' })).status, 200);
  });

  await t('extend: cộng thêm 2 ngày; key hết hạn => tính từ bây giờ', async () => {
    const k = premKeys[0];
    const before = stored(k).expiresAt;
    await A('extend', { key: k, duration: 'day', quantity: 2 });
    assert.equal(stored(k).expiresAt, before + 2 * DAY);

    fake.store(COLLECTION).get(k).expiresAt = Date.now() - 1000; // ép hết hạn
    assert.equal((await V({ key: k, hwid: 'HWID-AAAAAA' })).json.error, 'KEY_EXPIRED');
    await A('extend', { key: k, duration: 'hour', quantity: 5 });
    const r = await V({ key: k, hwid: 'HWID-AAAAAA' });
    assert.equal(r.status, 200);
    assert.ok(Math.abs(stored(k).expiresAt - (Date.now() + 5 * 3600000)) < 5000);
  });

  await t('extend: key chưa kích hoạt cộng vào durationMs', async () => {
    const c = await A('create', { tier: 'basic', duration: 'week', count: 1 });
    const k = c.json.keys[0];
    assert.match(k, /^BASIC-/);
    await A('extend', { key: k, duration: 'week', quantity: 1 });
    assert.equal(stored(k).durationMs, 14 * DAY);
  });

  await t('lifetime: không hết hạn, không extend được', async () => {
    const c = await A('create', { tier: 'premium', duration: 'lifetime', count: 1, maxDevices: 1 });
    const k = c.json.keys[0];
    const r = await V({ key: k, hwid: 'HWID-LIFETIME' });
    assert.equal(r.json.lifetime, true);
    assert.equal(r.json.expiresAt, null);
    assert.equal(r.json.remainingMs, null);
    const e = await A('extend', { key: k, duration: 'day', quantity: 1 });
    assert.equal(e.json.updated, 0);
    assert.equal(e.json.errors[k], 'LIFETIME_KEY');
  });

  await t('reset-devices: gỡ 1 máy rồi máy mới vào được', async () => {
    const k = premKeys[0]; // đang có A, B
    assert.equal((await V({ key: k, hwid: 'HWID-CCCCCC' })).json.error, 'DEVICE_LIMIT');
    await A('reset-devices', { key: k, hwid: 'HWID-BBBBBB' });
    assert.equal(stored(k).devices.length, 1);
    assert.equal((await V({ key: k, hwid: 'HWID-CCCCCC' })).status, 200);
    await A('reset-devices', { key: k });
    assert.equal(stored(k).devices.length, 0);
  });

  await t('deviceLock=false: không cần hwid, không gắn máy', async () => {
    const c = await A('create', { tier: 'basic', duration: 'hour', count: 1, deviceLock: false });
    const k = c.json.keys[0];
    const r = await V({ key: k });
    assert.equal(r.status, 200);
    assert.equal(r.json.deviceLock, false);
    assert.equal(stored(k).devices.length, 0);
  });

  await t('update: đổi tier + maxDevices', async () => {
    const k = premKeys[2];
    await A('update', { key: k, tier: 'basic', maxDevices: 3, note: 'đã sửa' });
    assert.equal(stored(k).tier, 'basic');
    assert.equal(stored(k).maxDevices, 3);
    assert.equal((await A('update', { key: k })).status, 400);
  });

  await t('list / get / delete (bulk, key không tồn tại)', async () => {
    const l = await A('list', { limit: 100 });
    assert.equal(l.status, 200);
    assert.ok(l.json.keys.length >= 6);
    assert.ok(['unused', 'active', 'expired', 'banned'].includes(l.json.keys[0].state));

    const g = await A('get', { key: premKeys[0] });
    assert.equal(g.json.key.key, premKeys[0]);

    const d = await A('delete', { keys: [premKeys[0], premKeys[1], 'PREM-ZZZZ-ZZZZ-ZZZZ-ZZZZ'] });
    assert.equal(d.json.updated, 2);
    assert.deepEqual(d.json.notFound, ['PREM-ZZZZ-ZZZZ-ZZZZ-ZZZZ']);
    assert.equal((await V({ key: premKeys[0], hwid: 'HWID-AAAAAA' })).json.error, 'INVALID_KEY');
  });

  await t('create: 1000 key, không trùng', async () => {
    const r = await A('create', { tier: 'basic', duration: 'month', count: 1000 });
    assert.equal(r.status, 200);
    assert.equal(new Set(r.json.keys).size, 1000);
  });

  console.log(`\n${passed} test đạt` + (process.exitCode ? ', CÓ TEST LỖI' : ''));
})();
