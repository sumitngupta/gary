import assert from 'node:assert/strict';
import test from 'node:test';
import { isGaryHouseholdContextOwner } from './manage-gary-household-context-tool';

test('canonical household details remain owner-controlled', () => {
  const previous = process.env.GARY_MEDIA_OWNER_ACTORS;
  process.env.GARY_MEDIA_OWNER_ACTORS = '+1 555 000 0100';
  try {
    assert.equal(isGaryHouseholdContextOwner('admin-household'), true);
    assert.equal(isGaryHouseholdContextOwner('whatsapp:15550000100'), true);
    assert.equal(isGaryHouseholdContextOwner('whatsapp:15550000200'), false);
  } finally {
    if (previous === undefined) delete process.env.GARY_MEDIA_OWNER_ACTORS; else process.env.GARY_MEDIA_OWNER_ACTORS = previous;
  }
});
