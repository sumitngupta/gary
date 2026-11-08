import assert from 'node:assert/strict';
import test from 'node:test';
import { isMediaRadarQuietTime } from './media-radar-notification-service';

test('media radar quiet hours handle same-day and overnight windows', () => {
  const noonUtc = new Date('2026-07-15T12:00:00.000Z');
  assert.equal(isMediaRadarQuietTime({ timezone: 'Etc/UTC', quietHours: { start: '09:00', end: '17:00' } }, noonUtc), true);
  assert.equal(isMediaRadarQuietTime({ timezone: 'Etc/UTC', quietHours: { start: '22:00', end: '07:00' } }, noonUtc), false);
  const lateUtc = new Date('2026-07-15T23:00:00.000Z');
  assert.equal(isMediaRadarQuietTime({ timezone: 'Etc/UTC', quietHours: { start: '22:00', end: '07:00' } }, lateUtc), true);
});
