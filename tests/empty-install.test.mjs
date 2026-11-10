import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('fresh installation initializes without third-party cases', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plib-test-'));
  try {
    const run = spawnSync(process.execPath, ['scripts/import.mjs'], { cwd: process.cwd(), env: { ...process.env, PLIB_DATA: dir }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
