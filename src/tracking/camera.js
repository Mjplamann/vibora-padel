// Camera discovery and capture (SPEC §4.8). Browser module.
//
// listCameras() -> [{ deviceId, label, kind, presetKey, unsuitable? }]
//   kind: 'builtin' | 'continuity' | 'usb' | 'unknown'
//   presetKey: a TRACKING.cameraPresets key ('macbook-builtin' | 'iphone-continuity' | 'usb-webcam' ...)
// openCamera({ deviceId, width, height, fps }) -> { video, stream, track, settings, deviceId, label, kind, presetKey, stop(), onEnded(fn) }
//   Tries the requested frame rate first, then 30 fps, then whatever the device gives.
//   Failures throw a CameraError { code, title, message, help[] } written for a person in
//   front of a TV, including the macOS System Settings path when the OS blocks the camera.

import { TRACKING } from '../config.js';

/** Maps a device label to { kind, presetKey }. Pure. */
export function classifyCamera(label = '') {
  const l = label.toLowerCase();
  if (!l) return { kind: 'unknown', presetKey: TRACKING.defaultCamera };
  if (/desk view/.test(l)) return { kind: 'continuity', presetKey: 'iphone-continuity', unsuitable: true };
  if (/iphone|continuity|ipad/.test(l)) {
    return { kind: 'continuity', presetKey: /ultra ?wide/.test(l) ? 'iphone-ultrawide' : 'iphone-continuity' };
  }
  if (/facetime|macbook|built-?in|imac|studio display/.test(l)) return { kind: 'builtin', presetKey: 'macbook-builtin' };
  if (/ultra ?wide|wide[- ]?angle|fisheye|\b1[0-2]\d ?°/.test(l)) return { kind: 'usb', presetKey: 'usb-wide' };
  return { kind: 'usb', presetKey: 'usb-webcam' };
}

export class CameraError extends Error {
  constructor(code, title, message, help = [], cause = null) {
    super(message);
    this.name = 'CameraError';
    this.code = code;
    this.title = title;
    this.help = help;
    this.cause = cause;
  }
}

