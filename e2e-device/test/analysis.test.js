import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  advanceOver,
  classifySource,
  clockDelta,
  countWrites,
  firstAdvanceAt,
  keepsAdvancing,
  withinWallTime,
  lastSpinnerAt,
  playingSteadily,
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

describe('firstAdvanceAt', () => {
  it('finds the first sample where the video has moved past the first decoded frame', () => {
    const samples = [
      { t: 0, none: true },
      { t: 200, ct: 0, rs: 0 },
      { t: 400, ct: 0, rs: 2 },
      { t: 600, ct: 0.1, rs: 3 },
      { t: 800, ct: 0.4, rs: 4 },
    ];
    assert.deepEqual(firstAdvanceAt(samples, 0.25), { t: 800, ct: 0.4 });
  });

  it('returns null when the clock never moves', () => {
    assert.equal(firstAdvanceAt([{ t: 0, ct: 0, rs: 2 }, { t: 900, ct: 0, rs: 2 }], 0.25), null);
  });

  it('ignores movement before a frame is decoded', () => {
    assert.equal(firstAdvanceAt([{ t: 0, ct: 5, rs: 0 }, { t: 900, ct: 9, rs: 1 }], 0.25), null);
  });
});

describe('lastSpinnerAt', () => {
  it('returns the time of the last sample showing the spinner', () => {
    const samples = [{ t: 1, spin: true }, { t: 2, spin: true }, { t: 3, spin: false }];
    assert.equal(lastSpinnerAt(samples), 2);
  });

  it('returns null when it never showed', () => {
    assert.equal(lastSpinnerAt([{ t: 1, spin: false }]), null);
  });
});

describe('playingSteadily', () => {
  const ok = (t, ct) => ({ t, ct, rs: 4, paused: false, seeking: false, spin: false });

  it('is true for a run of unpaused, settled, moving samples', () => {
    const run = [ok(0, 10), ok(300, 10.3), ok(600, 10.6), ok(900, 10.9), ok(1200, 11.2)];
    assert.equal(playingSteadily(run, 1000, 0.5), true);
  });

  it('is false while seeking, paused or showing the spinner', () => {
    const base = [ok(0, 10), ok(300, 10.3), ok(600, 10.6), ok(900, 10.9), ok(1200, 11.2)];
    assert.equal(playingSteadily(base.map((s) => ({ ...s, seeking: true })), 1000, 0.5), false);
    assert.equal(playingSteadily(base.map((s) => ({ ...s, paused: true })), 1000, 0.5), false);
    assert.equal(playingSteadily(base.map((s) => ({ ...s, spin: true })), 1000, 0.5), false);
  });

  it('is false when the clock does not move or the run is too short', () => {
    const flat = [ok(0, 10), ok(300, 10), ok(600, 10), ok(900, 10), ok(1200, 10)];
    assert.equal(playingSteadily(flat, 1000, 0.5), false);
    assert.equal(playingSteadily([ok(0, 10), ok(300, 10.3)], 1000, 0.1), false);
  });
});

describe('keepsAdvancing', () => {
  it('accepts a clock that moves at least 40 percent of real time at 1x and above', () => {
    assert.equal(keepsAdvancing(1, 3, 2.8), true);
    assert.equal(keepsAdvancing(8, 2.7, 5), true);
    assert.equal(keepsAdvancing(8, 2.7, 1), false);
  });

  it('rejects a frozen clock at any rate', () => {
    assert.equal(keepsAdvancing(2, 3, 0), false);
    assert.equal(keepsAdvancing(0.1, 3, 0), false);
  });

  it('scales the expectation down below 1x and caps runaway clocks', () => {
    assert.equal(keepsAdvancing(0.25, 3, 0.7), true);
    assert.equal(keepsAdvancing(0.25, 3, 6), false);
    assert.equal(keepsAdvancing(1, 3, 12), false);
  });
});

describe('withinWallTime', () => {
  it('compares a displayed time delta with the wall time between two readings', () => {
    assert.equal(withinWallTime(9, 9.2, 2.5), true);
    assert.equal(withinWallTime(4, 9.2, 2.5), false);
    assert.equal(withinWallTime(null, 9, 2.5), false);
  });
});
