#target illustrator
// ESB64 example 03: the UTF-8 codec (full build: dist/ESB64.jsx).
//
// encodeUtf8 / decodeUtf8 round-trip arbitrary Unicode through base64 with
// WHATWG TextEncoder/Decoder semantics: lone surrogates become U+FFFD on
// encode, malformed byte sequences become U+FFFD on decode, and BOMs are
// data (byte-exact). utf8Encode / utf8Decode expose the raw byte-string
// lanes without base64.
//
// ESB64.jsx is the facade-only build: it leaves the global atob/btoa alone.
//
// How to run: File > Scripts > Other Script..., or
//   python ILLUSTRATOR_COM_TOOL.py eval --file examples/03-utf8-codec.jsx
// Report: %TEMP%\esb64example-03-report.json + last-statement value.

// --- bootstrap: facade build (no global install) ---------------------------
var __esb64Dist = $.getenv('ESB64_DIST');
if (!__esb64Dist) {
  __esb64Dist = File(decodeURI($.fileName)).parent.parent.fsName.replace(/\\/g, '/') + '/dist';
}
var __vendor = new File(__esb64Dist + '/ESB64.jsx');
if (!__vendor.exists) {
  $.writeln('ESB64 build not found at ' + __vendor.fsName + ' -- run "npm run build" in the esb64 repo first.');
  throw new Error('ESB64 build not found: ' + __vendor.fsName);
}
$.evalFile(__vendor); // ESON-style facade: use ESB64.* explicitly

var out = { ok: true, checks: [], build: 'ESB64.jsx (full build)' };
function check(name, ok, detail) {
  out.checks.push({ name: name, ok: !!ok, detail: detail });
  if (!ok) out.ok = false;
}

// --- encodeUtf8: known vectors ----------------------------------------------
var enc = [
  ['\u00e9', 'w6k='],
  ['\ud83d\ude00', '8J+YgA=='],
  ['\u65e5\u672c\u8a9e', '5pel5pys6Kqe'],
  ['\u0000\u007f\u00ff', 'AH/Dvw=='],
  ['dieline \u03c0 \u00e9', 'ZGllbGluZSDPgCDDqQ==']
];
var encOk = true;
var i;
for (i = 0; i < enc.length; i++) {
  if (ESB64.encodeUtf8(enc[i][0]) !== enc[i][1]) encOk = false;
}
check('encodeUtf8-vectors', encOk, '5/5 known encodings');

// --- WHATWG malformed-input handling ---------------------------------------
check('lone-surrogate-fffd', ESB64.encodeUtf8('\ud800') === '77+9',
  'lone surrogate normalizes to U+FFFD (EF BF BD), does NOT throw (unlike btoa)');

// decodeUtf8 of invalid byte sequences -> U+FFFD per the WHATWG grouping:
var dec = [
  ['8J+Y', '\ufffd'],      // F0 9F 98 truncated 4-byte
  ['w6', '\ufffd'],        // C3 truncated 2-byte
  ['wYE=', '\ufffd\ufffd'], // C1 81 overlong start
  ['4ICA', '\ufffd\ufffd'], // E0 80 80 overlong
  ['7aCA', '\ufffd\ufffd'], // ED A0 80 surrogate-encoded
  ['9JCA', '\ufffd\ufffd'], // F4 90 80 out of range
  ['gA==', '\ufffd'],      // 80 stray continuation
  ['w5Av', '\u00d0/']      // valid Ð then '/' (2F is not a continuation)
];
var decOk = true;
for (i = 0; i < dec.length; i++) {
  if (ESB64.decodeUtf8(dec[i][0]) !== dec[i][1]) decOk = false;
}
check('decodeUtf8-invalid-vectors', decOk, '8/8 malformed-sequence expectations');

// --- round trips ------------------------------------------------------------
var mixed = 'dieline \u00e9 \u65e5\u672c\u8a9e \ud83d\ude00 \u0928\u092e\u0938\u094d\u0924\u0947 100%';
check('roundtrip-mixed', ESB64.decodeUtf8(ESB64.encodeUtf8(mixed)) === mixed);
check('roundtrip-bom', ESB64.decodeUtf8(ESB64.encodeUtf8('\ufeffx')) === '\ufeffx', 'BOM is data, byte-exact');
check('roundtrip-empty', ESB64.encodeUtf8('') === '' && ESB64.decodeUtf8('') === '');

// --- raw byte-string lanes --------------------------------------------------
check('utf8Encode-latin1', ESB64.utf8Encode('\u00e9') === '\u00c3\u00a9', 'é is C3 A9 in UTF-8 bytes');
check('utf8Decode-roundtrip', ESB64.utf8Decode(ESB64.utf8Encode(mixed)) === mixed);
check('utf8Encode-lone-surrogate', ESB64.utf8Encode('\ud800') === '\u00ef\u00bf\u00bd');

// --- capabilities -----------------------------------------------------------
var caps = ESB64.capabilities();
out.caps = {
  atobClassification: caps.atobClassification,
  btoaClassification: caps.btoaClassification,
  engine: caps.engine,
  memo: caps.memo
};
check('caps-shape', caps.utf8 === true && typeof caps.memo === 'object' && caps.memo.atob.enabled === true && caps.memo.btoa.enabled === true,
  'memo is per-lane: memo.atob / memo.btoa');

// --- report ---------------------------------------------------------------
var __report = JSON.stringify(out, null, 2);
$.writeln('ESB64 example 03: ' + (out.ok ? 'PASS' : 'FAIL'));
$.writeln(__report);
var __rf = new File($.getenv('TEMP') + '/esb64example-03-report.json');
__rf.encoding = 'UTF-8';
__rf.open('w');
__rf.write(__report);
__rf.close();
__report;
