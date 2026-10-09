import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderMarkdown } from './analysis.js';

/**
 * Collects per-step measurements and assertions and writes results.json and
 * results.md after every step, so a crash keeps what was measured so far.
 *
 * @param {{outDir: string, meta: Object, afterStep: ?function(Object):
 *     Promise<void>}} options Output directory, the fixed fields of the report
 *     (job, device, os, target, label) and an optional hook that records
 *     diagnostics once a step body is done. The hook cannot change a verdict.
 * @return {Object} Recorder with runStep, skip, fact, results and save.
 */
export function createRecorder({ outDir, meta, afterStep }) {
  mkdirSync(outDir, { recursive: true });
  const results = {
    ...meta,
    startedAt: new Date().toISOString(),
    facts: {},
    steps: [],
  };

  function save() {
    results.finishedAt = new Date().toISOString();
    writeFileSync(join(outDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
    writeFileSync(join(outDir, 'results.md'), renderMarkdown(results));
  }

  function fact(key, value) {
    results.facts[key] = value;
  }

  function skip(id, title, reason) {
    results.steps.push({ id, title, status: 'skip', reason });
    save();
  }

  /**
   * Runs one step. Assertions are recorded rather than thrown so a step
   * reports every failed check, then the step fails once at the end.
   *
   * @param {string} id Short step id such as 'S3'.
   * @param {string} title What the step checks.
   * @param {function(Object): Promise<void>} body Step body.
   */
  async function runStep(id, title, body) {
    const step = {
      id,
      title,
      status: 'pass',
      measured: {},
      assertions: [],
      inputs: [],
    };
    results.steps.push(step);
    const started = Date.now();
    const api = {
      measure(key, value) {
        step.measured[key] = value;
      },
      check(name, ok, actual, expected) {
        step.assertions.push({ name, ok: Boolean(ok), actual, expected });
        console.log(`[${id}] ${ok ? 'ok  ' : 'FAIL'} ${name} (actual ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
      },
      input(record) {
        if (record && !step.inputs.includes(record.method)) step.inputs.push(record.method);
      },
      diagnose(key, value) {
        step.diagnostics = step.diagnostics || {};
        step.diagnostics[key] = value;
      },
      diagnoseWindow(name, value) {
        step.diagnostics = step.diagnostics || {};
        step.diagnostics.windows = step.diagnostics.windows || {};
        step.diagnostics.windows[name] = value;
      },
      log(message) {
        console.log(`[${id}] ${message}`);
      },
    };
    try {
      await body(api);
    } catch (error) {
      api.check('step ran without error', false, String(error && error.message), 'no error');
    }
    step.durationMs = Date.now() - started;
    if (afterStep) {
      try {
        await afterStep(api);
      } catch (error) {
        console.log(`[${id}] diagnostics hook failed: ${error && error.message}`);
      }
    }
    if (step.assertions.some((a) => !a.ok)) step.status = 'fail';
    if (step.inputs.length > 0) step.measured.input = step.inputs.join(',');
    save();
    if (step.status === 'fail') {
      const failed = step.assertions.filter((a) => !a.ok).map((a) => a.name);
      throw new Error(`${id} failed: ${failed.join('; ')}`);
    }
  }

  return { results, runStep, skip, fact, save };
}
