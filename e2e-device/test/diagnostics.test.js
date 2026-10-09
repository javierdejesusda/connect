import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as analysis from '../lib/analysis.js';

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

describe('summarizeValues', () => {
  it('reports count, median and max', () => {
    assert.deepEqual(analysis.summarizeValues([3, 1, 2]), { n: 3, median: 2, max: 3 });
  });

  it('averages the two middle values of an even count and rounds to 0.1', () => {
    assert.deepEqual(analysis.summarizeValues([10, 20, 30, 41.26]), { n: 4, median: 25, max: 41.3 });
  });

  it('has no median or max for no values', () => {
    assert.deepEqual(analysis.summarizeValues([]), { n: 0, median: null, max: null });
  });
});

describe('summarizeResponsiveness', () => {
  const trips = [{ ms: 10, trivial: true }, { ms: 50, trivial: false }, { ms: 30, trivial: true }];

  it('summarizes all round trips, the trivial ones and the page lag', () => {
    const out = analysis.summarizeResponsiveness({ trips, lag: [0, 0.4, 18000] });
    assert.deepEqual(out.roundTripMs, { n: 3, median: 30, max: 50 });
    assert.deepEqual(out.trivialRoundTripMs, { n: 2, median: 20, max: 30 });
    assert.deepEqual(out.pageLagMs, { n: 3, median: 0.4, max: 18000 });
  });

  it('copes with a step that made no calls', () => {
    const out = analysis.summarizeResponsiveness({ trips: [], lag: [] });
    assert.equal(out.roundTripMs.n, 0);
    assert.equal(out.pageLagMs.max, null);
  });
});

describe('formatWrite', () => {
  it('shows the property, value, previous value, source and call site relative to the window', () => {
    const write = { t: 5204, prop: 'playbackRate', value: 0, from: 1, source: 'app', site: ['explorer.js:12', 'x.js:3'] };
    assert.equal(analysis.formatWrite(write, 5000), '+204 playbackRate=0 (was 1) app explorer.js:12 < x.js:3');
  });

  it('rounds currentTime values and tolerates a missing site', () => {
    const write = { t: 1000, prop: 'currentTime', value: 55.23456, from: 54, source: 'unknown', site: [] };
    assert.equal(analysis.formatWrite(write, 1000), '+0 currentTime=55.235 (was 54) unknown');
  });
});

describe('formatEvent', () => {
  it('shows the state of the element at the event', () => {
    const event = { t: 5204, type: 'seeking', ct: 55.2, rs: 1, ns: 2, paused: false, rate: 1 };
    assert.equal(analysis.formatEvent(event, 5000), '+204 seeking ct=55.2 rs=1 ns=2 play rate=1');
  });

  it('marks a paused element', () => {
    const event = { t: 10, type: 'pause', ct: 3, rs: 4, ns: 1, paused: true, rate: 0.5 };
    assert.equal(analysis.formatEvent(event, 0), '+10 pause ct=3 rs=4 ns=1 paused rate=0.5');
  });
});

describe('countEvents', () => {
  it('counts per type in order of first appearance', () => {
    const counts = analysis.countEvents([{ type: 'playing' }, { type: 'seeking' }, { type: 'playing' }]);
    assert.deepEqual(counts, { playing: 2, seeking: 1 });
    assert.deepEqual(Object.keys(counts), ['playing', 'seeking']);
  });

  it('is empty for no events', () => {
    assert.deepEqual(analysis.countEvents([]), {});
  });
});

describe('capEntries', () => {
  it('keeps a short list as it is', () => {
    assert.deepEqual(analysis.capEntries(['a', 'b'], 3), ['a', 'b']);
  });

  it('cuts a long list and says how many entries were left out', () => {
    assert.deepEqual(analysis.capEntries(['a', 'b', 'c', 'd', 'e'], 3), ['a', 'b', 'c', '... 2 more']);
  });
});

