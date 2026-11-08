import assert from 'node:assert/strict';
import test from 'node:test';
import { qualityIntentInstruction } from './gary-quality-intent';

test('does not silently strengthen 4K plus Atmos to Dolby Vision', () => {
  const instruction = qualityIntentInstruction('get Top Gun Maverick in 4K with Atmos') || '';
  assert.match(instruction, /did not request Dolby Vision/);
  assert.doesNotMatch(instruction, /Use qualityObjective "4k-dv-atmos-hard"/);
});

test('allows the strict objective only when all three constraints are explicit', () => {
  assert.match(qualityIntentInstruction('4K Dolby Vision with Atmos') || '', /Use qualityObjective "4k-dv-atmos-hard"/);
});

test('soft wording never becomes a hard acquisition profile', () => {
  for (const text of ['I prefer 4K Dolby Vision Atmos', 'not a hard requirement. Very very very strong preference.', '4K Dolby Vision Atmos if available']) {
    assert.match(qualityIntentInstruction(text) || '', /soft quality preference/);
    assert.doesNotMatch(qualityIntentInstruction(text) || '', /Use qualityObjective "4k-dv-atmos-hard"/);
  }
});

test('preference wording without any quality term adds no quality instruction', () => {
  for (const text of ['I prefer comedies', 'Get Paddington 2 if available', 'Whatever is the best available Bond movie']) {
    assert.equal(qualityIntentInstruction(text), undefined);
  }
});
