import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { availabilityIntentInstruction, requestsMediaCompletionNotice } from './gary-availability-intent';

describe('Gary availability intent', () => {
  it('captures acquisition requests that explicitly ask for completion notice', () => {
    assert.equal(requestsMediaCompletionNotice('Add Past Lives and let me know when you are done'), true);
    assert.equal(requestsMediaCompletionNotice('Please get X-Men and tell me once it is available'), true);
    assert.match(availabilityIntentInstruction('request Heat and ping me when it lands') || '', /availability watch/);
    assert.match(availabilityIntentInstruction('get Furious and let me know when you are done') || '', /preserve this intent through web research/i);
    assert.match(availabilityIntentInstruction("let me know when they're all done") || '', /every title in that batch/i);
  });

  it('does not turn ordinary requests or status questions into watches', () => {
    assert.equal(requestsMediaCompletionNotice('Add Past Lives'), false);
    assert.equal(requestsMediaCompletionNotice('Let me know what you think'), false);
    assert.equal(requestsMediaCompletionNotice('Is Past Lives available?'), false);
  });
});
