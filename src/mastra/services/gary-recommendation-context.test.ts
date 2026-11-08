import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resetGaryUserProfileStoreForTests, updateGaryUserProfile } from './gary-user-profile-store';
import { getGaryRecommendationContext } from './gary-recommendation-context';
import { resetGaryHouseholdContextStoreForTests, updateGaryHouseholdContext } from './gary-household-context-store';

test('recommendation context combines household safety with isolated personal taste', async () => {
  const previous = process.env.GARY_DATA_DIR; const path = await mkdtemp(join(tmpdir(), 'gary-context-'));
  process.env.GARY_DATA_DIR = path; resetGaryUserProfileStoreForTests(); resetGaryHouseholdContextStoreForTests();
  try {
    await updateGaryUserProfile('admin-household', { dislikes: ['horror'], contentBoundaries: ['no graphic violence'] });
    await updateGaryHouseholdContext({ viewerAges: [8, 12, 42], sharedLikes: ['adventure'], contentBoundaries: ['no sexual violence'], intensityPolicy: 'Always identify scary or intense material using source evidence.' });
    await updateGaryUserProfile('whatsapp:erin', { likes: ['romantic comedy'], dislikes: ['reality TV'] });
    assert.deepEqual(await getGaryRecommendationContext('whatsapp:erin'), { personalLikes: ['romantic comedy'], personalDislikes: ['reality TV', 'horror'], contentBoundaries: ['no sexual violence', 'no graphic violence'], viewerAges: [8, 12, 42], sharedLikes: ['adventure'], intensityPolicy: 'Always identify scary or intense material using source evidence.', viewingSignals: undefined });
  } finally { resetGaryUserProfileStoreForTests(); resetGaryHouseholdContextStoreForTests(); if (previous === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = previous; await rm(path, { recursive: true, force: true }); }
});
