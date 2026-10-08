/**
 * Pure helpers that turn the in-page probe log into numbers and the numbers
 * into a results report. Nothing here touches a browser, so it runs under
 * `node --test`.
 */

const SECONDS_PER_DAY = 86400;
const POINTER_ERROR_PX = 3;
const LANDING_SLACK_SECONDS = 3;

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
  lines.push('');
  return lines.join('\n');
}
