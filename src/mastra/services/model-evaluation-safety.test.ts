import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  assertModelEvaluationToolAllowed,
  modelEvaluationModeEnabled,
} from './model-evaluation-safety';

const originalMode = process.env.GARY_MODEL_EVALUATION_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.GARY_MODEL_EVALUATION_MODE;
  else process.env.GARY_MODEL_EVALUATION_MODE = originalMode;
});

test('evaluation mode allows only bounded read-only comparison tools', () => {
  process.env.GARY_MODEL_EVALUATION_MODE = 'true';
  assert.equal(modelEvaluationModeEnabled(), true);
  assert.doesNotThrow(() => assertModelEvaluationToolAllowed('webSearch'));
  assert.doesNotThrow(() => assertModelEvaluationToolAllowed('checkMediaStatuses'));
  assert.doesNotThrow(() => assertModelEvaluationToolAllowed('delegateToGaryMedia'));
});

test('evaluation mode blocks delivery and mutation tools', () => {
  process.env.GARY_MODEL_EVALUATION_MODE = 'true';
  assert.throws(
    () => assertModelEvaluationToolAllowed('sendGoogleWorkspaceEmail'),
    /blocked non-read-only tool/,
  );
  assert.throws(
    () => assertModelEvaluationToolAllowed('createMediaRequest'),
    /blocked non-read-only tool/,
  );
  assert.throws(
    () => assertModelEvaluationToolAllowed('codexBuild'),
    /blocked non-read-only tool/,
  );
});

test('production mode leaves the existing policy chain unchanged', () => {
  delete process.env.GARY_MODEL_EVALUATION_MODE;
  assert.equal(modelEvaluationModeEnabled(), false);
  assert.doesNotThrow(() => assertModelEvaluationToolAllowed('createMediaRequest'));
});

