import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyGaryDelegatedUseCase,
  fleetEvaluationTelemetry,
  fleetModels,
  fleetProviderOptions,
  resolveFleetModel,
  resolveGaryFleetModel,
} from './fleet-model-policy';

test('keeps Luna as the baseline for unclassified and synthesis work', () => {
  assert.equal(resolveFleetModel(), fleetModels.default);
  assert.equal(resolveFleetModel('media-recommendation'), fleetModels.default);
  assert.equal(resolveFleetModel('media-taste-synthesis'), fleetModels.default);
});

test('exposes bounded usage only for isolated model evaluation identities', () => {
  assert.equal(fleetEvaluationTelemetry({
    result: { usage: { inputTokens: 10 } },
    resourceId: 'admin-household',
    threadId: 'gary-media',
    useCase: 'bounded-media-operation',
  }), undefined);
  assert.deepEqual(fleetEvaluationTelemetry({
    result: {
      usage: {
        inputTokens: 100.4,
        cachedInputTokens: 80,
        cacheCreationInputTokens: -5,
        outputTokens: 12,
        reasoningTokens: 0,
        totalTokens: 112,
        raw: { secret: 'excluded' },
      },
    },
    resourceId: 'model-eval:gary-status:run',
    threadId: 'model-eval:gary-status:run',
    useCase: 'bounded-media-operation',
  }), {
    model: fleetModels.efficient,
    useCase: 'bounded-media-operation',
    reasoningEffort: 'none',
    inputTokens: 100,
    cachedInputTokens: 80,
    cacheCreationInputTokens: 0,
    outputTokens: 12,
    reasoningTokens: 0,
    totalTokens: 112,
  });
});

test('uses Luna for bounded fleet work and every Gary Beta route', () => {
  assert.equal(resolveFleetModel('bounded-classification'), fleetModels.efficient);
  assert.equal(resolveFleetModel('bounded-home-conversation'), fleetModels.efficient);
  assert.equal(resolveFleetModel('bounded-media-operation'), fleetModels.efficient);
  assert.equal(resolveGaryFleetModel('bounded-media-operation'), fleetModels.gary);
  assert.equal(resolveGaryFleetModel('media-recommendation'), fleetModels.gary);
  assert.equal(resolveGaryFleetModel('media-taste-synthesis'), fleetModels.gary);
  assert.equal(resolveGaryFleetModel('default'), fleetModels.gary);
  assert.deepEqual(fleetProviderOptions(fleetModels.efficient), {
    openai: { reasoningEffort: 'none' },
  });
});

test('reports the actual Luna model for bounded Gary delegation evaluations', () => {
  assert.equal(fleetEvaluationTelemetry({
    result: {}, resourceId: 'model-eval:gary', threadId: 'model-eval:gary',
    useCase: 'bounded-media-operation', model: resolveGaryFleetModel('bounded-media-operation'),
  })?.model, fleetModels.gary);
});

test('reserves Terra for explicit complex escalation', () => {
  assert.equal(resolveFleetModel('complex-escalation'), fleetModels.balanced);
});

test('routes Gary conservatively by task shape', () => {
  assert.equal(classifyGaryDelegatedUseCase('Do we have The Fall Guy available?'), 'bounded-media-operation');
  assert.equal(classifyGaryDelegatedUseCase('Recommend four surprising movies based on my viewing history'), 'media-recommendation');
  assert.equal(classifyGaryDelegatedUseCase('Analyze my taste profile'), 'media-taste-synthesis');
  assert.equal(classifyGaryDelegatedUseCase('Why is this season stalled? Do a deep diagnostic'), 'default');
  assert.equal(classifyGaryDelegatedUseCase('Help me with media'), 'default');
});

test('preserves Gary reasoning effort independently of the efficient fleet model', () => {
  assert.deepEqual(fleetProviderOptions(fleetModels.gary), { openai: { reasoningEffort: 'none', ...(fleetModels.gary.startsWith('openai/gpt-6') ? { forceReasoning: true } : {}) } });
});
