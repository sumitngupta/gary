import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMediaAvailabilityWatch } from '../services/media-availability-watch-store';
import { claimGaryNotificationDelivery, failGaryNotificationDelivery, resetGaryNotificationDeliveryStoreForTests } from '../services/gary-notification-delivery-store';
import { inspectGaryRequestHistoryTool } from './inspect-gary-request-history-tool';

test('request history is owner-bound and excludes provider identifiers and raw errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-history-'));
  const env = { ...process.env };
  process.env.GARY_DATA_DIR = dir;
  process.env.GARY_MEDIA_WATCH_STORE_PATH = join(dir, 'watches.json');
  resetGaryNotificationDeliveryStoreForTests();
  try {
    const own = await createMediaAvailabilityWatch({ title: 'My Movie', mediaType: 'movie', requester: 'alice', resourceId: 'alice', threadId: 'alice', channel: 'whatsapp' });
    await createMediaAvailabilityWatch({ title: 'Private Movie', mediaType: 'movie', requester: 'bob', resourceId: 'bob', threadId: 'bob', channel: 'whatsapp' });
    await claimGaryNotificationDelivery({ idempotencyKey: 'private-key', resourceId: 'alice', channel: 'whatsapp', kind: 'media.available', targetIds: [own.watch.id] });
    await failGaryNotificationDelivery('private-key', 'secret-provider-error');
    const execute = inspectGaryRequestHistoryTool.execute!;
    assert.deepEqual((await execute({ limit: 10 }, { agent: {} } as any) as any).history, []);
    const result = await execute({ limit: 10 }, { agent: { resourceId: 'alice' } } as any) as any;
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].title, 'My Movie');
    assert.equal(result.history[0].notifications[0].status, 'failed');
    assert.ok(result.history[0].observedAvailableAt);
    assert.match(result.history[0].timingNote, /not exact/);
    assert.doesNotMatch(JSON.stringify(result), /Private Movie|private-key|secret-provider-error|resourceId|provider_message_id/);
    assert.equal((await execute({ title: 'Private Movie', limit: 10 }, { agent: { resourceId: 'alice' } } as any) as any).history.length, 0);
  } finally {
    resetGaryNotificationDeliveryStoreForTests(); process.env = env;
    await rm(dir, { recursive: true, force: true });
  }
});
