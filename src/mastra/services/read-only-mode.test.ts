import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGaryConfig } from '../config/gary-config';
import { assertReadOnlyToolAllowed } from './read-only-mode';

const base = { SEERR_URL: 'http://seerr.test', SEERR_API_KEY: 'k', LLM_API_KEY: 'k' };

test('read-only mode allows lookups and refuses tools with side effects', () => {
  const config = parseGaryConfig({ ...base, GARY_READ_ONLY: 'true' });
  assert.equal(assertReadOnlyToolAllowed('checkMediaStatuses', config), undefined);
  assert.throws(
    () => assertReadOnlyToolAllowed('createMediaRequest', config),
    { message: 'Gary is running in read-only mode (GARY_READ_ONLY=true), so createMediaRequest is turned off.' },
  );
});

test('normal mode leaves every tool to the access policy', () => {
  assert.equal(assertReadOnlyToolAllowed('createMediaRequest', parseGaryConfig(base)), undefined);
});
