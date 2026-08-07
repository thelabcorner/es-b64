#target illustrator
// ESB64 example 05: edge cases -- the payloads that break naive codecs
// (full build: dist/ESB64.jsx).
//
// NUL-bearing strings, __proto__-shaped payloads, the full 0..255 byte
// range, malformed UTF-8, lone surrogates, and the btoa/encodeUtf8
// contract difference (btoa throws, encodeUtf8 normalizes).
//
// How to run: File > Scripts > Other Script..., or
//   python ILLUSTRATOR_COM_TOOL.py eval --file examples/05-edge-cases.jsx
// Report: %TEMP%\esb64example-05-report.json + last-statement value.

// --- bootstrap: facade build ----------------------------------------------
var __esb64Dist = $.getenv('ESB64_DIST');
if (!__esb64Dist) {
  __esb64Dist = File(decodeURI($.fileName)).parent.parent.fsName.replace(/\\/g, '/') + '/dist';
}
var __vendor = new File(__esb64Dist + '/ESB64.jsx');
if (!__vendor.exists) {
  $.writeln('ESB64 build not found at ' + __vendor.fsName + ' -- run "npm run build" in the esb64 repo first.');
  throw new Error('ESB64 build not found: ' + __vendor.fsName);
}
$.evalFile(__vendor);

var out = { ok: true, checks: [], build: 'ESB64.jsx (full build)' };
function check(name, ok, detail) {
  out.checks.push({ name: name, ok: !!ok, detail: detail });
  if (!ok) out.ok = false;
}

// --- the full byte range in one payload ------------------------------------
var all = [];
var i;
for (i = 0; i < 256; i++) all[all.length] = String.fromCharCode(i);
var bytes = all.join('');
check('bytes-roundtrip', ESB64.atob(ESB64.btoa(bytes)) === bytes, '256 bytes, including NUL and 0xFF');

// --- NUL is data, not a terminator -----------------------------------------
check('nul-mid-string', ESB64.atob(ESB64.btoa('a\u0000b')) === 'a\u0000b');
check('nul-only', ESB64.btoa('\u0000') === 'AA==' && ESB64.atob('AA==') === '\u0000');

// --- property-key-shaped payloads (memo object-key pathology) ---------------
check('proto-shaped', ESB64.atob(ESB64.btoa('__proto__')) === '__proto__');
check('constructor-shaped', ESB64.atob(ESB64.btoa('constructor')) === 'constructor');

// --- latin1 bytes are NOT UTF-8 --------------------------------------------
// btoa('\u00e9') encodes the single byte 0xE9; decodeUtf8 must turn the
// stray continuation byte into U+FFFD (WHATWG), NOT into é:
check('latin1-is-not-utf8', ESB64.decodeUtf8(ESB64.btoa('\u00e9')) === '\ufffd',
  '0xE9 alone is malformed UTF-8 -> U+FFFD');

// --- contract difference: btoa throws, encodeUtf8 normalizes ----------------
var btoaThrew = false;
try { ESB64.btoa('\ud800'); } catch (e) { btoaThrew = e.name === 'InvalidCharacterError'; }
check('btoa-throws-lone-surrogate', btoaThrew);
check('encodeUtf8-normalizes-lone-surrogate', ESB64.encodeUtf8('\ud800') === '77+9');

// --- malformed UTF-8 decode: every error class -> U+FFFD --------------------
var malformed = ['8J+Y', 'w6', 'wYE=', '4ICA', '7aCA', '9JCA', 'gA=='];
var malformedOk = true;
for (i = 0; i < malformed.length; i++) {
  var d = ESB64.decodeUtf8(malformed[i]);
  if (d === '' || d.indexOf('\ufffd') < 0) malformedOk = false;
}
check('malformed-all-fffd', malformedOk, 'truncated, overlong, surrogate-encoded, out-of-range, stray continuation');

// --- surrogate PAIRS round-trip intact --------------------------------------
check('emoji-roundtrip', ESB64.decodeUtf8(ESB64.encodeUtf8('\ud83d\ude00')) === '\ud83d\ude00');
check('emoji-b64-known', ESB64.encodeUtf8('\ud83d\ude00') === '8J+YgA==');

// --- memo tiers exist without corrupting correctness ------------------------
check('memo-shared-immutable', ESB64.btoa('same-input') === ESB64.btoa('same-input'),
  'string results are immutable, memo hits are safe to share');

// --- report ---------------------------------------------------------------
var __report = JSON.stringify(out, null, 2);
$.writeln('ESB64 example 05: ' + (out.ok ? 'PASS' : 'FAIL'));
$.writeln(__report);
var __rf = new File($.getenv('TEMP') + '/esb64example-05-report.json');
__rf.encoding = 'UTF-8';
__rf.open('w');
__rf.write(__report);
__rf.close();
__report;
