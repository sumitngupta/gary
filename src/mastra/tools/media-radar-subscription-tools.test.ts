import assert from 'node:assert/strict';
import test from 'node:test';
import { mediaRadarSchedulePrompt } from './media-radar-subscription-tools';
import { serverNamePattern } from '../config/branding';

test('scheduled radar prompt is bounded, read-only, and degrades gracefully', () => {
  const prompt = mediaRadarSchedulePrompt({ subscriptionId: 'radar_test', theme: 'Family movies', constraints: ['max age 10'], preferredGenres: ['Animation'], blockedGenres: ['Horror'], shortlistSize: 5 });
  assert.match(prompt, /one bounded discovery pass/i);
  assert.match(prompt, new RegExp(String.raw`one ${serverNamePattern()}-status call`, 'i'));
  assert.match(prompt, /smaller fully supported list/i);
  assert.match(prompt, /read-only except for that exact delivery record/i);
  assert.match(prompt, /do not request titles, create availability watches, or change profiles/i);
  assert.match(prompt, /Watch now, Requestable, or Upcoming/i);
});
