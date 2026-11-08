import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkViewingTitles, connectTautulliUser, disconnectViewingHistory, findTautulliUserMatches, getCompactViewingProfile, reconcileGaryViewingProfile, refreshViewingProfile, resetTautulliViewingForTests } from './tautulli-viewing-profile';

test('derives a bounded isolated taste profile and deterministic watched index', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gary-viewing-')); const priorDir = process.env.GARY_DATA_DIR; const priorKey = process.env.TAUTULLI_API_KEY; const priorFetch = globalThis.fetch;
  process.env.GARY_DATA_DIR = dir; process.env.TAUTULLI_API_KEY = 'test'; process.env.TAUTULLI_URL = 'http://tautulli.test'; resetTautulliViewingForTests();
  globalThis.fetch = (async (input) => {
    const cmd = new URL(String(input)).searchParams.get('cmd');
    const data = cmd === 'get_users'
      ? [{ user_id: 7, username: 'dana', friendly_name: 'Dana', keep_history: 1, is_active: 1 }]
      : cmd === 'get_history'
        ? { data: [{ user_id: 7, media_type: 'movie', title: 'Arrival', rating_key: 10, year: 2016, started: Math.floor(Date.now()/1000), percent_complete: 100, watched_status: 1 }, { user_id: 7, media_type: 'movie', title: 'Arrival', rating_key: 10, year: 2016, started: Math.floor(Date.now()/1000)-100, percent_complete: 100, watched_status: 1 }] }
        : { title: 'Arrival', year: 2016, media_type: 'movie', genres: ['Science Fiction', 'Drama'] };
    return new Response(JSON.stringify({ response: { result: 'success', data } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    assert.equal((await findTautulliUserMatches('Dan'))[0]?.username, 'dana');
    assert.equal((await connectTautulliUser('plex:dana', 'dana'))?.id, 7);
    const taste = await refreshViewingProfile('plex:dana'); assert.equal(taste.titlesAnalyzed, 1); assert.equal(taste.repeatTitles, 1); assert.equal(taste.strongGenres[0]?.name, 'Science Fiction');
    assert.equal((await reconcileGaryViewingProfile('whatsapp:1', 'Dana')).status, 'connected');
    assert.equal(await getCompactViewingProfile('plex:dana'), undefined);
    const watched = await checkViewingTitles('whatsapp:1', [{ title: 'Arrival', year: 2016 }, { title: 'Heat', year: 1995 }]); assert.equal(watched[0]?.watched, true); assert.equal(watched[1]?.watched, false);
    assert.equal(await getCompactViewingProfile('whatsapp:2'), undefined);
    assert.equal(await disconnectViewingHistory('whatsapp:1'), 2);
  } finally { globalThis.fetch = priorFetch; resetTautulliViewingForTests(); if (priorDir === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = priorDir; delete process.env.TAUTULLI_URL; if (priorKey === undefined) delete process.env.TAUTULLI_API_KEY; else process.env.TAUTULLI_API_KEY = priorKey; await rm(dir,{recursive:true,force:true}); }
});