describe('summarizeWrites', () => {
  const writes = [
    { t: 1204, prop: 'playbackRate', value: 0 },
    { t: 1262, prop: 'playbackRate', value: 1 },
    { t: 2000, prop: 'currentTime', value: 55.23456 },
  ];

  it('lists prop=value@ms from the window start', () => {
    assert.equal(analysis.summarizeWrites(writes, 1000, 200),
      'playbackRate=0@204 playbackRate=1@262 currentTime=55.235@1000');
  });

  it('truncates at a whole write and counts the rest', () => {
    assert.equal(analysis.summarizeWrites(writes, 1000, 40), 'playbackRate=0@204 playbackRate=1@262 ...+1');
  });

  it('says none when nothing was written', () => {
    assert.equal(analysis.summarizeWrites([], 0, 100), 'none');
  });
});

describe('stateTrace', () => {
  const fast = (t) => ({ t, ct: 10 + t / 1000, rs: 4, ns: 2, paused: false, seeking: false, rate: 1, spin: false });
  const slow = (t, over = {}) => ({ ...fast(t), buf: 15.5, disp: '18:30:34 - 0', ...over });

  it('keeps only the once-per-second samples that carry the buffered end', () => {
    const samples = [fast(1000), fast(1200), slow(2000), fast(2200), slow(3000)];
    const trace = analysis.stateTrace(samples, 1000);
    assert.equal(trace.length, 2);
    assert.match(trace[0], /^\+1\.0s ct=12 rs=4 ns=2 play buf=15\.5/);
    assert.match(trace[1], /^\+2\.0s ct=13 /);
  });

  it('shows the rate and the seeking flag when they are not the default', () => {
    const [line] = analysis.stateTrace([slow(2000, { rate: 0, seeking: true, rs: 1 })], 1000);
    assert.match(line, /rs=1 ns=2 play rate=0 seeking buf=15\.5/);
  });

  it('writes buf=none when the current time is outside every buffered range', () => {
    const [line] = analysis.stateTrace([slow(2000, { buf: null })], 1000);
    assert.match(line, /buf=none/);
  });
});

describe('displayAdvance', () => {
  const shown = (seconds) => ({ disp: `17:30:${seconds} ${EN_DASH} 0` });

  it('sums how far the displayed clock moved across the once-per-second readings', () => {
    const samples = [shown(40), shown(41), shown(42), shown(43), shown(44)];
    assert.equal(analysis.displayAdvance(samples, 10), 4);
  });

  it('adds the loop span back when the display jumps to the start of the range', () => {
    const samples = [shown(48), shown(49), shown(40), shown(41)];
    assert.equal(analysis.displayAdvance(samples, 10), 3);
  });

  it('skips samples without a display reading', () => {
    const samples = [{ ct: 1 }, { disp: null }, shown(40), { ct: 2 }, shown(43)];
    assert.equal(analysis.displayAdvance(samples, 10), 3);
  });

  it('reports a display that stood still as zero', () => {
    assert.equal(analysis.displayAdvance([shown(40), shown(40), shown(40)], 10), 0);
  });

  it('has no answer with fewer than two readings', () => {
    assert.equal(analysis.displayAdvance([shown(40)], 10), null);
    assert.equal(analysis.displayAdvance([], 10), null);
  });

  it('counts the iPad run 8 deep link as moving: 16 to 20, then the loop back to 10 and 11', () => {
    const samples = [16, 17, 18, 19, 20, 10, 11].map(shown);
    const advance = analysis.displayAdvance(samples, 10);
    assert.equal(advance, 5);
    assert.equal(analysis.displayAdvanceOk(advance, 2), true);
  });

  it('counts a loop wrap between two once-per-second readings as one second of motion', () => {
    const samples = [17, 18, 19, 10, 11].map(shown);
    assert.equal(analysis.displayAdvance(samples, 10), 4);
  });

  it('fails a display that stood still for the whole window', () => {
    const advance = analysis.displayAdvance([16, 16, 16, 16, 16].map(shown), 10);
    assert.equal(advance, 0);
    assert.equal(analysis.displayAdvanceOk(advance, 2), false);
  });
});

