/**
 * Pure helpers that turn the in-page probe log into numbers and the numbers
 * into a results report. Nothing here touches a browser, so it runs under
 * `node --test`.
 */

const SECONDS_PER_DAY = 86400;
const POINTER_ERROR_PX = 3;
const LANDING_SLACK_SECONDS = 3;
const DETAIL_CAP = 200;
const TRACE_CAP = 60;
const WRITE_SUMMARY_CHARS = 140;
const MIN_TRACE_SPACING_MS = 500;

/**
 * Attributes a media element write to hls.js or to the app.
 *
 * The hls.js chunk of the app and the CDN build used by older releases both
 * have a file name that starts with "hls".
 *
 * @param {string[]} frames Caller frames, innermost first, as "file.js:line".
 * @return {string} 'hls.js', 'app' or 'unknown'.
 */
export function classifySource(frames) {
  if (!frames || frames.length === 0) return 'unknown';
  return /hls[.-]/i.test(frames[0]) ? 'hls.js' : 'app';
}

/**
 * Keeps the probe log entries whose timestamp is in [fromT, toT).
 *
 * @param {Object} log Probe log with samples, writes, events, input, calls.
 * @param {number} fromT Inclusive lower bound in probe milliseconds.
 * @param {number=} toT Exclusive upper bound, open ended when omitted.
 * @return {Object} The same shape with filtered arrays.
 */
export function sliceLog(log, fromT, toT = Infinity) {
  const inside = (entry) => entry.t >= fromT && entry.t < toT;
  const out = {};
  for (const key of ['samples', 'writes', 'events', 'input', 'calls']) {
    out[key] = (log[key] || []).filter(inside);
  }
  return out;
}

/**
 * Counts writes to the media element setters.
 *
 * @param {Object[]} writes Probe write records.
 * @return {Object} Counts per property and per source.
 */
export function countWrites(writes) {
  const out = {
    currentTime: 0,
    playbackRate: 0,
    total: writes.length,
    appCurrentTime: 0,
    hlsCurrentTime: 0,
  };
  for (const write of writes) {
    out[write.prop] += 1;
    if (write.prop === 'currentTime') {
      if (write.source === 'hls.js') out.hlsCurrentTime += 1;
      else out.appCurrentTime += 1;
    }
  }
  return out;
}

/**
 * Measures how far the media clock moved across a run of samples.
 *
 * @param {Object[]} samples Probe samples, ordered by time.
 * @return {Object} Media seconds covered, wall seconds spanned and the number
 *     of backwards jumps.
 */
export function advanceOver(samples) {
  const withVideo = samples.filter((s) => typeof s.ct === 'number');
  if (withVideo.length < 2) {
    return { delta: 0, wallSeconds: 0, backwards: 0, first: null, last: null };
  }
  let backwards = 0;
  for (let i = 1; i < withVideo.length; i += 1) {
    if (withVideo[i].ct < withVideo[i - 1].ct - 0.05) backwards += 1;
  }
  const first = withVideo[0];
  const last = withVideo[withVideo.length - 1];
  return {
    delta: round(last.ct - first.ct),
    wallSeconds: round((last.t - first.t) / 1000),
    backwards,
    first: first.ct,
    last: last.ct,
  };
}

/**
 * Finds the moment the first frame is on screen and the video is moving.
 *
 * The first decoded sample (readyState 2 or more) is the baseline; the answer
 * is the first later sample whose media time is `minDelta` seconds past it.
 *
 * @param {Object[]} samples Probe samples, ordered by time.
 * @param {number} minDelta Media seconds the clock must have moved.
 * @return {?{t: number, ct: number}} Time and media time, or null.
 */
export function firstAdvanceAt(samples, minDelta) {
  let base = null;
  for (const sample of samples) {
    if (typeof sample.ct !== 'number' || sample.rs < 2) continue;
    if (base === null) {
      base = sample;
    } else if (sample.ct - base.ct >= minDelta) {
      return { t: sample.t, ct: sample.ct };
    }
  }
  return null;
}

/**
 * Time of the last sample that showed the loading spinner over the video.
 *
 * @param {Object[]} samples Probe samples, ordered by time.
 * @return {?number} Probe milliseconds, or null when it never showed.
 */
export function lastSpinnerAt(samples) {
  let last = null;
  for (const sample of samples) {
    if (sample.spin) last = sample.t;
  }
  return last;
}

