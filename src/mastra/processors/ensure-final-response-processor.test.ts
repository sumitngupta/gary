import assert from 'node:assert/strict';
import test from 'node:test';
import { EnsureFinalResponseProcessor } from './ensure-final-response-processor';

test('signals only on the final allowed model step', async () => {
  const processor = new EnsureFinalResponseProcessor(3);
  const signals: unknown[] = [];
  const args = (stepNumber: number) => ({
    stepNumber,
    sendSignal: async (signal: unknown) => { signals.push(signal); return {} as never; },
  }) as never;

  await processor.processInputStep(args(0));
  await processor.processInputStep(args(1));
  assert.equal(signals.length, 0);
  await processor.processInputStep(args(2));
  assert.equal(signals.length, 1);
  assert.match(JSON.stringify(signals[0]), /final step/i);
});
