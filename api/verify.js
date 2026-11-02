'use strict';

const L = require('./_lib');

// POST /api/verify   body: { key, hwid, deviceName?, nonce?, appVersion? }
module.exports = async function handler(req, res) {
  L.setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return L.fail(res, 'METHOD_NOT_ALLOWED');
  }

  try {
    const body = L.parseBody(req);
    const db = L.getDb();

    // Công tắc khẩn cấp: bảo trì / bắt buộc cập nhật
    const cfg = await L.getConfig(db);
    if (cfg.maintenance) {
      return L.fail(res, 'MAINTENANCE', cfg.maintenanceMessage || undefined);
    }
    if (cfg.minVersion && typeof body.appVersion === 'string' && L.cmpVersion(body.appVersion, cfg.minVersion) < 0) {
      return L.fail(res, 'UPDATE_REQUIRED', undefined, { minVersion: cfg.minVersion, updateUrl: cfg.updateUrl || '' });
    }

    const key = L.normalizeKey(body.key);
    if (!key) return L.fail(res, 'INVALID_KEY');

    let hwid = null;
    if (body.hwid !== undefined && body.hwid !== null && body.hwid !== '') {
      hwid = L.normalizeHwid(body.hwid);
      if (!hwid) return L.fail(res, 'BAD_REQUEST', 'hwid không hợp lệ (6-256 ký tự)');
    }
    const nonce = typeof body.nonce === 'string' ? body.nonce.slice(0, 64) : '';

    const result = await L.verifyKey(db, { key, hwid, deviceName: body.deviceName });
    await L.logEvents(db, req, result, { key, hwid, deviceName: body.deviceName });
    if (result.error) return L.fail(res, result.error, undefined, result.extra);

    const data = {
      ...result.data,
      latestVersion: cfg.latestVersion || '',
      updateUrl: cfg.updateUrl || '',
      announcement: cfg.announcement || '',
    };
    if (nonce) data.nonce = nonce;
    const sig = L.signMessage(L.sigString(data, nonce));
    if (sig) {
      data.sig = sig;
      data.sigAlg = 'ES256';
    }
    return L.ok(res, data);
  } catch (err) {
    return L.handleError(res, err);
  }
};
