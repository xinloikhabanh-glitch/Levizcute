'use strict';

const { getDb } = require('../lib/firebase');
const { verifyKey } = require('../lib/license');
const {
  ok,
  fail,
  handleError,
  parseBody,
  normalizeKey,
  normalizeHwid,
  setCors,
} = require('../lib/util');

/**
 * POST /api/verify
 * body: { key, hwid, deviceName? }
 */
module.exports = async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return fail(res, 'METHOD_NOT_ALLOWED');
  }

  try {
    const body = parseBody(req);

    const key = normalizeKey(body.key);
    if (!key) return fail(res, 'INVALID_KEY');

    let hwid = null;
    if (body.hwid !== undefined && body.hwid !== null && body.hwid !== '') {
      hwid = normalizeHwid(body.hwid);
      if (!hwid) return fail(res, 'BAD_REQUEST', 'hwid không hợp lệ (6-256 ký tự)');
    }

    const result = await verifyKey(getDb(), { key, hwid, deviceName: body.deviceName });
    if (result.error) return fail(res, result.error, undefined, result.extra);
    return ok(res, result.data);
  } catch (err) {
    return handleError(res, err);
  }
};
