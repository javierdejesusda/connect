import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';

const STOP_TIMEOUT_MS = 30000;

/**
 * Starts `xcrun simctl io <udid> recordVideo` for an iOS Simulator.
 *
 * @param {string} udid Simulator UDID.
 * @param {string} file Output .mp4 path.
 * @param {string} logFile Where simctl writes its own output.
 * @return {Object} Handle to pass to stopSimulatorRecording.
 */
export function startSimulatorRecording(udid, file, logFile) {
  const fd = openSync(logFile, 'a');
  const child = spawn('xcrun', ['simctl', 'io', udid, 'recordVideo', '--codec=h264', '--force', file], {
    stdio: ['ignore', fd, fd],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  return { child, exited, fd };
}

/**
 * Stops the recording with SIGINT so simctl finalizes the movie file.
 *
 * @param {?Object} handle Value returned by startSimulatorRecording.
 * @return {Promise<void>} Resolves once simctl exited or the timeout passed.
 */
export async function stopSimulatorRecording(handle) {
  if (!handle) return;
  handle.child.kill('SIGINT');
  await Promise.race([
    handle.exited,
    new Promise((resolve) => setTimeout(resolve, STOP_TIMEOUT_MS)),
  ]);
  closeSync(handle.fd);
}
