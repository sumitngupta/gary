import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  claimGaryNotificationDelivery,
  completeGaryNotificationDelivery,
  failGaryNotificationDelivery,
  deleteGaryNotificationDeliveries,
  listGaryNotificationDeliveries,
  resetGaryNotificationDeliveryStoreForTests,
  updateGaryNotificationReceipt,
} from './gary-notification-delivery-store';

test('notification deliveries are idempotent, receipt-aware, and isolated by owner', async () => {
  const path = await mkdtemp(join(tmpdir(), 'gary-delivery-'));
  const prior = process.env.GARY_DATA_DIR;
  process.env.GARY_DATA_DIR = path;
  resetGaryNotificationDeliveryStoreForTests();
  try {
    const input = { idempotencyKey: 'watch:one', resourceId: 'whatsapp:one', channel: 'whatsapp', kind: 'media.issue' as const, targetIds: ['watch-one'] };
    assert.equal((await claimGaryNotificationDelivery(input)).claimed, true);
    assert.equal((await claimGaryNotificationDelivery(input)).claimed, false);
    await completeGaryNotificationDelivery(input.idempotencyKey, 'wamid.one');
    assert.deepEqual(await updateGaryNotificationReceipt('wamid.one', 'delivered'), { updated: 1, targetIds: ['watch-one'] });
    assert.equal(String((await listGaryNotificationDeliveries('whatsapp:one'))[0].status), 'delivered');
    assert.equal((await listGaryNotificationDeliveries('whatsapp:two')).length, 0);
    assert.equal(await deleteGaryNotificationDeliveries('whatsapp:two'), 0);
    assert.equal((await listGaryNotificationDeliveries('whatsapp:one')).length, 1);

    const retryInput = { ...input, idempotencyKey: 'watch:retry' };
    assert.equal((await claimGaryNotificationDelivery(retryInput)).claimed, true);
    await failGaryNotificationDelivery(retryInput.idempotencyKey, 'temporary');
    assert.equal((await claimGaryNotificationDelivery(retryInput)).claimed, true);
  } finally {
    if (prior === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = prior;
    resetGaryNotificationDeliveryStoreForTests();
    await rm(path, { recursive: true, force: true });
  }
});
