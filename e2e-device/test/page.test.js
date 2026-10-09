import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPage } from '../lib/page.js';

const PROBE_INSTALL_MIN_LENGTH = 1000;

function fakeBrowser({ lag = [], failDrain = false } = {}) {
  const pendingLag = [...lag];
  return {
    async execute(script) {
      if (script.length > PROBE_INSTALL_MIN_LENGTH) return {};
      if (script.includes('drainLag')) {
        if (failDrain) throw new Error('session closed');
        return pendingLag.splice(0);
      }
      if (script.includes('__ev.now()')) return 42;
      if (script.includes('location.href')) return 'https://example.test/demo';
      return { entries: 1 };
    },
    async url() {},
    async pause() {},
  };
}

describe('page responsiveness', () => {
  it('times the page helper calls, flags the clock read as trivial and clears on drain', async () => {
    const page = createPage(fakeBrowser({ lag: [0.5, 120] }), { platform: 'android' });
    await page.now();
    await page.snap();
    const drained = await page.drainResponsiveness();
    assert.deepEqual(drained.trips.map((trip) => trip.trivial), [true, false]);
    assert.ok(drained.trips.every((trip) => trip.ms >= 0));
    assert.deepEqual(drained.lag, [0.5, 120]);
    const again = await page.drainResponsiveness();
    assert.equal(again.trips.length, 0);
    assert.deepEqual(again.lag, []);
  });

  it('keeps the lag of the page it navigates away from', async () => {
    const page = createPage(fakeBrowser({ lag: [7, 8] }), { platform: 'android' });
    await page.open('https://example.test/demo');
    const drained = await page.drainResponsiveness();
    assert.deepEqual(drained.lag, [7, 8]);
    assert.equal(drained.trips.length, 0);
  });

  it('still returns the round trips when the page cannot be reached', async () => {
    const page = createPage(fakeBrowser({ failDrain: true }), { platform: 'android' });
    await page.now();
    const drained = await page.drainResponsiveness();
    assert.equal(drained.trips.length, 1);
    assert.deepEqual(drained.lag, []);
  });
});
