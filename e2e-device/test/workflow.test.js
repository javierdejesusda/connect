import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { parse } from 'yaml';

const workflow = parse(readFileSync(new URL('../../.github/workflows/device-evidence.yaml', import.meta.url), 'utf8'));

const deviceJobs = ['ios', 'android'];

function stepIndex(steps, predicate, what) {
  const index = steps.findIndex(predicate);
  assert.notEqual(index, -1, `missing step: ${what}`);
  return index;
}

const isCompress = (step) => step.name === 'Compress the recording';
const isSpecs = (step) => /^Run device specs/.test(step.name ?? '');
const uploadsResults = (step) => String(step.uses).startsWith('actions/upload-artifact')
  && String(step.with?.path).includes('out/results.json');

describe('device-evidence workflow', () => {
  for (const id of deviceJobs) {
    describe(id, () => {
      const job = workflow.jobs[id];

      it('uploads the results before compressing the recording', () => {
        const compress = stepIndex(job.steps, isCompress, 'compress');
        const upload = stepIndex(job.steps, uploadsResults, 'results upload');
        assert.ok(upload < compress, `results upload (step ${upload}) runs after compress (step ${compress})`);
        assert.equal(job.steps[upload].if, 'always()');
      });

      it('bounds the compress step so a hung encoder cannot cancel the job', () => {
        const step = job.steps[stepIndex(job.steps, isCompress, 'compress')];
        assert.ok(step['timeout-minutes'] > 0, 'compress step has no timeout-minutes');
        assert.equal(step['continue-on-error'], true);
        const specs = job.steps[stepIndex(job.steps, isSpecs, 'specs')];
        assert.ok(
          specs['timeout-minutes'] + step['timeout-minutes'] < job['timeout-minutes'],
          'the job timeout fires before the specs and compress timeouts',
        );
      });
    });
  }
});