const isMac = () => /Mac/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
const isSafari = () => {
  const ua = globalThis.navigator?.userAgent || '';
  return /Safari/i.test(ua) && !/Chrome|Chromium|Edg/i.test(ua);
};
const browserName = () => {
  const ua = globalThis.navigator?.userAgent || '';
  if (/Edg\//.test(ua)) return 'Microsoft Edge';
  if (/Chrome\//.test(ua)) return 'Google Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (isSafari()) return 'Safari';
  return 'your browser';
};

/** Converts a getUserMedia / environment failure into a human-readable CameraError. Pure-ish. */
export function describeCameraError(err, { mac = isMac(), browser = browserName() } = {}) {
  if (err instanceof CameraError) return err;
  const name = err?.name || '';
  const msg = String(err?.message || '');
  if (name === 'InsecureContext') {
    return new CameraError('insecure-context', 'Camera needs a secure page',
      'Browsers only allow the camera on https:// pages or on http://localhost.',
      ['Open the game from https:// (e.g. GitHub Pages) or run `npm start` and use http://localhost:5173.'], err);
  }
  if (name === 'Unsupported') {
    return new CameraError('unsupported', 'No camera support',
      'This browser does not expose cameras to web pages.',
      ['Use a current version of Google Chrome or Safari.', 'Or switch to mouse/trackpad controls.'], err);
  }
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    // Chrome reports an OS-level block as "Permission denied by system".
    if (mac && /by system|system permission/i.test(msg)) {
      return new CameraError('os-denied', 'macOS is blocking the camera',
        `macOS has not given ${browser} permission to use the camera.`,
        [
          'Open  > System Settings > Privacy & Security > Camera.',
          `Turn on the switch next to ${browser}.`,
          `Quit ${browser} completely (⌘Q) and open it again, then reload this page.`,
        ], err);
    }
    const siteHelp = browser === 'Safari'
      ? ['In Safari choose Safari > Settings for This Website… (or Settings > Websites > Camera).', 'Set Camera to “Allow”, then reload.']
      : ['Click the camera or tune icon at the left of the address bar.', 'Set Camera to “Allow”, then reload the page.'];
    if (mac) siteHelp.push(`If it is still blocked: System Settings > Privacy & Security > Camera, enable ${browser}, then quit and reopen it.`);
    return new CameraError('permission-denied', 'Camera permission was denied',
      'The game needs your camera to see your body. Nothing is recorded or uploaded; tracking runs on this Mac.',
      siteHelp, err);
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || (name === 'OverconstrainedError' && /deviceId/i.test(err?.constraint || ''))) {
    return new CameraError('not-found', 'No camera found',
      'No camera is connected, or the selected one was unplugged.',
      [
        'MacBook lid closed with a TV? Open the lid a little, or use an iPhone (Continuity Camera) or a USB webcam.',
        'iPhone: same Apple ID, Wi-Fi and Bluetooth on, phone locked, in landscape and still.',
        'Then press “Refresh cameras”.',
      ], err);
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return new CameraError('in-use', 'Camera is busy',
      'Another app is using the camera, or the system could not start it.',
      [
        'Quit FaceTime, Zoom, Teams, Photo Booth, OBS or any other tab that uses the camera.',
        'Unplug and replug a USB webcam, or wake the iPhone for Continuity Camera.',
        'Then try again.',
      ], err);
  }
  if (name === 'OverconstrainedError') {
    return new CameraError('overconstrained', 'Camera mode not supported',
      'The camera cannot provide the requested video mode.', ['Pick another camera or lower the quality preset.'], err);
  }
  return new CameraError('unknown', 'Camera error', msg || 'The camera could not be started.', ['Reload the page and try again.'], err);
}

function mediaDevices() {
  const md = globalThis.navigator?.mediaDevices;
  if (!md || !md.getUserMedia) {
    const insecure = globalThis.isSecureContext === false;
    throw describeCameraError({ name: insecure ? 'InsecureContext' : 'Unsupported' });
  }
  return md;
}

/**
 * Lists video inputs. Before permission is granted, labels are empty: entries then have
 * kind 'unknown' and a generic label. Pass { requestPermission: true } to briefly open the
 * default camera so labels become available (call from a user gesture).
 */
export async function listCameras({ requestPermission = false } = {}) {
  const md = mediaDevices();
  let devices = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  if (requestPermission && devices.length && devices.every((d) => !d.label)) {
    try {
      const s = await md.getUserMedia({ video: true, audio: false });
      s.getTracks().forEach((t) => t.stop());
      devices = (await md.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    } catch (err) {
      throw describeCameraError(err);
    }
  }
  return devices.map((d, i) => {
    const c = classifyCamera(d.label);
    return {
      deviceId: d.deviceId,
      groupId: d.groupId,
      label: d.label || `Camera ${i + 1}`,
      labelsHidden: !d.label,
      ...c,
    };
  });
}

/** Picks the most suitable camera: Continuity iPhone > USB > built-in (lid may be closed on a TV setup). */
export function preferredCamera(cams) {
  const usable = cams.filter((c) => !c.unsuitable);
  const rank = { continuity: 3, usb: 2, builtin: 1, unknown: 0 };
  return usable.slice().sort((a, b) => rank[b.kind] - rank[a.kind])[0] || cams[0] || null;
}

async function tryGetUserMedia(md, video) {
  return md.getUserMedia({ video, audio: false });
}

/**
 * Opens a camera into a muted, inline <video>. Never mirrored here (the UI may mirror its
 * preview with CSS); pose landmarks must stay in raw image coordinates.
 */
export async function openCamera({ deviceId = null, width = 1280, height = 720, fps = 60, video: videoEl = null } = {}) {
  const md = mediaDevices();
  const dev = deviceId ? { deviceId: { exact: deviceId } } : {};
  const size = { width: { ideal: width }, height: { ideal: height } };
  const attempts = [
    { ...dev, ...size, frameRate: { ideal: fps, min: Math.min(fps, 50) } },
    { ...dev, ...size, frameRate: { ideal: 30 } },
    { ...dev, ...size },
    { ...dev },
  ];
  if (fps <= 30) attempts.shift();
  let stream = null;
  let lastErr = null;
  for (const c of attempts) {
    try {
      stream = await tryGetUserMedia(md, c);
      break;
    } catch (err) {
      lastErr = err;
      // Only constraint problems are worth retrying with looser settings.
      if (err?.name !== 'OverconstrainedError' && err?.name !== 'ConstraintNotSatisfiedError') break;
    }
  }
  if (!stream) throw describeCameraError(lastErr);

  const track = stream.getVideoTracks()[0];
  try {
    // Hint for webcams that support it: keep detail for the pose model, not motion smoothness.
    if ('contentHint' in track) track.contentHint = 'motion';
  } catch {
    /* ignore */
  }
  const video = videoEl || globalThis.document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.autoplay = true;
  video.srcObject = stream;
  try {
    await new Promise((resolve, reject) => {
      if (video.readyState >= 1 && video.videoWidth) return resolve();
      const to = setTimeout(() => reject(Object.assign(new Error('Camera did not deliver frames'), { name: 'NotReadableError' })), 8000);
      video.addEventListener('loadedmetadata', () => {
        clearTimeout(to);
        resolve();
      }, { once: true });
    });
    await video.play();
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    throw describeCameraError(err?.name === 'NotAllowedError' ? Object.assign(new Error('autoplay'), { name: 'AbortError' }) : err);
  }

  const s = track.getSettings ? track.getSettings() : {};
  const label = track.label || '';
  const cls = classifyCamera(label);
  const endedHandlers = new Set();
  track.addEventListener('ended', () => endedHandlers.forEach((fn) => fn()));
  let stopped = false;
  return {
    video,
    stream,
    track,
    deviceId: s.deviceId || deviceId,
    label,
    ...cls,
    settings: {
      width: s.width || video.videoWidth,
      height: s.height || video.videoHeight,
      frameRate: s.frameRate || null,
    },
    /** Called when the camera disappears (unplugged, iPhone picked up, permission revoked). */
    onEnded(fn) {
      endedHandlers.add(fn);
      return () => endedHandlers.delete(fn);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      stream.getTracks().forEach((t) => t.stop());
      video.pause();
      video.srcObject = null;
    },
  };
}
