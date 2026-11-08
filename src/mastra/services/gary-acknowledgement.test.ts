import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isGaryAcknowledgementOnly } from './gary-acknowledgement';

describe('Gary acknowledgement routing', () => {
  it('recognizes standalone thanks without swallowing requests', () => {
    assert.equal(isGaryAcknowledgementOnly('Thanks!'), true);
    assert.equal(isGaryAcknowledgementOnly('Appreciate it.'), true);
    assert.equal(isGaryAcknowledgementOnly('Thanks, please request Letterkenny'), false);
  });
});

