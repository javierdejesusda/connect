import { join } from 'node:path';

import { browser } from '@wdio/globals';

import {
  advanceOver,
  clockDelta,
  countWrites,
  keepsAdvancing,
  landingTolerance,
  lastSpinnerAt,
  loopAdvance,
  parseClockText,
  playingSteadily,
  sampleTrace,
  sliceLog,
  speedAdvanceOk,
  startConsistent,
  stateFromLabel,
  withinWallTime,
  wrapDelta,
} from '../lib/analysis.js';
import { createPage } from '../lib/page.js';
import { createRecorder } from '../lib/recorder.js';
import { startSimulatorRecording, stopSimulatorRecording } from '../lib/recording.js';

const env = process.env;
const JOB = env.JOB || 'desktop';
const PLATFORM = env.PLATFORM || 'desktop';
const TARGET_URL = env.TARGET_URL || 'https://906.connect-d5y.pages.dev/demo';
const OUT_DIR = env.OUT_DIR || 'out';
const LABEL = env.EVIDENCE_LABEL || 'simulator/emulator (CI)';
const DRIVE_INDEX = Number(env.DRIVE_INDEX || 0);
const DEEPLINK_REPEATS = Number(env.DEEPLINK_REPEATS || 3);
const FIRST_FRAME_TIMEOUT = Number(env.FIRST_FRAME_TIMEOUT || 45000);
const RESUME_TIMEOUT = Number(env.RESUME_TIMEOUT || 30000);
const STEADY_MS = 10000;
const RANGE_START = 10;
const RANGE_END = 20;
const SLOW_RESUME_MS = 8000;
const ORIGIN = new URL(TARGET_URL).origin;
const EXPECTED_PATH = JOB === 'iphone' ? 'native-hls' : 'mse';

const recorder = createRecorder({
  outDir: OUT_DIR,
  meta: {
    job: JOB,
    label: LABEL,
    device: env.DEVICE_NAME || JOB,
    os: env.OS_LABEL || PLATFORM,
    target: TARGET_URL,
  },
});
const page = createPage(browser, { platform: PLATFORM });

const state = { dongle: null, logId: null, duration: null, clock0: null, ct0: null };
let simRecording = null;

async function listReady() {
  return page.waitFor(async () => {
    const snap = await page.snap();
    return snap.entries > 0 ? snap : null;
  }, { timeout: 60000, interval: 700 });
}

async function recordDiagnostics(s, label) {
  try {
    s.measure(`${label}.diagnostics`, await page.diag());
  } catch (error) {
    s.measure(`${label}.diagnostics`, `unavailable: ${error.message}`);
  }
}

async function openDrive(s, index, label) {
  const sinceT = await page.now();
  const tap = await page.tap({ name: 'entry', index });
  s.input(tap);
  const frame = await page.waitForFirstFrame(sinceT, FIRST_FRAME_TIMEOUT);
  const clickT = tap.clickT ?? sinceT;
  const log = await page.logSince(sinceT);
  const spinnerEnd = lastSpinnerAt(log.samples);
  const stillSpinning = await page.snap();
  if (frame === null) await recordDiagnostics(s, label);
  s.check(`${label}: first frame shows and the clock advances within ${FIRST_FRAME_TIMEOUT} ms`, frame !== null,
    frame ? Math.round(frame.advance.t - clickT) : null, `<= ${FIRST_FRAME_TIMEOUT}`);
  s.check(`${label}: loading spinner is gone`, stillSpinning.video && !stillSpinning.video.spinner,
    stillSpinning.video ? stillSpinning.video.spinner : 'no video', false);
  s.measure(`${label}.timeToFirstFrameMs`, frame ? Math.round(frame.advance.t - clickT) : null);
  s.measure(`${label}.spinnerLastSeenMsAfterTap`, spinnerEnd === null ? null : Math.round(spinnerEnd - clickT));
  return { frame, clickT, sinceT };
}

async function backToList(s) {
  const tap = await page.tap({ name: 'close' });
  s.input(tap);
  const snap = await listReady();
  s.check('back on the drive list', snap !== null, snap ? snap.entries : 0, '> 0 entries');
}

function writesBetween(log, fromT, toT) {
  return countWrites(sliceLog(log, fromT, toT).writes);
}

