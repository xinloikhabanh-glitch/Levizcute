'use strict';

const L = require('./_lib');

// POST /api/verify   body: { key, hwid, deviceName? }
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

    const key = L.normalizeKey(body.key);
    if (!key) return L.fail(res, 'INVALID_KEY');

    let hwid = null;
    if (body.hwid !== undefined && body.hwid !== null && body.hwid !== '') {
      hwid = L.normalizeHwid(body.hwid);
      if (!hwid) return L.fail(res, 'BAD_REQUEST', 'hwid không hợp lệ (6-256 ký tự)');
    }

    const result = await L.verifyKey(L.getDb(), { key, hwid, deviceName: body.deviceName });
    if (result.error) return L.fail(res, result.error, undefined, result.extra);
    return L.ok(res, result.data);
  } catch (err) {
    return L.handleError(res, err);
  }
};
