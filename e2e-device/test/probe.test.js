import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../lib/probe.js', import.meta.url), 'utf8');

const MEDIA_EVENTS = [
  'play', 'playing', 'pause', 'waiting', 'stalled', 'suspend', 'seeking', 'seeked', 'ratechange',
  'canplay', 'canplaythrough', 'loadedmetadata', 'error', 'emptied',
];

class FakeMedia {
  constructor() {
    this.stored = { currentTime: 0, playbackRate: 1 };
    this.readyState = 4;
    this.networkState = 2;
    this.paused = false;
  }

  get currentTime() { return this.stored.currentTime; }

  set currentTime(value) { this.stored.currentTime = value; }

  get playbackRate() { return this.stored.playbackRate; }

  set playbackRate(value) { this.stored.playbackRate = value; }

  play() {}

  pause() {}

  load() {}

  fastSeek() {}
}

function installProbe() {
  const listeners = {};
  const timers = [];
  const clock = { now: 0 };
  const sandbox = {
    HTMLMediaElement: FakeMedia,
    performance: { now: () => clock.now },
    setInterval: (fn, ms) => timers.push({ fn, ms }),
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: (name, fn) => { listeners[name] = fn; },
    },
    location: { href: 'https://example.test/' },
    navigator: {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(SOURCE, sandbox);
  return { ev: sandbox.__ev, listeners, timers, clock };
}

describe('in-page probe', () => {
  it('keeps the value and the previous value of each write', () => {
    const { ev } = installProbe();
    new FakeMedia().playbackRate = 0;
    const [write] = ev.log(0).writes;
    assert.equal(write.prop, 'playbackRate');
    assert.equal(write.value, 0);
    assert.equal(write.from, 1);
  });

  it('listens for every media event the diagnostics need', () => {
    const { listeners } = installProbe();
    for (const name of MEDIA_EVENTS) {
      assert.equal(typeof listeners[name], 'function', `no listener for ${name}`);
    }
  });

  it('records the network state and playback rate with each media event', () => {
    const { ev, listeners } = installProbe();
    const media = new FakeMedia();
    media.readyState = 1;
    media.networkState = 3;
    media.paused = true;
    media.playbackRate = 0.5;
    listeners.stalled({ target: media });
    const [event] = ev.log(0).events;
    assert.equal(event.type, 'stalled');
    assert.equal(event.rs, 1);
    assert.equal(event.ns, 3);
    assert.equal(event.rate, 0.5);
    assert.equal(event.paused, true);
  });

  it('tracks main thread lag with a 100 ms timer and hands it over once', () => {
    const { ev, timers, clock } = installProbe();
    const tick = timers.find((timer) => timer.ms === 100);
    assert.ok(tick, 'no 100 ms lag timer');
    clock.now = 100;
    tick.fn();
    clock.now = 337.4;
    tick.fn();
    assert.deepEqual(Array.from(ev.drainLag()), [0, 137.4]);
    assert.deepEqual(Array.from(ev.drainLag()), []);
  });
});
