import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { cancelMediaAvailabilityWatches, createMediaAvailabilityWatch, deleteMediaAvailabilityWatchesForResource, listMediaAvailabilityWatches, reconcileMediaAvailabilityDeliveryReceipt, updateMediaAvailabilityWatch } from './media-availability-watch-store';

test('availability watch cancellation is isolated by resource and thread', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-watch-'));
  const previous = process.env.GARY_DATA_DIR;
  process.env.GARY_DATA_DIR = dir;
  try {
    const common = { title: 'Heat', mediaType: 'movie' as const, year: 1995, requester: 'test', channel: 'telegram' as const };
    await createMediaAvailabilityWatch({ ...common, resourceId: 'telegram:one', threadId: 'thread-one', correlationId: 'request-correlation' });
    await createMediaAvailabilityWatch({ ...common, resourceId: 'telegram:two', threadId: 'thread-two' });
    const cancelled = await cancelMediaAvailabilityWatches({ title: 'Heat', resourceId: 'telegram:one', threadId: 'thread-one' });
    assert.equal(cancelled.length, 1);
    const active = await listMediaAvailabilityWatches('active');
    assert.equal(active.length, 1);
    assert.equal(active[0].resourceId, 'telegram:two');
    assert.equal((await listMediaAvailabilityWatches()).find((watch) => watch.resourceId === 'telegram:one')?.correlationId, 'request-correlation');
    await deleteMediaAvailabilityWatchesForResource('telegram:two');
    assert.equal((await listMediaAvailabilityWatches()).length, 1);
    assert.equal((await listMediaAvailabilityWatches())[0].resourceId, 'telegram:one');
  } finally {
    if (previous === undefined) delete process.env.GARY_DATA_DIR;
    else process.env.GARY_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('WhatsApp receipts close delivered watches and reactivate failed watches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-watch-receipt-'));
  const previous = process.env.GARY_DATA_DIR;
  process.env.GARY_DATA_DIR = dir;
  try {
    const created = await createMediaAvailabilityWatch({ title: 'Labyrinth', mediaType: 'movie', year: 1986, requester: 'test', resourceId: 'whatsapp:one', threadId: 'thread-one', channel: 'whatsapp' });
    await updateMediaAvailabilityWatch(created.watch.id, { status: 'delivery-pending', dirty: false, lastWhatsAppMessageId: 'wamid.one' });
    assert.equal(await reconcileMediaAvailabilityDeliveryReceipt([created.watch.id], 'delivered', 'wamid.one'), 1);
    assert.equal((await listMediaAvailabilityWatches())[0]?.status, 'notified');

    const failed = await createMediaAvailabilityWatch({ title: 'Willow', mediaType: 'movie', year: 1988, requester: 'test', resourceId: 'whatsapp:one', threadId: 'thread-one', channel: 'whatsapp' });
    await updateMediaAvailabilityWatch(failed.watch.id, { status: 'delivery-pending', dirty: false, lastWhatsAppMessageId: 'wamid.two' });
    assert.equal(await reconcileMediaAvailabilityDeliveryReceipt([failed.watch.id], 'failed', 'wamid.two', '131047:Re-engagement message'), 1);
    const retriable = (await listMediaAvailabilityWatches()).find((watch) => watch.id === failed.watch.id);
    assert.equal(retriable?.status, 'active');
    assert.equal(retriable?.dirty, true);
  } finally {
    if (previous === undefined) delete process.env.GARY_DATA_DIR;
    else process.env.GARY_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('an explicit notification watch upgrades an internal lifecycle watch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-watch-channel-'));
  const previous = process.env.GARY_DATA_DIR;
  process.env.GARY_DATA_DIR = dir;
  try {
    const common = { title: 'Arrival', mediaType: 'movie' as const, year: 2016, requester: 'admin', resourceId: 'whatsapp:one', threadId: 'thread-one' };
    const internal = await createMediaAvailabilityWatch({ ...common, channel: 'none' });
    const explicit = await createMediaAvailabilityWatch({ ...common, channel: 'whatsapp', correlationId: 'wamid.explicit' });
    assert.equal(internal.created, true);
    assert.equal(explicit.created, false);
    assert.equal(explicit.watch.id, internal.watch.id);
    assert.equal(explicit.watch.channel, 'whatsapp');
    assert.equal(explicit.watch.correlationId, 'wamid.explicit');
  } finally {
    if (previous === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
