/*
 * In-page probe. It is read as text and executed inside the page, so it must
 * stay plain ES5 style and must not use modules. It is installed before the
 * app opens a drive and never changes what the app does: it only records.
 *
 * It wraps the currentTime and playbackRate setters of HTMLMediaElement and
 * records each write with a timestamp, its value and the calling file. It also
 * logs media events, user input events and a 200 ms sample of the video.
 */
(function () {
  if (window.__ev) return;

  var T0 = performance.now();
  var MAX = 20000;
  var log = {
    startedAt: new Date().toISOString(),
    videoPresentAtInstall: !!document.querySelector('video'),
    writes: [],
    calls: [],
    events: [],
    input: [],
    samples: [],
    mse: { mediaSource: 0, managedMediaSource: 0 },
  };

  function now() {
    return Math.round((performance.now() - T0) * 10) / 10;
  }

  function push(list, item) {
    if (list.length < MAX) list.push(item);
  }

  function r3(n) {
    return Math.round(n * 1000) / 1000;
  }

  function callerFrames() {
    var lines = String(new Error().stack || '').split('\n');
    var frames = [];
    for (var i = 0; i < lines.length; i += 1) {
      var m = /(https?:\/\/[^\s)]*?)([^/\s)]+?):(\d+):\d+/.exec(lines[i]);
      if (m) frames.push(m[2] + ':' + m[3]);
    }
    return frames.slice(0, 3);
  }

  function sourceOf(frames) {
    if (frames.length === 0) return 'unknown';
    return /hls[.-]/i.test(frames[0]) ? 'hls.js' : 'app';
  }

  var proto = HTMLMediaElement.prototype;

  ['currentTime', 'playbackRate'].forEach(function (prop) {
    var desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get: function () {
        return desc.get.call(this);
      },
      set: function (value) {
        var frames = callerFrames();
        push(log.writes, {
          t: now(),
          prop: prop,
          value: value,
          from: desc.get.call(this),
          source: sourceOf(frames),
          site: frames,
        });
        return desc.set.call(this, value);
      },
    });
  });

  ['play', 'pause', 'load', 'fastSeek'].forEach(function (name) {
    var original = proto[name];
    if (typeof original !== 'function') return;
    proto[name] = function () {
      var frames = callerFrames();
      push(log.calls, { t: now(), fn: name, source: sourceOf(frames), site: frames });
      return original.apply(this, arguments);
    };
  });

  [['MediaSource', 'mediaSource'], ['ManagedMediaSource', 'managedMediaSource']].forEach(function (pair) {
    var Ctor = window[pair[0]];
    if (!Ctor || !Ctor.prototype || !Ctor.prototype.addSourceBuffer) return;
    var original = Ctor.prototype.addSourceBuffer;
    Ctor.prototype.addSourceBuffer = function () {
      log.mse[pair[1]] += 1;
      return original.apply(this, arguments);
    };
  });

  [
    'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'playing', 'waiting', 'seeking',
    'seeked', 'play', 'pause', 'ended', 'error', 'stalled', 'ratechange', 'emptied', 'abort',
  ].forEach(function (name) {
    document.addEventListener(name, function (e) {
      var el = e.target;
      if (!(el instanceof HTMLMediaElement)) return;
      push(log.events, {
        t: now(),
        type: name,
        ct: r3(el.currentTime),
        rs: el.readyState,
        paused: el.paused,
      });
    }, true);
  });

  function describe(el) {
    if (!el || !el.tagName) return '';
    var label = el.getAttribute && el.getAttribute('aria-label');
    return el.tagName.toLowerCase() + (label ? '[' + label + ']' : '');
  }

  ['pointerdown', 'pointerup', 'click', 'touchstart', 'touchend'].forEach(function (name) {
    document.addEventListener(name, function (e) {
      var point = (e.changedTouches && e.changedTouches[0]) || e;
      push(log.input, {
        t: now(),
        type: name,
        trusted: e.isTrusted,
        x: point.clientX,
        y: point.clientY,
        pointerType: e.pointerType || '',
        target: describe(e.target),
      });
    }, true);
  });

  function videoEl() {
    return document.querySelector('video');
  }

  function overlaps(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  }

  function spinnerOver(video) {
    var box = video.getBoundingClientRect();
    var bars = document.querySelectorAll('[role="progressbar"]');
    for (var i = 0; i < bars.length; i += 1) {
      var rect = bars[i].getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && overlaps(rect, box)) return true;
    }
    return false;
  }

  function pathOf(video) {
    if (!video) return null;
    if (video.srcObject) return 'mse';
    var src = video.currentSrc || video.src || '';
    if (src.indexOf('blob:') === 0) return 'mse';
    if (src.indexOf('m3u8') !== -1) return 'native-hls';
    return src ? 'other' : 'none';
  }

  function displayText() {
    var spans = document.querySelectorAll('span');
    for (var i = 0; i < spans.length; i += 1) {
      var s = spans[i];
      if (s.children.length === 0 && /^\d{2}:\d{2}:\d{2}/.test(s.textContent)) return s.textContent;
    }
    return null;
  }

  function labelOf(selector) {
    var el = document.querySelector(selector);
    return el ? el.getAttribute('aria-label') : null;
  }

  function bufferedEnd(video) {
    var ct = video.currentTime;
    for (var i = 0; i < video.buffered.length; i += 1) {
      if (ct >= video.buffered.start(i) - 0.05 && ct <= video.buffered.end(i) + 0.05) return r3(video.buffered.end(i));
    }
    return null;
  }

  var tick = 0;
  setInterval(function () {
    var video = videoEl();
    tick += 1;
    if (!video) {
      push(log.samples, { t: now(), none: true });
      return;
    }
    var sample = {
      t: now(),
      ct: r3(video.currentTime),
      rs: video.readyState,
      ns: video.networkState,
      paused: video.paused,
      rate: video.playbackRate,
      seeking: video.seeking,
      spin: spinnerOver(video),
    };
    if (tick % 5 === 0) {
      sample.buf = bufferedEnd(video);
      sample.disp = displayText();
    }
    push(log.samples, sample);
  }, 200);

  function snap() {
    var video = videoEl();
    return {
      t: now(),
      href: location.href,
      path: pathOf(video),
      display: displayText(),
      playLabel: labelOf('[aria-label="Pause"], [aria-label="Unpause"]'),
      hasIncrease: !!document.querySelector('[aria-label="Increase play speed by 1 step"]'),
      hasDecrease: !!document.querySelector('[aria-label="Decrease play speed by 1 step"]'),
      entries: document.querySelectorAll('a.DriveEntry').length,
      video: video ? {
        ct: r3(video.currentTime),
        duration: video.duration,
        rs: video.readyState,
        paused: video.paused,
        ended: video.ended,
        seeking: video.seeking,
        rate: video.playbackRate,
        muted: video.muted,
        currentSrc: (video.currentSrc || '').slice(0, 60),
        audioTracks: video.audioTracks ? video.audioTracks.length : null,
        spinner: spinnerOver(video),
      } : null,
    };
  }

  var SELECTORS = {
    entry: 'a.DriveEntry',
    ruler: '[role="slider"][aria-label="Drive timeline"]',
    playPause: '[aria-label="Pause"], [aria-label="Unpause"]',
    faster: '[aria-label="Increase play speed by 1 step"]',
    slower: '[aria-label="Decrease play speed by 1 step"]',
    close: '.DriveView [aria-label="Close"]',
  };

  function findTarget(spec) {
    if (spec.text) {
      var nodes = document.querySelectorAll('p, span, button, a');
      for (var i = 0; i < nodes.length; i += 1) {
        if (nodes[i].children.length === 0 && nodes[i].textContent.trim() === spec.text) return nodes[i];
      }
      return null;
    }
    var all = document.querySelectorAll(SELECTORS[spec.name]);
    return all[spec.index || 0] || null;
  }

  function usableOnScreen(el, fx) {
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (rect.top < 0 || rect.bottom > window.innerHeight || rect.left < 0 || rect.right > window.innerWidth) return false;
    var hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height / 2);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  }

  function target(spec) {
    var el = findTarget(spec);
    if (!el) return { found: false };
    var before = window.pageYOffset;
    var fx = spec.fx === undefined ? 0.5 : spec.fx;
    if (!usableOnScreen(el, fx)) {
      try {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      } catch (e) {
        el.scrollIntoView(true);
      }
    }
    var scrolled = Math.abs(window.pageYOffset - before) > 1;
    var rect = el.getBoundingClientRect();
    return {
      found: true,
      scrolled: scrolled,
      x: r3(rect.left + rect.width * fx),
      y: r3(rect.top + rect.height / 2),
      left: r3(rect.left),
      width: r3(rect.width),
      height: r3(rect.height),
      viewport: [window.innerWidth, window.innerHeight],
    };
  }

  function fire(el, type, x, y) {
    var Ctor = window.PointerEvent || window.MouseEvent;
    el.dispatchEvent(new Ctor(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: y,
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
      buttons: type === 'pointerdown' ? 1 : 0,
    }));
  }

  function syntheticTap(spec) {
    var el = findTarget(spec);
    if (!el) return false;
    var t = target(spec);
    var hit = document.elementFromPoint(t.x, t.y) || el;
    fire(hit, 'pointerdown', t.x, t.y);
    fire(hit, 'pointerup', t.x, t.y);
    hit.dispatchEvent(new MouseEvent('click', {
      bubbles: true, cancelable: true, clientX: t.x, clientY: t.y,
    }));
    return true;
  }

  function calibrate() {
    var old = document.getElementById('__calib');
    if (old) old.remove();
    var pad = document.createElement('div');
    pad.id = '__calib';
    pad.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;z-index:2147483647;background:transparent;';
    document.body.appendChild(pad);
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function endCalibration() {
    var pad = document.getElementById('__calib');
    if (pad) pad.remove();
  }

  function info() {
    var probe = document.createElement('video');
    return {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      typeofMediaSource: typeof window.MediaSource,
      typeofManagedMediaSource: typeof window.ManagedMediaSource,
      canPlayHls: probe.canPlayType('application/vnd.apple.mpegurl'),
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      href: location.href,
      videoPresentAtInstall: log.videoPresentAtInstall,
    };
  }

  function ranges(timeRanges) {
    var out = [];
    for (var i = 0; i < timeRanges.length; i += 1) {
      out.push([r3(timeRanges.start(i)), r3(timeRanges.end(i))]);
    }
    return out;
  }

  function diag() {
    var video = videoEl();
    var resources = [];
    try {
      performance.getEntriesByType('resource').forEach(function (entry) {
        if (/m3u8|qcamera|\.ts(\?|$)/.test(entry.name)) {
          resources.push({
            name: entry.name.slice(-70),
            type: entry.initiatorType,
            start: Math.round(entry.startTime),
            duration: Math.round(entry.duration),
            size: entry.transferSize,
            status: entry.responseStatus,
          });
        }
      });
    } catch (e) {
      resources.push({ error: String(e) });
    }
    return {
      snap: snap(),
      video: video ? {
        networkState: video.networkState,
        readyState: video.readyState,
        error: video.error ? { code: video.error.code, message: video.error.message } : null,
        paused: video.paused,
        ended: video.ended,
        currentTime: r3(video.currentTime),
        buffered: ranges(video.buffered),
        seekable: ranges(video.seekable),
        src: (video.currentSrc || '').slice(-80),
        preload: video.preload,
        muted: video.muted,
      } : null,
      events: log.events.slice(-25),
      calls: log.calls.slice(-10),
      writes: log.writes.slice(-10),
      resources: resources.slice(-12),
    };
  }

  window.__ev = {
    diag: diag,
    now: now,
    info: info,
    snap: snap,
    target: target,
    syntheticTap: syntheticTap,
    calibrate: calibrate,
    endCalibration: endCalibration,
    log: function (from) {
      var pick = function (list) {
        return list.filter(function (e) { return e.t >= from; });
      };
      return {
        t: now(),
        samples: pick(log.samples),
        writes: pick(log.writes),
        events: pick(log.events),
        input: pick(log.input),
        calls: pick(log.calls),
        mse: log.mse,
        navMsAtInstall: T0,
      };
    },
  };
}());