async function steadyAfter(sinceT, spanMs, minDelta, timeout) {
  return page.waitFor(async () => {
    const log = await page.logSince(sinceT);
    const tailFrom = log.t - spanMs - 300;
    const tail = log.samples.filter((x) => x.t >= tailFrom);
    return playingSteadily(tail, spanMs, minDelta) ? { log, tail } : null;
  }, { timeout, interval: 500 });
}

async function ensurePlaying(s) {
  const snap = await page.snap();
  if (snap.video && snap.video.paused) {
    s.input(await page.tap({ name: 'playPause' }));
    await browser.pause(800);
  }
}

describe(`playback evidence: ${JOB} (${LABEL})`, () => {
  before(async () => {
    const caps = browser.capabilities || {};
    recorder.results.os = env.OS_LABEL || caps.platformVersion || PLATFORM;
    recorder.fact('targetKind', env.TARGET_KIND || 'custom');
    recorder.fact('runtime', env.RUNTIME_ID || null);
    recorder.fact('xcode', env.XCODE_VERSION || null);
    recorder.fact('runnerImage', env.RUNNER_IMAGE || null);
    recorder.fact('gitSha', env.GITHUB_SHA || null);
    recorder.fact('workflowRun', env.GITHUB_RUN_ID || null);
    if (env.ANDROID_FACTS) recorder.fact('android', env.ANDROID_FACTS);
    if (PLATFORM === 'ios' && env.UDID) {
      simRecording = startSimulatorRecording(env.UDID, join(OUT_DIR, `${JOB}-raw.mp4`), join(OUT_DIR, 'simctl-record.log'));
    }
    const info = await page.open(TARGET_URL);
    await listReady();
    await page.startCalibration();
    state.info = info;
  });

  after(async () => {
    await stopSimulatorRecording(simRecording);
    recorder.save();
  });

  it('S0 environment probe', async () => {
    await recorder.runStep('S0', 'environment probe (installed before the app acts)', async (s) => {
      const info = state.info;
      recorder.fact('userAgent', info.userAgent);
      recorder.fact('typeofMediaSource', info.typeofMediaSource);
      recorder.fact('typeofManagedMediaSource', info.typeofManagedMediaSource);
      recorder.fact('canPlayType hls', info.canPlayHls);
      recorder.fact('viewport', `${info.innerWidth}x${info.innerHeight}@${info.devicePixelRatio}`);
      recorder.fact('maxTouchPoints', info.maxTouchPoints);
      recorder.fact('probeInstalledBeforeAnyVideo', !info.videoPresentAtInstall);
      recorder.fact('expectedPlaybackPath', EXPECTED_PATH === 'native-hls' ? 'native HLS' : 'hls.js (MSE)');
      s.measure('typeofMediaSource', info.typeofMediaSource);
      s.measure('typeofManagedMediaSource', info.typeofManagedMediaSource);
      s.check('probe installed before any video element existed', !info.videoPresentAtInstall, info.videoPresentAtInstall, false);
      if (JOB === 'iphone') {
        s.check('iPhone runtime has no window.MediaSource, so the native HLS path is exercised',
          info.typeofMediaSource === 'undefined', info.typeofMediaSource, 'undefined');
      } else {
        s.check('runtime has window.MediaSource, so the hls.js path is exercised',
          info.typeofMediaSource === 'function' || info.typeofMediaSource === 'object', info.typeofMediaSource, 'function');
      }
    });
  });

  it('S1 open the first drive: first frame and spinner', async () => {
    await recorder.runStep('S1', 'open the first drive: first frame appears, spinner disappears', async (s) => {
      const { frame } = await openDrive(s, DRIVE_INDEX, 'open');
      const snap = await page.snap();
      const match = /^https?:\/\/[^/]+\/(\w{16})\/([^/?#]+)/.exec(snap.href);
      s.check('URL is /<dongle>/<log> after opening the drive', match !== null, snap.href, '/<dongle>/<log>');
      if (match) {
        state.dongle = match[1];
        state.logId = match[2];
      }
      state.duration = snap.video ? snap.video.duration : null;
      state.clock0 = parseClockText(snap.display);
      state.ct0 = snap.video ? snap.video.ct : null;
      s.measure('drive', snap.href.replace(ORIGIN, ''));
      s.measure('routeDurationS', state.duration);
      s.measure('playbackPath', snap.path);
      s.check(`playback path is ${EXPECTED_PATH}`, snap.path === EXPECTED_PATH, snap.path, EXPECTED_PATH);
      s.check('video is playing (not paused) once the first frame shows', snap.video && !snap.video.paused,
        snap.video ? snap.video.paused : 'no video', false);
      const log = await page.logSince(0);
      s.measure('startupWrites', countWrites(log.writes));
      s.measure('mseSourceBuffers', log.mse);
      state.firstFrameT = frame ? frame.advance.t : await page.now();
    });
  });

  it('S2 steady playback for 10 s', async () => {
    await recorder.runStep('S2', 'steady playback for 10 s: no writes to currentTime or playbackRate', async (s) => {
      const startT = state.firstFrameT + 1500;
      await page.holdUntil(startT);
      await page.holdUntil(startT + STEADY_MS);
      const log = await page.logSince(startT);
      const win = sliceLog(log, startT, startT + STEADY_MS);
      const writes = countWrites(win.writes);
      const adv = advanceOver(win.samples);
      const waits = win.events.filter((e) => e.type === 'waiting').length;
      const spinnerSamples = win.samples.filter((x) => x.spin).length;
      s.measure('writes', writes);
      s.measure('mediaSecondsAdvanced', adv.delta);
      s.measure('wallSeconds', adv.wallSeconds);
      s.measure('waitingEvents', waits);
      s.measure('spinnerSamples', spinnerSamples);
      s.measure('writeSites', win.writes.slice(0, 5).map((w) => `${w.prop}:${w.source}:${w.site[0] || ''}`));
      s.check('0 writes to currentTime', writes.currentTime === 0, writes.currentTime, 0);
      s.check('0 writes to playbackRate', writes.playbackRate === 0, writes.playbackRate, 0);
      s.check('media clock advances at about 1x', speedAdvanceOk(1, adv.wallSeconds, adv.delta), adv.delta, `~${adv.wallSeconds}`);
      const pausedSamples = win.samples.filter((x) => x.paused).length;
      s.check('video never reports paused', pausedSamples === 0, pausedSamples, 0);
    });
  });

  it('S3 seek while playing and while paused', async () => {
    await recorder.runStep('S3', 'seek by clicking the timeline: playing at 3 points, then paused', async (s) => {
      const duration = state.duration;
      for (const [index, frac] of [0.25, 0.55, 0.85].entries()) {
        const label = `seek ${index + 1} (${Math.round(frac * 100)}%, playing)`;
        const tap = await page.tap({ name: 'ruler', fx: frac });
        s.input(tap);
        const clickT = tap.from;
        const x = tap.hit ? tap.hit.x : tap.target.x;
        const expected = ((x - tap.target.left) / tap.target.width) * duration;
        const tol = landingTolerance(tap.target.width, duration);
        const steady = await page.waitFor(async () => {
          const log = await page.logSince(clickT);
          const tail = log.samples.filter((smp) => smp.t >= log.t - 1500);
          const last = tail[tail.length - 1];
          const near = last && Math.abs(last.ct - expected) <= tol + 25;
          return near && playingSteadily(tail, 1200, 0.5) ? log : null;
        }, { timeout: RESUME_TIMEOUT, interval: 500 });
        await browser.pause(1500);
        const log = await page.logSince(clickT);
        const settledT = log.t;
        const seeked = log.events.find((e) => e.type === 'seeked');
        const landing = seeked ? seeked.ct : null;
        const writes = writesBetween(log, clickT, settledT);
        const last = log.samples[log.samples.length - 1];
        const resumeMs = steady ? Math.round(steady.samples[steady.samples.length - 1].t - clickT) : null;
        s.measure(`${label}.expectedS`, Math.round(expected * 10) / 10);
        s.measure(`${label}.landingS`, landing);
        s.measure(`${label}.tapErrPx`, tap.errPx ?? null);
        s.measure(`${label}.timeToResumeMs`, resumeMs);
        if (resumeMs === null || resumeMs > SLOW_RESUME_MS) {
          s.measure(`${label}.trace`, sampleTrace(sliceLog(log, clickT, settledT).samples, clickT, 1000).slice(0, 45));
        }
        s.measure(`${label}.writes`, writes);
        s.measure(`${label}.writeSites`, sliceLog(log, clickT, settledT).writes.slice(0, 4).map((w) => `${w.prop}:${w.source}:${w.site[0] || ''}`));
        s.check(`${label}: playback resumed within ${RESUME_TIMEOUT} ms`, steady !== null, steady !== null, true);
        s.check(`${label}: seeked event fired`, seeked !== undefined, seeked !== undefined, true);
        s.check(`${label}: landed within ${tol.toFixed(1)} s of the clicked position`,
          landing !== null && Math.abs(landing - expected) <= tol,
          landing === null ? null : Math.round(Math.abs(landing - expected) * 10) / 10, `<= ${tol.toFixed(1)}`);
        s.check(`${label}: still playing, not paused`, last && last.paused === false, last ? last.paused : null, false);
        s.check(`${label}: no stuck spinner`, last && last.spin === false, last ? last.spin : null, false);
        s.check(`${label}: at most 1 app write to currentTime`, writes.appCurrentTime <= 1, writes.appCurrentTime, '<= 1');
        s.check(`${label}: 0 writes to playbackRate`, writes.playbackRate === 0, writes.playbackRate, 0);
      }

      s.input(await page.tap({ name: 'playPause' }));
      await browser.pause(800);
      const paused = await page.snap();
      s.check('paused before the paused seek (element and button agree)',
        paused.video.paused === true && stateFromLabel(paused.playLabel) === true,
        `${paused.video.paused}/${paused.playLabel}`, 'true/Unpause');

      const label = 'seek 4 (40%, paused)';
      const tap = await page.tap({ name: 'ruler', fx: 0.4 });
      s.input(tap);
      const clickT = tap.from;
      const x = tap.hit ? tap.hit.x : tap.target.x;
      const expected = ((x - tap.target.left) / tap.target.width) * duration;
      const tol = landingTolerance(tap.target.width, duration);
      await browser.pause(5000);
      const snap = await page.snap();
      const log = await page.logSince(clickT);
      const writes = writesBetween(log, clickT, log.t);
      const tail = log.samples.filter((smp) => smp.t >= log.t - 2000);
      const moved = advanceOver(tail).delta;
      s.measure(`${label}.expectedS`, Math.round(expected * 10) / 10);
      s.measure(`${label}.tapErrPx`, tap.errPx ?? null);
      s.measure(`${label}.currentTimeS`, snap.video.ct);
      s.measure(`${label}.movedInLast2sS`, moved);
      s.measure(`${label}.writes`, writes);
      s.check(`${label}: stays paused (element)`, snap.video.paused === true, snap.video.paused, true);
      s.check(`${label}: stays paused (button says Unpause)`, stateFromLabel(snap.playLabel) === true, snap.playLabel, 'Unpause');
      s.check(`${label}: frame loaded at the new position`, snap.video.rs >= 2 && !snap.video.seeking, `rs=${snap.video.rs} seeking=${snap.video.seeking}`, 'rs>=2, not seeking');
      s.check(`${label}: landed within ${tol.toFixed(1)} s`, Math.abs(snap.video.ct - expected) <= tol,
        Math.round(Math.abs(snap.video.ct - expected) * 10) / 10, `<= ${tol.toFixed(1)}`);
      s.check(`${label}: no stuck spinner`, snap.video.spinner === false, snap.video.spinner, false);
      s.check(`${label}: clock does not advance while paused`, moved < 0.3, moved, '< 0.3');
      s.check(`${label}: at most 1 app write to currentTime`, writes.appCurrentTime <= 1, writes.appCurrentTime, '<= 1');
      s.check(`${label}: 0 writes to playbackRate`, writes.playbackRate === 0, writes.playbackRate, 0);

      s.input(await page.tap({ name: 'playPause' }));
      const sinceT = await page.now();
      const resumed = await steadyAfter(sinceT, 1200, 0.5, RESUME_TIMEOUT);
      s.check('playback resumes after unpausing following the paused seek', resumed !== null, resumed !== null, true);
    });
  });

  it('S4 pause and play five times quickly', async () => {
    await recorder.runStep('S4', 'pause/play 5 times quickly: element state matches the button', async (s) => {
      await ensurePlaying(s);
      const rounds = [];
      for (let i = 1; i <= 5; i += 1) {
        for (const wantPaused of [true, false]) {
          s.input(await page.tap({ name: 'playPause' }));
          await browser.pause(500);
          const snap = await page.snap();
          const labelPaused = stateFromLabel(snap.playLabel);
          rounds.push({ round: i, wantPaused, elementPaused: snap.video.paused, label: snap.playLabel });
          s.check(`round ${i} ${wantPaused ? 'pause' : 'play'}: element paused=${wantPaused}`,
            snap.video.paused === wantPaused, snap.video.paused, wantPaused);
          s.check(`round ${i} ${wantPaused ? 'pause' : 'play'}: button label agrees with the element`,
            labelPaused === snap.video.paused, `${snap.playLabel}/${snap.video.paused}`, 'consistent');
        }
      }
      s.measure('rounds', rounds.length);
      const burst = await browser.execute(`
        var btn = function () { return document.querySelector('[aria-label="Pause"], [aria-label="Unpause"]'); };
        var n = 0;
        window.__burstDone = false;
        var timer = setInterval(function () {
          btn().click();
          n += 1;
          if (n >= 8) { clearInterval(timer); window.__burstDone = true; }
        }, 120);
        return true;
      `);
      s.measure('burst', 'in-page synthetic clicks, 8 toggles at 120 ms (not trusted input)');
      await page.waitFor(() => browser.execute('return window.__burstDone === true;'), { timeout: 8000, interval: 300 });
      await browser.pause(1200);
      const after = await page.snap();
      s.check('after the synthetic burst the element agrees with the button',
        stateFromLabel(after.playLabel) === after.video.paused, `${after.playLabel}/${after.video.paused}`, 'consistent');
      s.check('burst of an even number of toggles leaves playback running', after.video.paused === false, after.video.paused, false);
      s.check('burst started', burst === true, burst, true);
      await ensurePlaying(s);
      const sinceT = await page.now();
      const resumed = await steadyAfter(sinceT, 1200, 0.5, RESUME_TIMEOUT);
      s.check('playing steadily after the toggles', resumed !== null, resumed !== null, true);
    });
  });

  it('S5 speed buttons', async () => {
    const hasSpeedButtons = state.info.typeofMediaSource !== 'undefined';
    await recorder.runStep('S5', hasSpeedButtons
      ? 'speed buttons: up to 8x and down to 0.1x, video keeps advancing'
      : 'speed buttons must not exist when window.MediaSource is undefined (native HLS)', async (s) => {
      const snap = await page.snap();
      if (!hasSpeedButtons) {
        s.check('no "Increase play speed" button', snap.hasIncrease === false, snap.hasIncrease, false);
        s.check('no "Decrease play speed" button', snap.hasDecrease === false, snap.hasDecrease, false);
        return;
      }
      s.check('speed buttons are present', snap.hasIncrease && snap.hasDecrease, `${snap.hasIncrease}/${snap.hasDecrease}`, 'true/true');
      if (snap.video && snap.video.ct > state.duration * 0.35) {
        const rewind = await page.tap({ name: 'ruler', fx: 0.1 });
        s.input(rewind);
        s.measure('headroom', 'sought back to 10% of the drive so 8x cannot reach the end and loop');
        await steadyAfter(rewind.from, 1200, 0.5, RESUME_TIMEOUT);
      }
      const plan = [
        ['faster', 2], ['faster', 4], ['faster', 8],
        ['slower', 4], ['slower', 2], ['slower', 1], ['slower', 0.5], ['slower', 0.25], ['slower', 0.1],
      ];
      for (const [button, rate] of plan) {
        const tap = await page.tap({ name: button });
        s.input(tap);
        const tapT = tap.from;
        const winFrom = (tap.clickT ?? tap.from + 2000) + 1200;
        await page.holdUntil(winFrom + 3000);
        const log = await page.logSince(tapT);
        const win = sliceLog(log, winFrom, winFrom + 3000);
        const adv = advanceOver(win.samples);
        const writes = writesBetween(log, tapT, winFrom + 3000);
        const last = win.samples[win.samples.length - 1];
        const label = `${rate}x`;
        s.measure(`${label}.mediaSecondsIn3s`, adv.delta);
        s.measure(`${label}.writes`, writes);
        s.check(`${label}: playbackRate is ${rate}`, last && last.rate === rate, last ? last.rate : null, rate);
        s.measure(`${label}.throughputRatio`, adv.wallSeconds > 0 ? Math.round((adv.delta / (rate * adv.wallSeconds)) * 100) / 100 : null);
        s.check(`${label}: video keeps advancing (not frozen, not runaway)`, keepsAdvancing(rate, adv.wallSeconds, adv.delta),
          adv.delta, `requested ${Math.round(rate * adv.wallSeconds * 100) / 100} in ${adv.wallSeconds} s`);
        s.check(`${label}: not paused`, last && last.paused === false, last ? last.paused : null, false);
        s.check(`${label}: 0 app writes to currentTime for a speed change`, writes.appCurrentTime === 0, writes.appCurrentTime, 0);
        s.check(`${label}: at most 1 write to playbackRate`, writes.playbackRate <= 1, writes.playbackRate, '<= 1');
      }
      for (let i = 0; i < 3; i += 1) {
        s.input(await page.tap({ name: 'faster' }));
        await browser.pause(600);
      }
      await browser.pause(1500);
      const end = await page.snap();
      s.check('speed is back to 1x', end.video.rate === 1, end.video.rate, 1);
    });
  });

  it('S6 switch to the map and back', async () => {
    await recorder.runStep('S6', 'switch to the map view and back: time keeps advancing', async (s) => {
      await ensurePlaying(s);
      const before = await page.snap();
      s.input(await page.tap({ text: 'Map' }));
      await browser.pause(4000);
      const inMap = await page.snap();
      const mapDelta = clockDelta(parseClockText(before.display), parseClockText(inMap.display));
      s.measure('mapView.displayedTimeDeltaS', mapDelta);
      s.measure('mapView.videoMounted', inMap.video !== null);
      const mapWall = (inMap.t - before.t) / 1000;
      s.measure('mapView.wallSecondsBetweenReadings', Math.round(mapWall * 10) / 10);
      s.check('displayed time advances with real time while the map is shown', withinWallTime(mapDelta, mapWall, 2.5), mapDelta, `${Math.round(mapWall * 10) / 10} +/- 2.5 s`);
      s.input(await page.tap({ text: 'Video' }));
      const sinceT = await page.now();
      const resumed = await steadyAfter(sinceT, 1200, 0.5, RESUME_TIMEOUT);
      const back = await page.snap();
      const backDelta = clockDelta(parseClockText(inMap.display), parseClockText(back.display));
      s.measure('backToVideo.displayedTimeDeltaS', backDelta);
      s.check('video plays steadily after switching back', resumed !== null, resumed !== null, true);
      const backWall = (back.t - inMap.t) / 1000;
      s.check('displayed time kept advancing across the round trip', withinWallTime(backDelta, backWall, 2.5), backDelta, `${Math.round(backWall * 10) / 10} +/- 2.5 s`);
      s.check('no stuck spinner after switching back', back.video && back.video.spinner === false, back.video ? back.video.spinner : 'no video', false);
    });
  });

  it('S7 reopen the same drive, then the next one', async () => {
    await recorder.runStep('S7', 'back to the list, open the same drive again, then the next one: loads and plays at 1x', async (s) => {
      await backToList(s);
      const again = await openDrive(s, DRIVE_INDEX, 'same drive');
      const snapA = await page.snap();
      s.check('same drive: playing at 1x', snapA.video && snapA.video.rate === 1 && !snapA.video.paused,
        snapA.video ? `${snapA.video.rate}/${snapA.video.paused}` : 'no video', '1/false');
      s.check('same drive: URL is the first drive again', snapA.href.includes(`/${state.dongle}/${state.logId}`), snapA.href, state.logId);
      const logA = await page.logSince(again.sinceT);
      s.measure('same drive.startupWrites', countWrites(logA.writes));
      await backToList(s);
      const next = await openDrive(s, DRIVE_INDEX + 1, 'next drive');
      const snapB = await page.snap();
      s.check('next drive: playing at 1x', snapB.video && snapB.video.rate === 1 && !snapB.video.paused,
        snapB.video ? `${snapB.video.rate}/${snapB.video.paused}` : 'no video', '1/false');
      s.check('next drive: a different drive is open', !snapB.href.includes(state.logId), snapB.href, `not ${state.logId}`);
      const logB = await page.logSince(next.sinceT);
      s.measure('next drive.startupWrites', countWrites(logB.writes));
      const steady = await steadyAfter(await page.now(), 3000, 1.5, 15000);
      s.check('next drive: steady playback for 3 s', steady !== null, steady !== null, true);
    });
  });

  it('S8 deep link with a time range', async () => {
    await recorder.runStep('S8', 'deep link /<dongle>/<log>/10/20: starts near 10 s and advances', async (s) => {
      const url = `${ORIGIN}/${state.dongle}/${state.logId}/10/20`;
      s.measure('url', url.replace(ORIGIN, ''));
      for (let i = 1; i <= DEEPLINK_REPEATS; i += 1) {
        const label = `deep link ${i}/${DEEPLINK_REPEATS}`;
        const info = await page.open(url);
        const sinceT = 0;
        const frame = await page.waitForFirstFrame(sinceT, FIRST_FRAME_TIMEOUT, 0.25);
        s.measure(`${label}.videoPresentAtInstall`, info.videoPresentAtInstall);
        if (!frame) await recordDiagnostics(s, label);
        s.check(`${label}: first frame within ${FIRST_FRAME_TIMEOUT} ms`, frame !== null, frame ? Math.round(frame.advance.t) : null, `<= ${FIRST_FRAME_TIMEOUT}`);
        if (!frame) continue;
        const startCt = frame.advance.ct;
        const decoded = frame.log.samples.filter((x) => x.rs >= 2 && typeof x.ct === 'number');
        const snap0 = await page.snap();
        await browser.pause(4000);
        const snap1 = await page.snap();
        const log = await page.logSince(frame.advance.t);
        const span = RANGE_END - RANGE_START;
        const adv = loopAdvance(log.samples.filter((x) => x.t <= frame.advance.t + 4000), span);
        const shown = clockDelta(state.clock0, parseClockText(snap0.display));
        const shownAdvance = wrapDelta(clockDelta(parseClockText(snap0.display), parseClockText(snap1.display)), span);
        const observedStart = !info.videoPresentAtInstall;
        const navS = (frame.log.navMsAtInstall + frame.advance.t) / 1000;
        const navAtSnapS = (frame.log.navMsAtInstall + snap0.t) / 1000;
        s.measure(`${label}.startCurrentTimeS`, startCt);
        s.measure(`${label}.secondsSinceNavigationAtFirstFrame`, Math.round(navS * 10) / 10);
        s.measure(`${label}.decodedSamplesBeforeRangeStart`, decoded.filter((x) => x.ct < 5).length);
        s.measure(`${label}.displayedOffsetFromDriveStartS`, shown);
        s.measure(`${label}.advancedIn4sS`, adv.delta);
        s.measure(`${label}.writes`, countWrites(log.writes));
        if (observedStart) {
          s.check(`${label}: video time starts near 10 s`, startCt !== null && startCt >= 8 && startCt <= 14, startCt, '8..14');
          s.check(`${label}: reported time starts near 10 s after the drive start`, shown !== null && shown >= 7 && shown <= 16, shown, '7..16');
        } else {
          s.check(`${label}: first video time seen fits a start at 10 s (probe attached late, ${Math.round(navS * 10) / 10} s after navigation)`,
            startConsistent({ ct: startCt, elapsedSeconds: navS, rangeStart: RANGE_START, rangeEnd: RANGE_END, tolerance: 1.5 }),
            startCt, `${RANGE_START}..${RANGE_END}, at most ${RANGE_START} + elapsed`);
          s.check(`${label}: reported time first seen fits a start at 10 s after the drive start`,
            shown !== null && shown >= 7 && startConsistent({ ct: shown, elapsedSeconds: navAtSnapS, rangeStart: RANGE_START, rangeEnd: RANGE_END, tolerance: 2.5 }),
            shown, `7..${RANGE_END}, at most ${RANGE_START} + elapsed`);
        }
        s.check(`${label}: advances after the deep link start (the 10 to 20 s range loops)`, adv.delta >= 2.5, adv.delta, '>= 2.5 in 4 s');
        s.check(`${label}: reported time advances`, shownAdvance !== null && shownAdvance >= 2, shownAdvance, '>= 2');
        s.check(`${label}: playing and no stuck spinner`, snap1.video && !snap1.video.paused && !snap1.video.spinner,
          snap1.video ? `${snap1.video.paused}/${snap1.video.spinner}` : 'no video', 'false/false');
      }
    });
  });

  it('records what cannot be automated', () => {
    const reason = JOB === 'android'
      ? 'not automated on the emulator in this workflow'
      : 'not available in the iOS Simulator';
    recorder.skip('N1', 'airplane mode for 40 s, then Retry', reason);
    recorder.skip('N2', 'Low Power Mode refusing autoplay', 'cannot be toggled in a simulator or emulator; needs a real device');
    recorder.skip('N3', 'real lock screen / app suspension and return', 'simulators and emulators do not suspend the way a phone does');
    recorder.skip('N4', 'audio and the mute control', 'the demo stream has no audio track, so the mute button is disabled');
    recorder.skip('N5', 'real device performance, thermals and memory pressure', 'a simulator or emulator is not a phone');
  });
});