describe('displayAdvanceOk', () => {
  it('passes from the minimum upwards', () => {
    assert.equal(analysis.displayAdvanceOk(2, 2), true);
    assert.equal(analysis.displayAdvanceOk(3.5, 2), true);
  });

  it('fails below the minimum', () => {
    assert.equal(analysis.displayAdvanceOk(1.9, 2), false);
    assert.equal(analysis.displayAdvanceOk(0, 2), false);
    assert.equal(analysis.displayAdvanceOk(-5, 2), false);
  });

  it('never passes a missing reading', () => {
    assert.equal(analysis.displayAdvanceOk(null, 2), false);
    assert.equal(analysis.displayAdvanceOk(undefined, 2), false);
    assert.equal(analysis.displayAdvanceOk(Number.NaN, 2), false);
  });
});

describe('windowDiagnostics', () => {
  const log = {
    samples: [
      { t: 900, ct: 1, rs: 4, ns: 2, paused: false, rate: 1, buf: 5 },
      { t: 2000, ct: 12, rs: 4, ns: 2, paused: false, rate: 1, buf: 15.5 },
      { t: 4000, ct: 13, rs: 4, ns: 2, paused: false, rate: 1, buf: 15.5 },
    ],
    writes: [
      { t: 1500, prop: 'playbackRate', value: 0, from: 1, source: 'app', site: ['a.js:1'] },
      { t: 9000, prop: 'playbackRate', value: 1, from: 0, source: 'app', site: ['a.js:1'] },
    ],
    events: [
      { t: 1100, type: 'seeking', ct: 12, rs: 1, ns: 2, paused: false, rate: 1 },
      { t: 1900, type: 'seeked', ct: 12, rs: 4, ns: 2, paused: false, rate: 1 },
      { t: 9500, type: 'waiting', ct: 40, rs: 2, ns: 2, paused: false, rate: 1 },
    ],
  };

  it('keeps only what happened inside the window', () => {
    const out = analysis.windowDiagnostics(log, 1000, 5000);
    assert.equal(out.spanMs, 4000);
    assert.deepEqual(out.eventCounts, { seeking: 1, seeked: 1 });
    assert.equal(out.writeSummary, 'playbackRate=0@500');
    assert.deepEqual(out.writes, ['+500 playbackRate=0 (was 1) app a.js:1']);
    assert.deepEqual(out.events, [
      '+100 seeking ct=12 rs=1 ns=2 play rate=1',
      '+900 seeked ct=12 rs=4 ns=2 play rate=1',
    ]);
    assert.equal(out.trace.length, 2);
  });

  it('carries extra measurements for the window and leaves them out otherwise', () => {
    const extra = { snapGapMs: 3999, snapRoundTripMs: [45, 412] };
    assert.deepEqual(analysis.windowDiagnostics(log, 1000, 5000, extra).extra, extra);
    assert.equal('extra' in analysis.windowDiagnostics(log, 1000, 5000), false);
  });

  it('bounds the ordered logs and the trace', () => {
    const many = {
      samples: Array.from({ length: 100 }, (_, i) => ({ t: i * 1000, ct: i, rs: 4, ns: 2, paused: false, rate: 1, buf: i + 5 })),
      writes: Array.from({ length: 250 }, (_, i) => ({ t: i, prop: 'currentTime', value: i, from: 0, source: 'app', site: [] })),
      events: Array.from({ length: 250 }, (_, i) => ({ t: i, type: 'ratechange', ct: 1, rs: 4, ns: 2, paused: false, rate: 1 })),
    };
    const out = analysis.windowDiagnostics(many, 0, 100000);
    assert.equal(out.writes.length, 201);
    assert.equal(out.writes[200], '... 50 more');
    assert.equal(out.events.length, 201);
    assert.equal(out.trace.length, 61);
    assert.equal(out.eventCounts.ratechange, 250);
  });
});

