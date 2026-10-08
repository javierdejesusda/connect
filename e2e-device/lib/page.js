import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { firstAdvanceAt } from './analysis.js';

const PROBE_SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'probe.js'), 'utf8');
const HIT_TOLERANCE_PX = 14;

/**
 * Driver side helpers around the in-page probe.
 *
 * Taps are trusted input events. On iOS they are native taps whose screen
 * position is calibrated against a transparent overlay, on Android they are
 * W3C touch actions through chromedriver. A synthetic dispatch is only a last
 * resort and is always reported as such.
 *
 * @param {Object} browser WebdriverIO browser.
 * @param {{platform: string}} options 'ios', 'android' or 'desktop'.
 * @return {Object} Page helpers.
 */
export function createPage(browser, { platform }) {
  let iosOrigin = { x: 0, y: 0 };
  let iosNativeWorks = true;

  async function installProbe() {
    return browser.execute(`${PROBE_SOURCE}\nreturn window.__ev.info();`);
  }

  async function ensureProbe() {
    const present = await browser.execute('return !!window.__ev;');
    return present ? browser.execute('return window.__ev.info();') : installProbe();
  }

  async function open(url) {
    const origin = new URL(url).origin;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await browser.url(url);
      const href = await browser.execute('return location.href;');
      if (href.startsWith(origin)) break;
      await browser.pause(2000);
    }
    return installProbe();
  }

  const now = () => browser.execute('return window.__ev.now();');
  const snap = () => browser.execute('return window.__ev.snap();');
  const logSince = (from) => browser.execute('return window.__ev.log(arguments[0]);', from);

  async function waitFor(condition, { timeout, interval = 400 }) {
    const start = Date.now();
    for (;;) {
      const value = await condition();
      if (value) return value;
      if (Date.now() - start > timeout) return null;
      await browser.pause(interval);
    }
  }

  async function nativeTap(x, y) {
    try {
      await browser.execute('mobile: tap', { x: Math.round(x), y: Math.round(y) });
    } catch (error) {
      await browser.action('pointer', { parameters: { pointerType: 'touch' } })
        .move({ x: Math.round(x), y: Math.round(y) })
        .down()
        .pause(40)
        .up()
        .perform();
    }
  }

  async function calibrateIos() {
    const pad = await browser.execute('return window.__ev.calibrate();');
    const from = await now();
    const cx = pad.width / 2;
    const cy = pad.height / 2;
    await nativeTap(cx + iosOrigin.x, cy + iosOrigin.y);
    await browser.pause(300);
    const log = await logSince(from);
    await browser.execute('window.__ev.endCalibration();');
    const down = log.input.find((e) => e.trusted && (e.type === 'pointerdown' || e.type === 'touchstart'));
    if (!down) {
      iosNativeWorks = false;
      return { ok: false, origin: iosOrigin };
    }
    iosOrigin = { x: cx + iosOrigin.x - down.x, y: cy + iosOrigin.y - down.y };
    iosNativeWorks = true;
    return { ok: true, origin: iosOrigin };
  }

  async function w3cTap(x, y) {
    await browser.action('pointer', { parameters: { pointerType: 'touch' } })
      .move({ x: Math.round(x), y: Math.round(y), origin: 'viewport' })
      .down()
      .pause(40)
      .up()
      .perform();
  }

  /**
   * Taps an element of the app.
   *
   * @param {Object} spec Probe target: {name, index?, fx?} or {text}.
   * @return {Promise<Object>} How the tap was delivered and where it landed.
   */
  async function tap(spec) {
    const from = await now();
    const target = await browser.execute('return window.__ev.target(arguments[0]);', spec);
    if (!target.found) throw new Error(`tap target not found: ${JSON.stringify(spec)}`);
    let method = platform === 'ios' ? 'native-tap' : 'w3c-touch';
    if (platform === 'ios' && iosNativeWorks) {
      await nativeTap(target.x + iosOrigin.x, target.y + iosOrigin.y);
    } else if (platform !== 'ios') {
      await w3cTap(target.x, target.y);
    }
    await browser.pause(150);
    let log = await logSince(from);
    let trusted = log.input.filter((e) => e.trusted);
    if (trusted.length === 0 && platform === 'ios' && iosNativeWorks) {
      const calibration = await calibrateIos();
      method = `native-tap-recalibrated(${calibration.ok})`;
      if (calibration.ok) {
        const retargeted = await browser.execute('return window.__ev.target(arguments[0]);', spec);
        await nativeTap(retargeted.x + iosOrigin.x, retargeted.y + iosOrigin.y);
        await browser.pause(150);
        log = await logSince(from);
        trusted = log.input.filter((e) => e.trusted);
      }
    }
    if (trusted.length === 0) {
      await browser.execute('return window.__ev.syntheticTap(arguments[0]);', spec);
      return { method: 'synthetic-fallback', trusted: false, target };
    }
    const down = trusted.find((e) => e.type === 'pointerdown' || e.type === 'touchstart') || trusted[0];
    const errPx = Math.max(Math.abs(down.x - target.x), Math.abs(down.y - target.y));
    const clickT = (trusted.filter((e) => e.type === 'click').pop() || down).t;
    if (platform === 'ios' && errPx > HIT_TOLERANCE_PX) {
      await calibrateIos();
      method = `${method}(miss ${Math.round(errPx)}px, recalibrated)`;
    }
    return {
      method,
      trusted: true,
      target,
      hit: { x: down.x, y: down.y, target: down.target },
      errPx: Math.round(errPx * 10) / 10,
      clickT,
      from,
    };
  }

  async function waitForFirstFrame(sinceT, timeout, minDelta = 0.25) {
    return waitFor(async () => {
      const log = await logSince(sinceT);
      const advance = firstAdvanceAt(log.samples, minDelta);
      return advance ? { advance, log } : null;
    }, { timeout, interval: 500 });
  }

  async function holdUntil(probeT) {
    for (;;) {
      const t = await now();
      if (t >= probeT) return t;
      await browser.pause(Math.min(500, Math.max(50, probeT - t)));
    }
  }

  async function startCalibration() {
    if (platform !== 'ios') return null;
    return calibrateIos();
  }

  return {
    installProbe,
    ensureProbe,
    open,
    now,
    snap,
    logSince,
    waitFor,
    waitForFirstFrame,
    holdUntil,
    tap,
    startCalibration,
    iosOrigin: () => iosOrigin,
  };
}
