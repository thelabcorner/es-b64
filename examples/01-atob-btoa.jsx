#target illustrator
// ESB64 example 01: drop-in atob / btoa (runtime build).
//
// Demonstrates: gap-fill global install (atob/btoa appear only when absent),
// RFC 4648 vectors, latin1 gate (btoa throws InvalidCharacterError above
// U+00FF), round trips over all 256 bytes, and the two-tier memo (repeat
// payloads skip the codec; NUL and __proto__ payloads stay correct).
//
// How to run: File > Scripts > Other Script..., or
//   python ILLUSTRATOR_COM_TOOL.py eval --file examples/01-atob-btoa.jsx
// Report: %TEMP%\esb64example-01-report.json + last-statement value.

// --- bootstrap: resolve the ESB64 build relative to this script ------------
// `$.fileName` is URI-style and may contain %20 -- decode before use.
// Override the location with the ESB64_DIST env var when running a copy
// of this example from outside the repo.
var __esb64Dist = $.getenv('ESB64_DIST');
if (!__esb64Dist) {
  __esb64Dist = File(decodeURI($.fileName)).parent.parent.fsName.replace(/\\/g, '/') + '/dist';
}
var __vendor = new File(__esb64Dist + '/vendor-esb64-runtime.js');
if (!__vendor.exists) {
  $.writeln('ESB64 build not found at ' + __vendor.fsName + ' -- run "npm run build" in the esb64 repo first.');
  throw new Error('ESB64 build not found: ' + __vendor.fsName);
}
$.evalFile(__vendor); // gap-fill: installs global atob/btoa only when absent

// Snapshot pre-load state: in a long-lived COM session a previous vendor
// install may already own the globals (gap-fill leaves them untouched), so
// identity between the global and this build's facade is session-dependent;
// functional behavior is the contract that always holds.
var __hadAtob = typeof atob !== 'undefined';
var __hadBtoa = typeof btoa !== 'undefined';

var out = { ok: true, checks: [], build: 'vendor-esb64-runtime.js' };
function check(name, ok, detail) {
  out.checks.push({ name: name, ok: !!ok, detail: detail });
  if (!ok) out.ok = false;
}

// --- install semantics -----------------------------------------------------
check('facade-available', typeof ESB64 === 'object' && typeof ESB64.atob === 'function' && typeof ESB64.btoa === 'function');
check('globals-present', typeof atob === 'function' && typeof btoa === 'function', '');
check('globals-functional', atob('SGVsbG8gV29ybGQ=') === 'Hello World' && btoa('Hello World') === 'SGVsbG8gV29ybGQ=',
  'behavior spot-check');
out.session = {
  hadAtobBefore: __hadAtob,
  hadBtoaBefore: __hadBtoa,
  installedIdentity: atob === ESB64.atob && btoa === ESB64.btoa
};

// --- RFC 4648 section 10 canonical vectors ---------------------------------
var rfc = [
  ['', ''],
  ['f', 'Zg=='],
  ['fo', 'Zm8='],
  ['foo', 'Zm9v'],
  ['foob', 'Zm9vYg=='],
  ['fooba', 'Zm9vYmE='],
  ['foobar', 'Zm9vYmFy']
];
var rfcOk = true;
var i;
for (i = 0; i < rfc.length; i++) {
  if (btoa(rfc[i][0]) !== rfc[i][1]) rfcOk = false;
}
check('rfc4648-vectors', rfcOk, '7/7 canonical vectors');

// --- latin1 gate: btoa throws above U+00FF ---------------------------------
function throwsICE(fn) {
  try { fn(); return false; } catch (e) { return e.name === 'InvalidCharacterError'; }
}
check('btoa-rejects-unicode', throwsICE(function () { btoa('\u65e5\u672c\u8a9e'); }), 'CJK chars are not latin1');
check('btoa-rejects-u0100', throwsICE(function () { btoa('\u0100'); }));
check('btoa-rejects-lone-surrogate', throwsICE(function () { btoa('\ud800'); }));
check('btoa-accepts-latin1-max', btoa('\u00ff') === '/w==', 'U+00FF is the top latin1 byte');

// --- round trips over the full byte range ----------------------------------
var all = [];
for (i = 0; i < 256; i++) all[all.length] = String.fromCharCode(i);
var bytes = all.join('');
check('bytes-0-255-roundtrip', atob(btoa(bytes)) === bytes);
check('nul-roundtrip', atob(btoa('\u0000\u0000')) === '\u0000\u0000', 'NUL survives (charCodeAt-based scan)');

// --- error semantics --------------------------------------------------------
check('atob-invalid-name', throwsICE(function () { atob('SGVsbG8!'); }), 'InvalidCharacterError on bad alphabet char');

// --- memo: repeat payloads skip the codec -----------------------------------
var memoText = 'repeat me - 0123456789';
btoa(memoText);
var t0 = $.hiresTimer;
btoa(memoText);
check('memo-hit-fast', ($.hiresTimer - t0) < 10000, 'repeat btoa bypasses the codec');

// memo correctness must not be affected by payload shape:
check('memo-proto-safe', atob(btoa('__proto__')) === '__proto__', 'property-key-looking payload stays correct');
check('memo-nul-safe', atob(btoa('a\u0000b')) === 'a\u0000b', 'NUL-bearing payload stays correct');

// --- report ---------------------------------------------------------------
var __report = JSON.stringify(out, null, 2);
$.writeln('ESB64 example 01: ' + (out.ok ? 'PASS' : 'FAIL'));
$.writeln(__report);
var __rf = new File($.getenv('TEMP') + '/esb64example-01-report.json');
__rf.encoding = 'UTF-8';
__rf.open('w');
__rf.write(__report);
__rf.close();
__report;
