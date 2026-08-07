#target illustrator
// ESB64 example 02: WHATWG forgiving-base64 atob (runtime build).
//
// atob is NOT strict base64: per the WHATWG infra spec it strips ASCII
// whitespace, tolerates missing padding, and rejects only length % 4 == 1
// and non-alphabet characters. This example runs the WPT base64.json
// behavior vectors (the same corpus browsers are tested against) through
// the live engine.
//
// Note: atob returns latin1 BYTES. A decoded "é" is byte 0xE9, not the
// UTF-8 pair -- see example 03 for decodeUtf8, which turns base64 into
// proper Unicode.
//
// How to run: File > Scripts > Other Script..., or
//   python ILLUSTRATOR_COM_TOOL.py eval --file examples/02-forgiving-atob.jsx
// Report: %TEMP%\esb64example-02-report.json + last-statement value.

// --- bootstrap (see 01-atob-btoa.jsx for the same loader) ------------------
var __esb64Dist = $.getenv('ESB64_DIST');
if (!__esb64Dist) {
  __esb64Dist = File(decodeURI($.fileName)).parent.parent.fsName.replace(/\\/g, '/') + '/dist';
}
var __vendor = new File(__esb64Dist + '/vendor-esb64-runtime.js');
if (!__vendor.exists) {
  $.writeln('ESB64 build not found at ' + __vendor.fsName + ' -- run "npm run build" in the esb64 repo first.');
  throw new Error('ESB64 build not found: ' + __vendor.fsName);
}
$.evalFile(__vendor);

var out = { ok: true, checks: [], build: 'vendor-esb64-runtime.js' };
function check(name, ok, detail) {
  out.checks.push({ name: name, ok: !!ok, detail: detail });
  if (!ok) out.ok = false;
}

// [input, expected bytes | 'ERR' for must-throw]
var vectors = [
  ['', ''],
  ['Zg==', 'f'],
  ['Zm8=', 'fo'],
  ['Zm9v', 'foo'],
  ['Zg', 'f'],                       // missing padding tolerated
  ['Z m 8 =', 'fo'],                 // whitespace stripped
  ['\tZ\r\nm8\n=', 'fo'],            // all ASCII whitespace
  ['AA==', '\u0000'],
  ['/w==', '\u00ff'],
  ['AIAB', '\u0000\u0080\u0001'],
  ['8J+YgA==', '\u00f0\u009f\u0098\u0080'], // UTF-8 bytes of an emoji
  ['77+9', '\u00ef\u00bf\u00bd'],    // UTF-8 bytes of U+FFFD
  ['w6k=', '\u00c3\u00a9'],          // UTF-8 bytes of é
  ['5pel5pys6Kqe', '\u00e6\u0097\u00a5\u00e6\u009c\u00ac\u00e8\u00aa\u009e'], // 日本語
  ['YWJj', 'abc'],
  ['AAA=', '\u0000\u0000'],
  ['AAA', '\u0000\u0000'],
  ['YQ', 'a'],
  ['/A', '\u00fc'],
  ['//A', '\u00ff\u00f0'],
  ['///A', '\u00ff\u00ff\u00c0'],
  ['AAA/', '\u0000\u0000\u003f'],
  ['abc=', 'i\u00b7'],
  ['ab==', 'i'],
  ['ab\t\n\f\r =\t\n\f\r =\t\n\f\r ', 'i'], // whitespace around padding
  ['AA=', 'ERR'],                    // length % 4 == 1 after padding rules
  ['a=', 'ERR'],
  ['ab=', 'ERR'],
  ['A', 'ERR'],
  ['=', 'ERR'],
  ['==', 'ERR'],
  ['====', 'ERR'],
  ['A===', 'ERR'],
  ['Zg=A', 'ERR'],
  ['AB==CD', 'ERR'],
  ['Zm9v!', 'ERR'],
  ['Zm9v_', 'ERR'],
  ['ab===', 'ERR'],
  ['abcde', 'ERR'],
  ['\u00e9', 'ERR'],                 // non-ASCII is not alphabet
  ['\u0000', 'ERR']                  // NUL is not alphabet
];
var i;
for (i = 0; i < vectors.length; i++) {
  var input = vectors[i][0];
  var expect = vectors[i][1];
  var name = 'wpt-' + i + ' ' + JSON.stringify(input);
  if (expect === 'ERR') {
    var threw = false;
    try { ESB64.atob(input); } catch (e) { threw = e.name === 'InvalidCharacterError'; }
    check(name, threw, 'must throw InvalidCharacterError');
  } else {
    check(name, ESB64.atob(input) === expect, 'expected ' + JSON.stringify(expect));
  }
}

// --- report ---------------------------------------------------------------
var __report = JSON.stringify(out, null, 2);
$.writeln('ESB64 example 02: ' + (out.ok ? 'PASS' : 'FAIL'));
$.writeln(__report);
var __rf = new File($.getenv('TEMP') + '/esb64example-02-report.json');
__rf.encoding = 'UTF-8';
__rf.open('w');
__rf.write(__report);
__rf.close();
__report;