describe('renderMarkdown diagnostics', () => {
  const base = {
    label: 'simulator/emulator (CI)',
    job: 'iphone',
    device: 'iPhone 16',
    os: 'iOS 18.6',
    target: 'https://example.test/demo',
  };
  const step = (diagnostics) => ({ id: 'S2', title: 'steady', status: 'pass', measured: { writes: 0 }, assertions: [], diagnostics });
  const window10 = {
    spanMs: 10000, eventCounts: { playing: 1, ratechange: 2 }, writeSummary: 'playbackRate=1@204 playbackRate=1@711', writes: [], events: [], trace: [],
  };

  it('adds one line per scenario and one per window', () => {
    const md = analysis.renderMarkdown({
      ...base,
      steps: [step({
        responsiveness: {
          roundTripMs: { n: 57, median: 11, max: 38 },
          trivialRoundTripMs: { n: 21, median: 10, max: 22 },
          pageLagMs: { n: 100, median: 0.4, max: 3.1 },
        },
        windows: { 'steady 10 s': window10 },
      })],
    });
    assert.match(md, /## Diagnostics/);
    assert.match(md, /^- S2: round trip 11\/38 ms \(n=57\), trivial 10\/22 ms \(n=21\), lag 0\.4\/3\.1 ms \(n=100\)$/m);
    assert.match(md, /^ {2}- steady 10 s: events playing:1 ratechange:2; writes playbackRate=1@204 playbackRate=1@711$/m);
  });

  it('adds the extra measurements of a window to its line', () => {
    const extra = { snapGapMs: 3999, snapRoundTripMs: [45, 412], pauseWallMs: 4012, displayAdvanceInPageS: null };
    const md = analysis.renderMarkdown({ ...base, steps: [step({ windows: { 'deep link 1/3': { ...window10, extra } } })] });
    const line = '  - deep link 1/3: events playing:1 ratechange:2; writes playbackRate=1@204 playbackRate=1@711; '
      + 'snapGapMs=3999 snapRoundTripMs=45/412 pauseWallMs=4012 displayAdvanceInPageS=null';
    assert.ok(md.split('\n').includes(line), `no line: ${line}`);
  });

  it('keeps the table row of the step unchanged', () => {
    const withDiag = analysis.renderMarkdown({ ...base, steps: [step({ windows: { 'steady 10 s': window10 } })] });
    const without = analysis.renderMarkdown({ ...base, steps: [{ ...step(undefined), diagnostics: undefined }] });
    const row = (md) => md.split('\n').find((line) => line.startsWith('| S2 |'));
    assert.equal(row(withDiag), row(without));
  });

  it('prints n/a for a missing measurement and the reason when diagnostics are unavailable', () => {
    const md = analysis.renderMarkdown({
      ...base,
      steps: [
        step({ responsiveness: { roundTripMs: { n: 0, median: null, max: null }, trivialRoundTripMs: { n: 0, median: null, max: null }, pageLagMs: { n: 4, median: 0, max: 1 } } }),
        { ...step({ responsiveness: 'unavailable: session closed' }), id: 'S3' },
      ],
    });
    assert.match(md, /^- S2: round trip n\/a, trivial n\/a, lag 0\/1 ms \(n=4\)$/m);
    assert.match(md, /^- S3: unavailable: session closed$/m);
  });

  it('has no Diagnostics section when no step recorded any', () => {
    const md = analysis.renderMarkdown({ ...base, steps: [step(undefined)] });
    assert.ok(!md.includes('Diagnostics'));
  });

  it('never contains an em dash', () => {
    const md = analysis.renderMarkdown({ ...base, steps: [step({ windows: { 'steady 10 s': window10 } })] });
    assert.ok(!md.includes(EM_DASH));
  });
});
