import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { createRecorder } from '../lib/recorder.js';

const META = { job: 'iphone', label: 'simulator/emulator (CI)', device: 'iPhone', os: 'iOS', target: 'https://example.test' };

function setup(extra = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'recorder-'));
  const recorder = createRecorder({ outDir, meta: META, ...extra });
  const saved = () => JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8'));
  return { recorder, saved, outDir };
}

describe('recorder diagnostics', () => {
  it('stores diagnostics beside the measured values, not inside them', async () => {
    const { recorder, saved, outDir } = setup();
    await recorder.runStep('S2', 'steady', async (s) => {
      s.measure('writes', 0);
      s.diagnose('responsiveness', { pageLagMs: { n: 1, median: 0, max: 0 } });
      s.diagnoseWindow('steady 10 s', { spanMs: 10000, eventCounts: {}, writeSummary: 'none' });
    });
    const [step] = saved().steps;
    assert.deepEqual(step.measured, { writes: 0 });
    assert.deepEqual(step.diagnostics.responsiveness, { pageLagMs: { n: 1, median: 0, max: 0 } });
    assert.equal(step.diagnostics.windows['steady 10 s'].spanMs, 10000);
    assert.match(readFileSync(join(outDir, 'results.md'), 'utf8'), /## Diagnostics/);
  });

  it('leaves steps without diagnostics unchanged', async () => {
    const { recorder, saved } = setup();
    await recorder.runStep('S1', 'open', async (s) => s.measure('a', 1));
    assert.equal('diagnostics' in saved().steps[0], false);
  });

  it('runs afterStep once the body is done, also for a failing step, and keeps the verdict', async () => {
    const { recorder, saved } = setup({ afterStep: async (s) => s.diagnose('after', true) });
    await assert.rejects(recorder.runStep('S9', 'fails', async (s) => s.check('always', false, 1, 0)), /S9 failed/);
    const [step] = saved().steps;
    assert.equal(step.status, 'fail');
    assert.equal(step.diagnostics.after, true);
  });

  it('never lets a throwing afterStep change the verdict', async () => {
    const { recorder, saved } = setup({ afterStep: async () => { throw new Error('session closed'); } });
    await recorder.runStep('S1', 'passes', async (s) => s.check('fine', true, 1, 1));
    const [step] = saved().steps;
    assert.equal(step.status, 'pass');
    assert.equal(step.assertions.length, 1);
  });
});
