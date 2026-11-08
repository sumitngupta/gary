import assert from 'node:assert/strict';
import test from 'node:test';
import { selectConstraintVerifiedGaryTitle } from './gary-title-constraint-verifier';

test('Erin-style interleaved clues resolve The Fall and reject The Tourist', () => {
  const result = selectConstraintVerifiedGaryTitle([
    { title: 'The Tourist', mediaType: 'tv', year: 2022, tmdbId: 120909, actors: ['Jamie Dornan', 'Danielle Macdonald'], countries: ['United Kingdom'], languages: ['English'], evidenceText: 'A man wakes in the Australian outback.' },
    { title: 'The Fall', mediaType: 'tv', year: 2013, tmdbId: 49010, actors: ['Gillian Anderson', 'Jamie Dornan'], countries: ['United Kingdom'], languages: ['English'], evidenceText: 'A police detective investigates a serial killer in Belfast in this crime mystery series.' },
  ], { mediaType: 'tv', actors: ['Jamie Dornan', 'Gillian Anderson'], setting: 'Belfast', requiredKeywords: ['mystery'] });
  assert.equal(result.status, 'resolved');
  assert.equal(result.candidate?.title, 'The Fall');
  const tourist = result.matrix.find((item) => item.candidate.title === 'The Tourist');
  assert.equal(tourist?.contradicted, true);
  assert.equal(tourist?.constraints.find((item) => item.value === 'Gillian Anderson')?.status, 'contradicted');
});

test('missing hard-clue evidence cannot become a confirmed match', () => {
  const result = selectConstraintVerifiedGaryTitle([
    { title: 'Possible Match', mediaType: 'tv', tmdbId: 1, actors: ['Actor One'], countries: [], languages: [], evidenceText: '' },
  ], { mediaType: 'tv', actors: ['Actor One'], setting: 'Belfast' });
  assert.equal(result.status, 'unverified');
  assert.equal(result.matrix[0].constraints.find((item) => item.constraint === 'setting')?.status, 'missing');
});
