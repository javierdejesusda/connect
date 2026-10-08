import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  advanceOver,
  classifySource,
  clockDelta,
  countWrites,
  landingTolerance,
  parseClockText,
  renderMarkdown,
  sliceLog,
  speedAdvanceOk,
  stateFromLabel,
} from '../lib/analysis.js';

describe('classifySource', () => {
  it('attributes hls.js chunks and bundled app code', () => {
    assert.equal(classifySource(['hls.light-CL_gHzNM.js:12']), 'hls.js');
    assert.equal(classifySource(['hls.min.js:1']), 'hls.js');
    assert.equal(classifySource(['explorer-26baefEG.js:3']), 'app');
    assert.equal(classifySource([]), 'unknown');
  });
});

describe('sliceLog', () => {
  const log = {
    samples: [{ t: 10 }, { t: 20 }, { t: 30 }],
    writes: [{ t: 5 }, { t: 25 }],
    events: [{ t: 15 }],
    input: [],
    calls: [{ t: 21 }],
  };

  it('keeps entries in [from, to)', () => {
    const out = sliceLog(log, 10, 30);
    assert.deepEqual(out.samples.map((s) => s.t), [10, 20]);
    assert.deepEqual(out.writes.map((w) => w.t), [25]);
    assert.deepEqual(out.calls.map((c) => c.t), [21]);
  });

  it('treats a missing upper bound as open ended', () => {
    assert.equal(sliceLog(log, 20).samples.length, 2);
  });
});

describe('countWrites', () => {
  it('splits by property and by source', () => {
    const writes = [
      { prop: 'currentTime', source: 'app' },
      { prop: 'currentTime', source: 'hls.js' },
      { prop: 'playbackRate', source: 'app' },
    ];
    assert.deepEqual(countWrites(writes), {
      currentTime: 2,
      playbackRate: 1,
      total: 3,
      appCurrentTime: 1,
      hlsCurrentTime: 1,
    });
  });

  it('is all zero for no writes', () => {
    assert.equal(countWrites([]).total, 0);
  });
});

describe('advanceOver', () => {
  it('reports the media time covered and the wall time spanned', () => {
    const samples = [
      { t: 0, ct: 1 },
      { t: 1000, ct: 2.1 },
      { t: 2000, ct: 3.0 },
    ];
    const out = advanceOver(samples);
    assert.equal(out.delta, 2);
    assert.equal(out.wallSeconds, 2);
    assert.equal(out.backwards, 0);
  });

  it('counts backwards jumps', () => {
    const out = advanceOver([{ t: 0, ct: 5 }, { t: 100, ct: 2 }, { t: 200, ct: 2.1 }]);
    assert.equal(out.backwards, 1);
  });

  it('ignores samples without a video and returns zeros when empty', () => {
    assert.equal(advanceOver([{ t: 0, none: true }]).delta, 0);
    assert.equal(advanceOver([]).delta, 0);
  });
});

describe('parseClockText and clockDelta', () => {
  it('parses the TimeDisplay text', () => {
    assert.equal(parseClockText('18:30:34 – 0'), 18 * 3600 + 30 * 60 + 34);
    assert.equal(parseClockText('...'), null);
    assert.equal(parseClockText(null), null);
  });

  it('wraps around midnight and keeps the sign', () => {
    assert.equal(clockDelta(86395, 5), 10);
    assert.equal(clockDelta(100, 90), -10);
    assert.equal(clockDelta(null, 5), null);
  });
});

describe('landingTolerance', () => {
  it('allows three pixels of pointer error plus slack', () => {
    assert.equal(landingTolerance(400, 800), 9);
  });
});

describe('speedAdvanceOk', () => {
  it('accepts roughly the requested rate', () => {
    assert.equal(speedAdvanceOk(2, 3, 6), true);
    assert.equal(speedAdvanceOk(2, 3, 3.2), true);
  });

  it('rejects a stalled video and a runaway one', () => {
    assert.equal(speedAdvanceOk(2, 3, 0), false);
    assert.equal(speedAdvanceOk(1, 3, 12), false);
  });

  it('still demands visible movement at 0.1x', () => {
    assert.equal(speedAdvanceOk(0.1, 3, 0), false);
    assert.equal(speedAdvanceOk(0.1, 3, 0.3), true);
  });
});

describe('stateFromLabel', () => {
  it('maps the play button label to the paused state', () => {
    assert.equal(stateFromLabel('Pause'), false);
    assert.equal(stateFromLabel('Unpause'), true);
    assert.equal(stateFromLabel(null), null);
  });
});

describe('renderMarkdown', () => {
  const results = {
    label: 'simulator/emulator (CI)',
    job: 'iphone',
    device: 'iPhone 16',
    os: 'iOS 18.6',
    target: 'https://example.test/demo',
    facts: { typeofMediaSource: 'undefined', path: 'native-hls' },
    steps: [
      {
        id: 'S1',
        title: 'first frame',
        status: 'pass',
        measured: { ttffMs: 1200 },
        assertions: [{ name: 'spinner gone', ok: true }],
      },
      {
        id: 'S2',
        title: 'steady',
        status: 'fail',
        measured: { writes: 3 },
        assertions: [{ name: 'no writes', ok: false, expected: 0, actual: 3 }],
      },
      { id: 'S9', title: 'airplane mode', status: 'skip', reason: 'not available in simulators' },
    ],
  };

  it('labels the run and lists each step with its status', () => {
    const md = renderMarkdown(results);
    assert.match(md, /simulator\/emulator \(CI\)/);
    assert.match(md, /\| S1 \| first frame \| pass \|/);
    assert.match(md, /\| S2 \| steady \| FAIL \|/);
    assert.match(md, /\| S9 \| airplane mode \| skip \|/);
  });

  it('prints the failing assertions with expected and actual', () => {
    const md = renderMarkdown(results);
    assert.match(md, /no writes: expected 0, actual 3/);
  });

  it('never contains an em dash', () => {
    assert.ok(!renderMarkdown(results).includes(String.fromCharCode(0x2014)));
  });
});
