import assert from 'node:assert/strict';
import test from 'node:test';
import { KeyedTaskQueue } from './keyed-task-queue';

test('serializes tasks with the same key', async () => {
  const queue = new KeyedTaskQueue();
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

  const first = queue.run('telegram:one', async () => {
    events.push('first-start');
    await firstGate;
    events.push('first-end');
  });
  const second = queue.run('telegram:one', async () => {
    events.push('second-start');
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['first-start']);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'first-end', 'second-start']);
  assert.equal(queue.hasPending('telegram:one'), false);
});

test('does not block a different key and continues after failures', async () => {
  const queue = new KeyedTaskQueue();
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => { releaseFailure = resolve; });
  let otherRan = false;

  const failure = queue.run('telegram:one', async () => {
    await failureGate;
    throw new Error('expected');
  });
  const recovery = queue.run('telegram:one', async () => 'recovered');
  await queue.run('telegram:two', async () => { otherRan = true; });

  assert.equal(otherRan, true);
  releaseFailure();
  await assert.rejects(failure, /expected/);
  assert.equal(await recovery, 'recovered');
});
