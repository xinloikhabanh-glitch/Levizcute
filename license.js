'use strict';

const { COLLECTION, MAX_DEVICES_LIMIT, TOUCH_INTERVAL_MS } = require('./config');
const { cleanText } = require('./util');

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

// Dữ liệu trả về cho admin
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
 * Kiểm tra key + gắn thiết bị. Chạy trong transaction nên 2 máy gọi cùng lúc
 * không thể vượt quá maxDevices.
 * Trả về { error: CODE } hoặc { data: {...} }.
 */
async function verifyKey(db, { key, hwid, deviceName }) {
  const ref = db.collection(COLLECTION).doc(key);
  const name = cleanText(deviceName, 64) || null;

  return db.runTransaction(async (t) => {
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

module.exports = { verifyKey, describe, stateOf };
