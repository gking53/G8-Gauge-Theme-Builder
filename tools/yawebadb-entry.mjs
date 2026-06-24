// Bundle entry for the ya-webadb stack. Bundling with npm-deduped deps gives a
// SINGLE @yume-chan/stream-extra instance, avoiding the realm mismatch that broke
// transferOut when each package was loaded separately from a CDN.
//   npm run bundle-adb   ->  docs/vendor/yawebadb.js
export { AdbDaemonWebUsbDeviceManager } from '@yume-chan/adb-daemon-webusb';
export { Adb, AdbDaemonTransport } from '@yume-chan/adb';
export { default as AdbWebCredentialStore } from '@yume-chan/adb-credential-web';
