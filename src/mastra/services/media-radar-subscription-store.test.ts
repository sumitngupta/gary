import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createMediaRadarSubscription, listMediaRadarSubscriptions, recordMediaRadarCandidates, updateMediaRadarSubscription } from './media-radar-subscription-store';

test('media radar subscriptions persist lifecycle and deduplicated recommendation history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-radar-'));
  const previous = process.env.GARY_DATA_DIR;
  process.env.GARY_DATA_DIR = dir;
  try {
    const created = await createMediaRadarSubscription({
      scheduleId: 'agent_radar_test', name: 'Friday sci-fi', requester: 'Alice', resourceId: 'telegram:123', threadId: 'thread-1', channel: 'telegram', theme: 'new science-fiction movies', cron: '0 18 * * 5', timezone: 'America/New_York', preferredGenres: ['science fiction'], blockedGenres: [], constraints: ['not too grim'], shortlistSize: 5,
    });
    await recordMediaRadarCandidates(created.id, [{ title: 'Example', year: 2026 }, { title: 'Example', year: 2026 }]);
    const paused = await updateMediaRadarSubscription(created.id, { status: 'paused' });
    const listed = await listMediaRadarSubscriptions({ resourceId: 'telegram:123' });
    const otherUser = await listMediaRadarSubscriptions({ resourceId: 'telegram:456' });
    assert.equal(paused?.status, 'paused');
    assert.equal(listed.length, 1);
    assert.equal(listed[0].surfaced.length, 1);
    assert.equal(listed[0].surfaced[0].title, 'Example');
    assert.equal(otherUser.length, 0);
  } finally {
    if (previous === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