/**
 * Whether every sample in a run shows settled, unpaused, moving playback.
 *
 * @param {Object[]} samples Probe samples, ordered by time.
 * @param {number} minSpanMs Shortest wall time the run must cover.
 * @param {number} minDelta Media seconds the clock must have moved.
 * @return {boolean} True when playback is steady across the run.
 */
export function playingSteadily(samples, minSpanMs, minDelta) {
  if (samples.length < 2) return false;
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (last.t - first.t < minSpanMs) return false;
  const settled = samples.every((s) => typeof s.ct === 'number' && s.rs >= 2
    && !s.paused && !s.seeking && !s.spin);
  return settled && last.ct - first.ct >= minDelta;
}

/**
 * Reads the HH:mm:ss part of the TimeDisplay text as seconds of the day.
 *
 * @param {?string} text Text such as "18:30:34 - 0".
 * @return {?number} Seconds since midnight, or null when there is no time.
 */
export function parseClockText(text) {
  const match = /(\d{2}):(\d{2}):(\d{2})/.exec(text || '');
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Signed difference between two clock readings, tolerant of midnight.
 *
 * @param {?number} from Earlier reading in seconds of the day.
 * @param {?number} to Later reading in seconds of the day.
 * @return {?number} Seconds from `from` to `to` in (-12h, 12h].
 */
export function clockDelta(from, to) {
  if (from === null || to === null || from === undefined || to === undefined) return null;
  const half = SECONDS_PER_DAY / 2;
  return ((((to - from + half) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY) - half;
}

/**
 * How far a seek may land from the clicked position.
 *
 * One pixel of the timeline covers duration / width seconds, and the pointer
 * may be a few pixels off.
 *
 * @param {number} widthPx Timeline width in CSS pixels.
 * @param {number} durationSeconds Timeline duration.
 * @return {number} Tolerance in seconds.
 */
export function landingTolerance(widthPx, durationSeconds) {
  return (POINTER_ERROR_PX * durationSeconds) / widthPx + LANDING_SLACK_SECONDS;
}

/**
 * Whether the media clock moved at roughly the requested speed.
 *
 * @param {number} rate Requested playback rate.
 * @param {number} elapsedSeconds Wall seconds observed.
 * @param {number} deltaSeconds Media seconds covered.
 * @return {boolean} True when the advance is plausible for the rate.
 */
export function speedAdvanceOk(rate, elapsedSeconds, deltaSeconds) {
  const expected = rate * elapsedSeconds;
  const lower = Math.max(0.5 * expected - 0.1, 0.05);
  const upper = 1.6 * expected + 0.5;
  return deltaSeconds >= lower && deltaSeconds <= upper;
}

/**
 * Whether the media clock keeps moving at a requested speed, without asking
 * a simulator to sustain it. At 1x and above it must cover at least 40 percent
 * of real time, below 1x at least 40 percent of the requested rate, and it
 * must not run far past the requested rate either.
 *
 * @param {number} rate Requested playback rate.
 * @param {number} elapsedSeconds Wall seconds observed.
 * @param {number} deltaSeconds Media seconds covered.
 * @return {boolean} True when the clock is moving and not runaway.
 */
export function keepsAdvancing(rate, elapsedSeconds, deltaSeconds) {
  const floorBase = Math.min(rate, 1) * elapsedSeconds;
  const lower = Math.max(0.4 * floorBase - 0.05, 0.05);
  const upper = 1.6 * rate * elapsedSeconds + 0.5;
  return deltaSeconds >= lower && deltaSeconds <= upper;
}

/**
 * Whether a displayed clock delta matches the wall time between two readings.
 *
 * @param {?number} displayedDelta Seconds the on-screen clock moved.
 * @param {number} wallSeconds Seconds between the two readings.
 * @param {number} tolerance Allowed difference in seconds.
 * @return {boolean} True when the on-screen clock followed real time.
 */
export function withinWallTime(displayedDelta, wallSeconds, tolerance) {
  if (displayedDelta === null || displayedDelta === undefined) return false;
  return Math.abs(displayedDelta - wallSeconds) <= tolerance;
}

/**
 * Corrects a delta of a looping clock that jumped back to the range start.
 *
 * @param {?number} delta Seconds the clock moved, negative after a wrap.
 * @param {number} span Length of the loop in seconds.
 * @return {?number} The delta with the wrap added back, or null.
 */
export function wrapDelta(delta, span) {
  if (delta === null || delta === undefined) return null;
  return delta < -span / 2 ? delta + span : delta;
}

/**
 * Like advanceOver, for a playback that loops inside a time range: a jump back
 * of more than half the loop is the wrap at the range end, not a seek.
 *
 * @param {Object[]} samples Probe samples, ordered by time.
 * @param {number} span Length of the loop in seconds.
 * @return {{delta: number, wallSeconds: number}} Media and wall seconds.
 */
export function loopAdvance(samples, span) {
  const withVideo = samples.filter((s) => typeof s.ct === 'number');
  if (withVideo.length < 2) return { delta: 0, wallSeconds: 0 };
  let total = 0;
  for (let i = 1; i < withVideo.length; i += 1) {
    total += wrapDelta(withVideo[i].ct - withVideo[i - 1].ct, span);
  }
  const first = withVideo[0];
  const last = withVideo[withVideo.length - 1];
  return { delta: round(total), wallSeconds: round((last.t - first.t) / 1000) };
}

/**
 * Whether the first media time seen on a deep link fits a playback that began
 * at the range start. The probe cannot be installed before the page loads, so
 * the first reading may be late: it may be ahead of the range start by at most
 * the time elapsed since navigation, unless a whole loop could have passed.
 *
 * @param {{ct: ?number, elapsedSeconds: number, rangeStart: number,
 *     rangeEnd: number, tolerance: number}} reading First reading and range.
 * @return {boolean} True when the reading is consistent with a start at the
 *     range start.
 */
export function startConsistent({ ct, elapsedSeconds, rangeStart, rangeEnd, tolerance }) {
  if (typeof ct !== 'number') return false;
  if (ct < rangeStart - tolerance || ct > rangeEnd + tolerance) return false;
  if (elapsedSeconds >= rangeEnd - rangeStart) return true;
  return ct - rangeStart <= elapsedSeconds + tolerance;
}

/**
 * Condenses samples into one readable line per step, to show what a stall
 * looked like (media time, ready state, network state, paused, spinner).
 *
 * @param {Object[]} samples Probe samples, ordered by time.
 * @param {number} fromT Probe milliseconds the trace is relative to.
 * @param {number} stepMs Minimum spacing between lines.
 * @return {string[]} Trace lines.
 */
export function sampleTrace(samples, fromT, stepMs) {
  const lines = [];
  let nextAt = -Infinity;
  for (const s of samples) {
    if (s.t < nextAt) continue;
    nextAt = s.t + stepMs;
    const parts = [`+${round((s.t - fromT) / 1000, 1).toFixed(1)}s`];
    if (s.none) {
      parts.push('no video');
    } else {
      parts.push(`ct=${s.ct}`, `rs=${s.rs}`, `ns=${s.ns}`, s.paused ? 'paused' : 'play');
      if (s.rate !== 1) parts.push(`rate=${s.rate}`);
      if (s.seeking) parts.push('seeking');
      if (s.spin) parts.push('spin');
      if (s.buf !== undefined && s.buf !== null) parts.push(`buf=${s.buf}`);
      if (s.disp) parts.push(`disp=${s.disp}`);
    }
    lines.push(parts.join(' '));
  }
  return lines;
}

/**
 * Condenses samples into the once-per-second trace used by the diagnostics.
 * Only the samples that carry the end of the buffered range are kept, so each
 * line shows media time, ready and network state, paused, seeking, playback
 * rate and the buffered end. Defaults (rate 1, not seeking) are left out.
 *
 * @param {Object[]} samples Probe samples, ordered by time.
 * @param {number} fromT Probe milliseconds the trace is relative to.
 * @return {string[]} Trace lines.
 */
export function stateTrace(samples, fromT) {
  const perSecond = samples
    .filter((s) => s.none || s.buf !== undefined)
    .map((s) => (s.buf === null ? { ...s, buf: 'none' } : s));
  return sampleTrace(perSecond, fromT, MIN_TRACE_SPACING_MS);
}

/**
 * Median and maximum of a list of durations.
 *
 * @param {number[]} values Durations in milliseconds.
 * @return {{n: number, median: ?number, max: ?number}} Count, median and max
 *     rounded to 0.1, null when there are no values.
 */
export function summarizeValues(values) {
  if (values.length === 0) return { n: 0, median: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { n: sorted.length, median: round(median, 1), max: round(sorted[sorted.length - 1], 1) };
}

/**
 * Summarizes how responsive the page was during one scenario.
 *
 * @param {{trips: {ms: number, trivial: boolean}[], lag: number[]}} raw Round
 *     trips of the WebDriver execute calls and drift of the in-page timer.
 * @return {Object} Statistics for all round trips, the trivial ones (clock
 *     reads) and the page lag.
 */
export function summarizeResponsiveness({ trips, lag }) {
  return {
    roundTripMs: summarizeValues(trips.map((trip) => trip.ms)),
    trivialRoundTripMs: summarizeValues(trips.filter((trip) => trip.trivial).map((trip) => trip.ms)),
    pageLagMs: summarizeValues(lag),
  };
}

/**
 * One line for a write to a media element setter.
 *
 * @param {Object} write Probe write record.
 * @param {number} fromT Probe milliseconds the line is relative to.
 * @return {string} Line such as "+204 playbackRate=0 (was 1) app file.js:12".
 */
export function formatWrite(write, fromT) {
  const parts = [
    `+${Math.round(write.t - fromT)}`,
    `${write.prop}=${round(write.value)}`,
    `(was ${round(write.from)})`,
    write.source,
  ];
  if (write.site.length > 0) parts.push(write.site.join(' < '));
  return parts.join(' ');
}

/**
 * One line for a media event with the state of the element at that moment.
 *
 * @param {Object} event Probe event record.
 * @param {number} fromT Probe milliseconds the line is relative to.
 * @return {string} Line such as "+204 seeking ct=55.2 rs=1 ns=2 play rate=1".
 */
export function formatEvent(event, fromT) {
  return [
    `+${Math.round(event.t - fromT)}`,
    event.type,
    `ct=${event.ct}`,
    `rs=${event.rs}`,
    `ns=${event.ns}`,
    event.paused ? 'paused' : 'play',
    `rate=${event.rate}`,
  ].join(' ');
}

/**
 * Counts media events per type, in order of first appearance.
 *
 * @param {Object[]} events Probe event records.
 * @return {Object} Count per event type.
 */
export function countEvents(events) {
  const counts = {};
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
  return counts;
}

/**
 * Bounds a log: keeps the first entries and says how many were left out.
 *
 * @param {string[]} list Log lines.
 * @param {number} max Most entries to keep.
 * @return {string[]} The list, or its first `max` entries plus a marker.
 */
export function capEntries(list, max) {
  if (list.length <= max) return list;
  return [...list.slice(0, max), `... ${list.length - max} more`];
}

/**
 * Compact writes line such as "playbackRate=0@204 currentTime=55.2@1000",
 * cut at a whole write once it passes `maxChars`.
 *
 * @param {Object[]} writes Probe write records, ordered by time.
 * @param {number} fromT Probe milliseconds the offsets are relative to.
 * @param {number} maxChars Most characters of writes to list.
 * @return {string} The line, "none" for no writes, "...+N" for the cut ones.
 */
export function summarizeWrites(writes, fromT, maxChars) {
  if (writes.length === 0) return 'none';
  const tokens = writes.map((w) => `${w.prop}=${round(w.value)}@${Math.round(w.t - fromT)}`);
  let text = '';
  let kept = 0;
  for (const token of tokens) {
    const next = kept === 0 ? token : `${text} ${token}`;
    if (next.length > maxChars) break;
    text = next;
    kept += 1;
  }
  const rest = tokens.length - kept;
  return rest > 0 ? `${text} ...+${rest}`.trim() : text;
}

/**
 * Everything the probe saw inside one window: the ordered writes and media
 * events, the once-per-second state trace and compact summaries of both.
 *
 * @param {Object} log Probe log with samples, writes and events.
 * @param {number} fromT Window start in probe milliseconds, inclusive.
 * @param {number} toT Window end in probe milliseconds, exclusive.
 * @return {Object} Bounded, printable diagnostics for the window.
 */
export function windowDiagnostics(log, fromT, toT) {
  const win = sliceLog(log, fromT, toT);
  return {
    spanMs: Math.round(toT - fromT),
    eventCounts: countEvents(win.events),
    writeSummary: summarizeWrites(win.writes, fromT, WRITE_SUMMARY_CHARS),
    writes: capEntries(win.writes.map((w) => formatWrite(w, fromT)), DETAIL_CAP),
    events: capEntries(win.events.map((e) => formatEvent(e, fromT)), DETAIL_CAP),
    trace: capEntries(stateTrace(win.samples, fromT), TRACE_CAP),
  };
}

/**
 * Maps the aria-label of the play button to the state it announces.
 *
 * @param {?string} label "Pause" while playing, "Unpause" while paused.
 * @return {?boolean} True when the app says paused, null when unknown.
 */
export function stateFromLabel(label) {
  if (label === 'Unpause') return true;
  if (label === 'Pause') return false;
  return null;
}

/**
 * Rounds to a fixed number of decimals.
 *
 * @param {number} value Number to round.
 * @param {number=} digits Decimals to keep.
 * @return {number} Rounded number.
 */
export function round(value, digits = 3) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

const STATUS_TEXT = { pass: 'pass', fail: 'FAIL', skip: 'skip', info: 'info' };

function formatMeasured(measured) {
  if (!measured) return '';
  return Object.entries(measured)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(', ')
    .replace(/\|/g, '/');
}

const DIAGNOSTICS_NOTE = 'Values are median/max. Round trip is a WebDriver execute call, '
  + 'trivial is the clock read alone, lag is the drift of an in-page 100 ms timer. '
  + 'Writes are prop=value@ms from the start of each window. '
  + 'The ordered logs and 1 Hz traces are in results.json under steps[].diagnostics.';

function formatStats(label, stats) {
  return !stats || stats.n === 0 ? `${label} n/a` : `${label} ${stats.median}/${stats.max} ms (n=${stats.n})`;
}

function formatCounts(counts = {}) {
  const entries = Object.entries(counts);
  return entries.length === 0 ? 'none' : entries.map(([type, n]) => `${type}:${n}`).join(' ');
}

function formatResponsiveness(responsiveness) {
  if (!responsiveness) return '';
  if (typeof responsiveness === 'string') return ` ${responsiveness}`;
  return ` ${formatStats('round trip', responsiveness.roundTripMs)}, ${formatStats('trivial', responsiveness.trivialRoundTripMs)}`
    + `, ${formatStats('lag', responsiveness.pageLagMs)}`;
}

function formatWindow(name, detail) {
  if (typeof detail === 'string') return `  - ${name}: ${detail}`;
  return `  - ${name}: events ${formatCounts(detail.eventCounts)}; writes ${detail.writeSummary}`;
}

function diagnosticsLines(steps) {
  const lines = [];
  for (const step of steps) {
    if (!step.diagnostics) continue;
    lines.push(`- ${step.id}:${formatResponsiveness(step.diagnostics.responsiveness)}`);
    for (const [name, detail] of Object.entries(step.diagnostics.windows || {})) {
      lines.push(formatWindow(name, detail));
    }
  }
  return lines;
}

/**
 * Renders the results as a markdown report.
 *
 * @param {Object} results Results object written by the recorder.
 * @return {string} Markdown text.
 */
export function renderMarkdown(results) {
  const lines = [];
  lines.push(`# Device evidence: ${results.job} (${results.label})`);
  lines.push('');
  lines.push(`- Device: ${results.device}`);
  lines.push(`- OS: ${results.os}`);
  lines.push(`- Target: ${results.target}`);
  lines.push(`- Label: ${results.label}. This is not a physical device.`);
  if (results.facts) {
    lines.push('');
    lines.push('## Facts');
    lines.push('');
    for (const [key, value] of Object.entries(results.facts)) {
      lines.push(`- ${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
    }
  }
  lines.push('');
  lines.push('## Steps');
  lines.push('');
  lines.push('| Step | Title | Result | Measured |');
  lines.push('| --- | --- | --- | --- |');
  for (const step of results.steps) {
    const detail = step.status === 'skip' ? step.reason : formatMeasured(step.measured);
    lines.push(`| ${step.id} | ${step.title} | ${STATUS_TEXT[step.status] || step.status} | ${detail} |`);
  }
  const failed = results.steps.flatMap((step) => (step.assertions || [])
    .filter((a) => !a.ok)
    .map((a) => `- ${step.id} ${a.name}: expected ${a.expected}, actual ${a.actual}`));
  if (failed.length > 0) {
    lines.push('');
    lines.push('## Failed assertions');
    lines.push('');
    lines.push(...failed);
  }
  const skipped = results.steps.filter((step) => step.status === 'skip');
  if (skipped.length > 0) {
    lines.push('');
    lines.push('## Not covered');
    lines.push('');
    for (const step of skipped) lines.push(`- ${step.title}: ${step.reason}`);
  }
  const diagnostics = diagnosticsLines(results.steps);
  if (diagnostics.length > 0) {
    lines.push('');
    lines.push('## Diagnostics');
    lines.push('');
    lines.push(DIAGNOSTICS_NOTE);
    lines.push('');
    lines.push(...diagnostics);
  }
  lines.push('');
  return lines.join('\n');
}
