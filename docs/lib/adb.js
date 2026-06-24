// adb.js — install the built overlays over WebUSB, fully autodetected.
//
// No user input needed:
//   * target APK path per overlay  -> `pm path <package>` (the exact file the
//     OverlayManager loads). Overlays that don't resolve to a system overlay
//     path (e.g. the accent overlay, which isn't an active /product RRO here)
//     are skipped automatically.
//   * block device backing /product/overlay -> parsed from /proc/mounts.
// Then: push to /data/local/tmp, remount / rw, cp into place, chmod, remount ro,
// reboot. Mirrors the proven build_overlays.py --deploy flow.
//
// Root is Magisk su (auto-approved for adb on the target). WebUSB needs desktop
// Chrome/Edge over HTTPS. @yume-chan/adb versions are pinned in index.html.
// NOTE: the sync-push + subprocess calls are the part to validate in a real
// browser+device run — everything upstream is already proven.

// Single bundled module (npm-deduped) — avoids the multi-CDN realm mismatch that
// broke transferOut. Rebuild with `npm run bundle-adb` after upgrading the stack.
import {
  AdbDaemonWebUsbDeviceManager, Adb, AdbDaemonTransport, AdbWebCredentialStore,
} from '../vendor/yawebadb.js';

const TMP = '/data/local/tmp';
const SYSTEM_OVERLAY_RE = /^\/(product|system|system_ext|vendor|odm)\//;

export function webusbSupported() {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

export async function connect(onProgress = () => {}) {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!manager) throw new Error('WebUSB not available — use desktop Chrome or Edge over HTTPS.');
  const device = await manager.requestDevice();
  if (!device) throw new Error('No device selected. Plug in the device and pick it in the dialog.');
  let connection;
  try {
    connection = await device.connect();
  } catch (e) {
    // claimInterface fails when the desktop adb server owns the device
    if (/claim|in use|in used|access|busy/i.test(String(e?.message || e))) {
      throw new Error(
        'Another program is using the device. On THIS computer close Android Studio / ' +
        'scrcpy / phone tools and run "adb kill-server" (or end adb.exe in Task Manager), ' +
        'then unplug/replug and try again.'
      );
    }
    throw e;
  }
  const credentialStore = new AdbWebCredentialStore('custom-theme-web');
  // The authorize handshake blocks until the device accepts "Allow USB debugging".
  // If it's slow, the prompt is probably waiting on the device (often hidden behind
  // the lock screen) — nudge the user instead of letting it look frozen.
  const hint = setTimeout(() => onProgress(
    '⚠  Waiting on the device — wake/unlock it and tap "Allow USB debugging". '
    + 'Tick "Always allow from this computer" to skip this next time.'
  ), 1500);
  try {
    const transport = await AdbDaemonTransport.authenticate({ serial: device.serial, connection, credentialStore });
    return new Adb(transport);
  } finally {
    clearTimeout(hint);
  }
}

// run a shell command, return trimmed stdout
async function sh(adb, cmd) {
  const out = await adb.subprocess.noneProtocol.spawnWaitText(cmd);
  return (out ?? '').trim();
}
// run a command as root (Magisk su)
function su(adb, cmd) {
  return sh(adb, `su -c "${cmd.replace(/"/g, '\\"')}"`);
}

// Find the block device whose mountpoint is the longest prefix of `path`.
function deviceForPath(procMounts, path) {
  let best = null, bestLen = -1;
  for (const line of procMounts.split('\n')) {
    const [dev, mnt] = line.split(/\s+/);
    if (!dev || !mnt) continue;
    const prefix = mnt === '/' ? '/' : mnt + '/';
    if (path === mnt || path.startsWith(prefix)) {
      if (mnt.length > bestLen) { best = dev; bestLen = mnt.length; }
    }
  }
  return best;
}

function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }

async function pushFile(adb, path, bytes) {
  // sync.write accepts ReadableStream<MaybeConsumable<Uint8Array>> — a plain
  // Uint8Array chunk is fine, so no Consumable wrapper (and no realm risk).
  const sync = await adb.sync();
  try {
    await sync.write({
      filename: path,
      file: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      permission: 0o644,
    });
  } finally {
    await sync.dispose();
  }
}

/**
 * @param {Adb} adb
 * @param {Array<{name,package,bytes}>} apks   from build.js (needs .package)
 * @param {(msg:string)=>void} onProgress
 */
export async function installAll(adb, apks, onProgress = () => {}) {
  // 1) resolve each overlay's real on-device APK path
  onProgress('Locating overlays on device…');
  const plan = [];
  for (const a of apks) {
    if (!a.package) { onProgress(`• skip ${a.name}: no package name`); continue; }
    const out = await su(adb, `pm path ${a.package}`);
    const m = out.match(/package:(\/.+?\.apk)/);
    const target = m && m[1];
    if (!target || !SYSTEM_OVERLAY_RE.test(target)) {
      onProgress(`• skip ${a.name}: not an active system overlay (${target || 'not installed'})`);
      continue;
    }
    plan.push({ ...a, target, tmp: `${TMP}/cti_${basename(target)}` });
    onProgress(`• ${a.name} → ${target}`);
  }
  if (!plan.length) throw new Error('No deployable overlays found on the device.');

  // 2) detect the block device backing those overlays (longest-prefix mount)
  const mounts = await su(adb, 'cat /proc/mounts');
  const dev = deviceForPath(mounts, plan[0].target);
  onProgress(`Block device: ${dev || '(remount only)'}`);

  // 3) push APKs to a temp dir (no root needed)
  for (const p of plan) {
    onProgress(`Pushing ${p.name}…`);
    await pushFile(adb, p.tmp, p.bytes);
  }

  // 4) remount rw, copy into place, chmod, remount ro — one rooted command
  const setrw = dev ? `blockdev --setrw ${dev} 2>/dev/null; ` : '';
  const setro = dev ? ` blockdev --setro ${dev} 2>/dev/null;` : '';
  const cps = plan.map((p) => `cp ${p.tmp} ${p.target}`).join('; ');
  const chmods = `chmod 644 ${plan.map((p) => p.target).join(' ')}`;
  onProgress('Installing to system overlay (remount rw)…');
  await su(adb, `${setrw}mount -o remount,rw /; ${cps}; ${chmods}; sync; mount -o remount,ro /;${setro}`);

  // 5) clean up temp files, then reboot
  await su(adb, `rm -f ${plan.map((p) => p.tmp).join(' ')}`);
  onProgress('Rebooting…');
  try { await adb.power.reboot(); } catch { await su(adb, 'reboot'); }
  onProgress('Done — device rebooting. Check colors when it comes back up.');
}
