import assert from 'node:assert/strict';
import test from 'node:test';
import { executeMediaQualityUpgradeTool, previewMediaQualityUpgradeTool } from './media-quality-upgrade-tools';

test('existing-title quality execution is approval-gated while its preview is read-only', () => {
  assert.equal(previewMediaQualityUpgradeTool.requireApproval, false);
  assert.equal(executeMediaQualityUpgradeTool.requireApproval, true);
});

test('quality upgrades accept enrolled and allowlisted users but reject unknown identities', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { canRequestMediaQualityUpgrade } = await import('./media-quality-upgrade-tools');
  const { createGaryWhatsAppEnrollment, claimGaryWhatsAppEnrollment, resetGaryPolicyClientForTests } = await import('../services/gary-access-policy');
  const dir = await mkdtemp(join(tmpdir(), 'gary-upgrade-access-'));
  const previousDir = process.env.GARY_DATA_DIR;
  const previousAllowed = process.env.GARY_WHATSAPP_ALLOWED_USERS;
  process.env.GARY_DATA_DIR = dir;
  process.env.GARY_WHATSAPP_ALLOWED_USERS = '+15550001';
  resetGaryPolicyClientForTests();
  try {
    assert.equal(await canRequestMediaQualityUpgrade('whatsapp:+15550001'), true);
    assert.equal(await canRequestMediaQualityUpgrade('whatsapp:15550001'), true);
    assert.equal(await canRequestMediaQualityUpgrade('whatsapp:+15550002'), false);
    const enrollment = await createGaryWhatsAppEnrollment({ name: 'Test User', email: 'test@example.com' });
    await claimGaryWhatsAppEnrollment('+15550002', enrollment.code);
    assert.equal(await canRequestMediaQualityUpgrade('whatsapp:+15550002'), true);
    assert.equal(await canRequestMediaQualityUpgrade(''), false);
    assert.equal(await canRequestMediaQualityUpgrade('whatsapp:not-a-phone'), false);
    assert.equal(await canRequestMediaQualityUpgrade('slack:unknown'), false);
    assert.equal(await canRequestMediaQualityUpgrade('admin-household'), true);
  } finally {
    resetGaryPolicyClientForTests();
    if (previousDir === undefined) delete process.env.GARY_DATA_DIR; else process.env.GARY_DATA_DIR = previousDir;
    if (previousAllowed === undefined) delete process.env.GARY_WHATSAPP_ALLOWED_USERS; else process.env.GARY_WHATSAPP_ALLOWED_USERS = previousAllowed;
    await rm(dir, { recursive: true, force: true });
  }
});
