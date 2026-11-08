import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { bearerMatches, secretMatches } from './secret-compare';

test('secret comparison matches only an exact, configured secret', () => {
  assert.deepEqual(
    [secretMatches('hook-secret', 'hook-secret'), secretMatches('hook-secre', 'hook-secret'), secretMatches('hook-secret!', 'hook-secret'), secretMatches(undefined, 'hook-secret'), secretMatches('', undefined), secretMatches('', '')],
    [true, false, false, false, false, false],
  );
  assert.deepEqual(
    [bearerMatches('Bearer admin-token', 'admin-token'), bearerMatches('bearer admin-token', 'admin-token'), bearerMatches('admin-token', 'admin-token'), bearerMatches(undefined, undefined)],
    [true, false, false, false],
  );
});

test('no source file compares a secret with === or !==', () => {
  const root = join(import.meta.dirname, '..');
  const offenders: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
    readFileSync(join(root, entry), 'utf8').split('\n').forEach((line, index) => {
      if (/[!=]==\s*`Bearer |`Bearer \$\{[^`]*`\s*[!=]==|[!=]==\s*expected\b|\bexpected\s*[!=]==/.test(line)) offenders.push(`${entry}:${index + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});
