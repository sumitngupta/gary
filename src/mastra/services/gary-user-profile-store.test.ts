import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  createGaryEscalation,
  deleteGaryUserProfile,
  dispositionGaryEscalation,
  ensureGaryUserProfile,
  getGaryUserProfile,
  isGaryOnboardingGreeting,
  resetGaryUserProfileStoreForTests,
  updateGaryUserProfile,
  extractGaryOnboardingName,
  extractExplicitGaryPreferenceOperation,
  extractExplicitGaryPreferenceUpdate,
  persistExplicitGaryPreferences,
} from './gary-user-profile-store';

async function isolated(run: () => Promise<void>) {
  const prior = process.env.GARY_DATA_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'gary-profile-'));
  process.env.GARY_DATA_DIR = dir;
  resetGaryUserProfileStoreForTests();
  try { await run(); } finally {
    resetGaryUserProfileStoreForTests();
    if (prior === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = prior;
    await rm(dir, { recursive: true, force: true });
  }
}

test('Gary profiles remain isolated and retain explicit onboarding preferences', async () => isolated(async () => {
  await ensureGaryUserProfile('whatsapp:111', 'introduced');
  await ensureGaryUserProfile('whatsapp:222', 'introduced');
  await updateGaryUserProfile('whatsapp:111', { preferredName: 'Dana', likes: ['clever mysteries'], dislikes: ['bleak horror'], onboardingState: 'profile-started' });
  const dana = await getGaryUserProfile('whatsapp:111');
  const other = await getGaryUserProfile('whatsapp:222');
  assert.equal(dana?.preferredName, 'Dana');
  assert.deepEqual(dana?.likes, ['clever mysteries']);
  assert.equal(other?.preferredName, undefined);
  assert.deepEqual(other?.likes, []);
}));

test('Gary supervisor escalations deduplicate only while open and can be raised again after disposition', async () => isolated(async () => {
  await ensureGaryUserProfile('whatsapp:111', 'settled');
  const first = await createGaryEscalation({ resourceId: 'whatsapp:111', requesterName: 'Dana', summary: 'Please add a capability', reason: 'unsupported', dedupeKey: 'same' });
  const duplicate = await createGaryEscalation({ resourceId: 'whatsapp:111', requesterName: 'Dana', summary: 'Please add a capability', reason: 'unsupported', dedupeKey: 'same' });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(await dispositionGaryEscalation(first.id!, 'resolved'), true);
  assert.equal(await dispositionGaryEscalation(first.id!, 'dismissed'), false);
  const recurrence = await createGaryEscalation({ resourceId: 'whatsapp:111', requesterName: 'Dana', summary: 'Please add a capability', reason: 'unsupported', dedupeKey: 'same' });
  assert.equal(recurrence.created, true);
  assert.equal(await deleteGaryUserProfile('whatsapp:111'), 3);
  assert.equal(await getGaryUserProfile('whatsapp:111'), undefined);
}));

test('extracts concise onboarding names without mistaking greetings or requests for names', () => {
  assert.equal(extractGaryOnboardingName('Dana'), 'Dana');
  assert.equal(extractGaryOnboardingName('My name is Frank'), 'Frank');
  assert.equal(extractGaryOnboardingName('call me Mary Jane'), 'Mary Jane');
  assert.equal(extractGaryOnboardingName('Hello'), undefined);
  assert.equal(extractGaryOnboardingName('find me a movie'), undefined);
});

test('recognizes greeting-only first contacts without swallowing substantive requests', () => {
  assert.equal(isGaryOnboardingGreeting('Hi'), true);
  assert.equal(isGaryOnboardingGreeting('Good evening!'), true);
  assert.equal(isGaryOnboardingGreeting('Hey, can you request Dune?'), false);
  assert.equal(isGaryOnboardingGreeting('Download Dune'), false);
});

test('extracts and verifies explicit lasting preferences from Erin-style messages', async () => isolated(async () => {
  assert.deepEqual(extractExplicitGaryPreferenceUpdate('The genres I like include: fantasy sci-fi, romantic comedy, dramas, sports'), {
    likes: ['fantasy sci-fi', 'romantic comedy', 'dramas', 'sports'], dislikes: [],
  });
  assert.deepEqual(extractExplicitGaryPreferenceUpdate('I generally do not like horror'), { likes: [], dislikes: ['horror'] });
  assert.deepEqual(extractExplicitGaryPreferenceUpdate("Remember that I like non U.S. movies"), { likes: ['non U.S. movies'], dislikes: [] });
  assert.deepEqual(extractExplicitGaryPreferenceUpdate('I also like Masterpiece Theater'), { likes: ['Masterpiece Theater'], dislikes: [] });
  assert.equal(extractExplicitGaryPreferenceUpdate('I also like this movie'), undefined);
  assert.equal(extractExplicitGaryPreferenceUpdate('Request Heat'), undefined);
  assert.equal(extractExplicitGaryPreferenceUpdate('I like this movie'), undefined);

  await persistExplicitGaryPreferences('whatsapp:111', 'Remember that I like science fiction and dramas');
  await persistExplicitGaryPreferences('whatsapp:111', 'I generally do not like horror');
  const profile = await getGaryUserProfile('whatsapp:111');
  assert.deepEqual(profile?.likes, ['science fiction', 'dramas']);
  assert.deepEqual(profile?.dislikes, ['horror']);
}));

test('deterministically adds, removes, replaces, clears, and records each source once', async () => isolated(async () => {
  assert.deepEqual(extractExplicitGaryPreferenceOperation('Never recommend graphic violence'), {
    action: 'add', field: 'contentBoundaries', values: ['graphic violence'],
  });
  await persistExplicitGaryPreferences('whatsapp:111', 'Remember that I like mysteries and sports', 'message-1');
  await persistExplicitGaryPreferences('whatsapp:111', 'Never recommend graphic violence', 'message-2');
  await persistExplicitGaryPreferences('whatsapp:111', 'Remove sports from my preferences', 'message-3');
  await persistExplicitGaryPreferences('whatsapp:111', 'Replace mysteries with historical dramas in my likes', 'message-4');
  await persistExplicitGaryPreferences('whatsapp:111', 'Add horror to my dislikes', 'message-5');
  await persistExplicitGaryPreferences('whatsapp:111', 'Add slashers to my dislikes', 'message-5');
  let profile = await getGaryUserProfile('whatsapp:111');
  assert.deepEqual(profile?.likes, ['historical dramas']);
  assert.deepEqual(profile?.dislikes, ['horror']);
  assert.deepEqual(profile?.contentBoundaries, ['graphic violence']);

  await persistExplicitGaryPreferences('whatsapp:111', 'Clear all my preferences', 'message-6');
  profile = await getGaryUserProfile('whatsapp:111');
  assert.deepEqual(profile?.likes, []);
  assert.deepEqual(profile?.dislikes, []);
  assert.deepEqual(profile?.contentBoundaries, []);
}));
