import assert from 'node:assert/strict';
import test from 'node:test';
import { buildGaryCandidateVerificationQuery, buildGaryTitleResearchQuery, titleResolutionYears } from './gary-title-resolution-workflow';

test('title resolution tries general release, festival year, then an unconstrained alias lookup', () => {
  assert.deepEqual(titleResolutionYears(2025, 2024), [2025, 2024, undefined]);
  assert.deepEqual(titleResolutionYears(2024, 2024), [2024, undefined]);
});

test('candidate verification query carries every Erin-style hard clue', () => {
  const query = buildGaryCandidateVerificationQuery('The Fall', { actors: ['Jamie Dornan', 'Gillian Anderson'], setting: 'Belfast', country: 'United Kingdom', language: 'English', requiredKeywords: ['murder mystery'] });
  assert.match(query, /"Jamie Dornan"/);
  assert.match(query, /"Gillian Anderson"/);
  assert.match(query, /setting "Belfast"/);
  assert.match(query, /"murder mystery"/);
});

test('automatic title research carries country, language, year, and aliases without asking the user to search', () => {
  const query = buildGaryTitleResearchQuery({ query: 'Fiume o morte!', country: 'Croatia', language: 'Croatian', festivalYear: 2025, year: 2026, aliases: ['Fiume or Death!'] });
  assert.match(query, /country "Croatia"/);
  assert.match(query, /language "Croatian"/);
  assert.match(query, /festival 2025/);
  assert.match(query, /general release 2026/);
  assert.match(query, /alias "Fiume or Death!"/);
  assert.match(query, /site:themoviedb\.org/);
});
