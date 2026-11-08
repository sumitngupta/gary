import assert from 'node:assert/strict';
import test from 'node:test';
import { adminName, serverName, serverNamePattern, serverNameTitle } from './branding';

test('branding falls back to generic names when unset', (t) => {
  t.after(() => { delete process.env.GARY_SERVER_NAME; delete process.env.GARY_ADMIN_NAME; });
  delete process.env.GARY_SERVER_NAME;
  delete process.env.GARY_ADMIN_NAME;
  assert.equal(serverName(), 'the media server');
  assert.equal(serverNameTitle(), 'The media server');
  assert.equal(adminName(), 'the admin');
});

test('branding uses configured names and escapes the server name for patterns', (t) => {
  t.after(() => { delete process.env.GARY_SERVER_NAME; delete process.env.GARY_ADMIN_NAME; });
  process.env.GARY_SERVER_NAME = ' Movie Night (Home) ';
  process.env.GARY_ADMIN_NAME = 'Alice';
  assert.equal(serverName(), 'Movie Night (Home)');
  assert.equal(serverNamePattern(), 'Movie Night \\(Home\\)');
  assert.equal(adminName(), 'Alice');
});
