import assert from 'node:assert/strict';
import test from 'node:test';
import { isAuthorized } from './media-availability-watch';

test('media-event routes stay closed until GARY_MEDIA_EVENTS_TOKEN is set', (t) => {
  t.after(() => { delete process.env.GARY_MEDIA_EVENTS_TOKEN; });
  delete process.env.GARY_MEDIA_EVENTS_TOKEN;
  assert.equal(isAuthorized(undefined, undefined), false);
  process.env.GARY_MEDIA_EVENTS_TOKEN = 'hook-secret';
  assert.equal(isAuthorized('Bearer hook-secret', undefined), true);
  assert.equal(isAuthorized(undefined, 'hook-secret'), true);
  assert.equal(isAuthorized('Bearer wrong', 'wrong'), false);
});
