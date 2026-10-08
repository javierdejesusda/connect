/**
 * Picks (or creates) an iOS Simulator for the requested runtime major version
 * and prints GitHub Actions `key=value` lines: udid, name, runtime, os.
 *
 * Usage: node pick-sim.mjs "<preferred device names, separated by |>" <iosMajor>
 */
import { execFileSync } from 'node:child_process';

const [preferredArg, majorArg] = process.argv.slice(2);
const preferred = (preferredArg || '').split('|').map((name) => name.trim()).filter(Boolean);
const major = Number(majorArg);

function simctl(...args) {
  return JSON.parse(execFileSync('xcrun', ['simctl', ...args, '-j'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function runtimeVersion(identifier) {
  const match = /iOS-(\d+)-(\d+)(?:-(\d+))?$/.exec(identifier);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

const runtimes = simctl('list', 'runtimes', 'available').runtimes
  .filter((runtime) => runtime.platform === 'iOS' || /SimRuntime\.iOS/.test(runtime.identifier))
  .map((runtime) => ({ ...runtime, parsed: runtimeVersion(runtime.identifier) }))
  .filter((runtime) => runtime.parsed && runtime.parsed[0] === major)
  .sort((a, b) => compareVersions(b.parsed, a.parsed));

if (runtimes.length === 0) {
  const all = simctl('list', 'runtimes', 'available').runtimes.map((r) => r.identifier);
  console.error(`No iOS ${major}.x runtime available. Runtimes: ${all.join(', ')}`);
  process.exit(1);
}

const runtime = runtimes[0];
const devices = simctl('list', 'devices', 'available').devices[runtime.identifier] || [];
let chosen = null;
for (const name of preferred) {
  chosen = devices.find((device) => device.name === name);
  if (chosen) break;
}

if (!chosen) {
  const types = simctl('list', 'devicetypes').devicetypes;
  for (const name of preferred) {
    const type = types.find((t) => t.name === name);
    if (!type) continue;
    const udid = execFileSync('xcrun', ['simctl', 'create', `evidence ${name}`, type.identifier, runtime.identifier], { encoding: 'utf8' }).trim();
    chosen = { udid, name };
    break;
  }
}

if (!chosen) {
  console.error(`None of [${preferred.join(', ')}] exists for ${runtime.identifier}. Devices: ${devices.map((d) => d.name).join(', ')}`);
  process.exit(1);
}

console.log(`udid=${chosen.udid}`);
console.log(`name=${chosen.name}`);
console.log(`runtime=${runtime.identifier}`);
console.log(`os=${runtime.version || runtime.parsed.join('.')}`);
