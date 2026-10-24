'use strict';

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

// Cho phép gõ tắt / nhiều cách viết
const DURATION_ALIASES = {
  h: 'hour', hr: 'hour', hour: 'hour', hours: 'hour', gio: 'hour',
  d: 'day', day: 'day', days: 'day', ngay: 'day',
  w: 'week', week: 'week', weeks: 'week', tuan: 'week',
  m: 'month', month: 'month', months: 'month', thang: 'month',
  y: 'year', year: 'year', years: 'year', nam: 'year',
  lifetime: 'lifetime', permanent: 'lifetime', forever: 'lifetime', vinhvien: 'lifetime',
};

module.exports = {
  DURATIONS,
  DURATION_ALIASES,
  TIERS: ['basic', 'premium'],
  COLLECTION: process.env.FIRESTORE_COLLECTION || 'license_keys',
  MAX_DEVICES_LIMIT: 100,
  MAX_CREATE_PER_REQUEST: 1000,
  MAX_TARGETS_PER_REQUEST: 500,
  // Chỉ ghi lastSeen lại sau khoảng này để tiết kiệm lượt ghi Firestore
  TOUCH_INTERVAL_MS: 5 * 60 * 1000,
};
