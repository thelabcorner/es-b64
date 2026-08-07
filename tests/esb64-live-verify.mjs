#!/usr/bin/env node
// ESB64 live verification: runs a battery inside the REAL Adobe engine
// through ILLUSTRATOR_COM_TOOL.py (see agent-skills) and compares the engine
// output against Node-side expectations computed from the same bundled core
// (which npm test has already verified against native atob/btoa + Buffer +
// TextDecoder). This is the engine-parity check: the same code must produce
// byte-identical results in the ES3 engine.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

var ROOT = dirname(fileURLToPath(import.meta.url));
var PROJECT = join(ROOT, '..');
var VENDOR = join(PROJECT, 'dist', 'vendor-esb64.js');
var TOOL = 'C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/agent-skills/illustrator-com-automation-skill/scripts/ILLUSTRATOR_COM_TOOL.py';

if (!existsSync(VENDOR)) {
  console.error('live-verify: build first (npm run build) - ' + VENDOR + ' missing');
  process.exit(1);
}
if (!existsSync(TOOL)) {
  console.error('live-verify: COM tool not found at ' + TOOL);
  process.exit(1);
}

var core = await import(pathToFileURL(join(PROJECT, 'dist', 'esb64-core.esm.mjs')).href);

// ---- build the vector set ---------------------------------------------------

// Fixed-width 4-digit hex per char code (surrogate-safe; the probe parses
// the same format in 4-digit groups).
function hex(s) {
  var out = '';
  for (var i = 0; i < s.length; i++) {
    var c = s.charCodeAt(i).toString(16);
    while (c.length < 4) c = '0' + c;
    out += c;
  }
  return out;
}

var vectors = [];
var all = '';
for (var i = 0; i < 256; i++) all += String.fromCharCode(i);
vectors.push({ label: 'bytes-0..255', kind: 'btoa', in: hex(all), expect: hex(core.btoa(all)) });
vectors.push({ label: 'rfc4648-foobar', kind: 'btoa', in: hex('foobar'), expect: hex(core.btoa('foobar')) });
vectors.push({ label: 'nul-nul', kind: 'btoa', in: hex('\u0000\u0000'), expect: hex(core.btoa('\u0000\u0000')) });
vectors.push({ label: 'mixed-latin1', kind: 'btoa', in: hex('Mozilla/5.0 (Windows NT 10.0) \u00e9\u00ff\u0000\t'), expect: hex(core.btoa('Mozilla/5.0 (Windows NT 10.0) \u00e9\u00ff\u0000\t')) });
vectors.push({ label: 'btoa-throws-unicode', kind: 'btoa', in: hex('\u0100\u65e5'), errorExpected: true });

// atob: WHATWG edge cases (in is the hex of the b64 text so transport is safe)
var atobCases = [
  ['', ''],
  ['Zg==', 'f'],
  ['Zm8=', 'fo'],
  ['Zm9v', 'foo'],
  ['Zg', 'f'],
  ['Z m 8 =', 'fo'],
  ['\tZ\r\nm8\n=', 'fo'],
  ['AA==', '\u0000'],
  ['/w==', '\u00ff'],
  ['AIAB', '\u0000\u0080\u0001'],
  ['8J+YgA==', '\u00f0\u009f\u0098\u0080'],
  ['77+9', '\u00ef\u00bf\u00bd'],
  ['w6k=', '\u00c3\u00a9'],
  ['5pel5pys6Kqe', '\u00e6\u0097\u00a5\u00e6\u009c\u00ac\u00e8\u00aa\u009e'],
  ['YWJj', 'abc'],
  ['AA=', 'ERR'],
  ['AAA=', '\u0000\u0000'],
  ['AAA', '\u0000\u0000'],
  ['A', 'ERR'],
  ['=', 'ERR'],
  ['==', 'ERR'],
  ['====', 'ERR'],
  ['A===', 'ERR'],
  ['Zg=A', 'ERR'],
  ['AB==CD', 'ERR'],
  ['Zm9v!', 'ERR'],
  ['Zm9v_', 'ERR'],
  ['\u00e9', 'ERR'],
  ['\u0000', 'ERR'],
  ['ab===', 'ERR'],
  ['abcde', 'ERR'],
  ['abc=', 'i\u00b7'],
  ['ab==', 'i'],
  ['YQ', 'a'],
  ['/A', '\u00fc'],
  ['//A', '\u00ff\u00f0'],
  ['///A', '\u00ff\u00ff\u00c0'],
  ['AAA/', '\u0000\u0000\u003f'],
  ['a=', 'ERR'],
  ['ab=', 'ERR'],
  ['ab\t\n\f\r =\t\n\f\r =\t\n\f\r ', 'i']
];
for (var j = 0; j < atobCases.length; j++) {
  var inp = atobCases[j][0];
  var exp = atobCases[j][1];
  var errorExpected = exp === 'ERR';
  var expHex = errorExpected ? 'ERR' : hex(exp);
  vectors.push({ label: 'atob ' + JSON.stringify(inp), kind: 'atob', in: hex(inp), expect: expHex, errorExpected: errorExpected });
}

// utf8 lanes
var utf8Cases = [
  ['\u00e9', 'w6k='],
  ['\ud83d\ude00', '8J+YgA=='],
  ['\u65e5\u672c\u8a9e', '5pel5pys6Kqe'],
  ['\ud800', '77+9'],
  ['\u0000\u007f\u00ff', 'AH/Dvw=='],
  ['dieline \u03c0 \u00e9', 'ZGllbGluZSDPgCDDqQ==']
];
for (var k = 0; k < utf8Cases.length; k++) {
  var uIn = utf8Cases[k][0];
  var uB64 = utf8Cases[k][1];
  vectors.push({ label: 'encodeUtf8 ' + JSON.stringify(uIn), kind: 'encodeUtf8', in: hex(uIn), expect: hex(uB64) });
  // decodeUtf8(encodeUtf8(x)) is only identity for valid-UTF-8 x: latin1
  // bytes 0x80-0xFF decode as U+FFFD (invalid standalone UTF-8), lone
  // surrogates normalize to U+FFFD.
  var decodeExpect = core.decodeUtf8(uB64);
  vectors.push({ label: 'decodeUtf8 ' + uB64, kind: 'decodeUtf8', in: uB64, expect: hex(decodeExpect) });
}
// decodeUtf8 invalid-sequence cases (WHATWG expectations; byte b64 inputs)
var decErr = [
  ['8J+Y', 'fffd'],                  // F0 9F 98 truncated 4-byte
  ['w6', 'fffd'],                    // C3 truncated 2-byte
  ['wYE=', 'fffdfffd'],              // C1 81 overlong start
  ['4ICA', 'fffdfffd'],              // E0 80 80 overlong
  ['7aCA', 'fffdfffd'],              // ED A0 80 surrogate-encoded
  ['9JCA', 'fffdfffd'],              // F4 90 80 out of range
  ['gA==', 'fffd'],                  // 80 stray continuation
  ['w5Av', 'd02f']                   // C3 90 D0 valid, 2F invalid continuation
];
for (var d = 0; d < decErr.length; d++) {
  var decExpect = core.decodeUtf8(decErr[d][0]);
  vectors.push({ label: 'decodeUtf8-invalid ' + decErr[d][0], kind: 'decodeUtf8', in: decErr[d][0], expect: hex(decExpect) });
}

var expectedJson = JSON.stringify(vectors);

// ---- emit the battery probe -------------------------------------------------

var probeDir = join(process.env.TEMP || '', 'esb64-live');
mkdirSync(probeDir, { recursive: true });
var probePath = join(probeDir, 'esb64-live-battery.jsx');
var vendorForProbe = VENDOR.replace(/\\/g, '/');
var probeSrc = [
  '#target illustrator',
  '// generated by tests/esb64-live-verify.mjs - do not edit',
  'var esb64VendorPath = "' + vendorForProbe + '";',
  '$.evalFile(File(esb64VendorPath));',
  'var esb64Vectors = ' + expectedJson + ';',
  'function esb64Hex(s) {',
  '  var out = [], i, c, h;',
  '  for (i = 0; i < s.length; i++) {',
  '    c = s.charCodeAt(i).toString(16);',
  '    while (c.length < 4) { c = "0" + c; }',
  '    out[out.length] = c;',
  '  }',
  '  return out.join("");',
  '}',
  'function esb64HexToStr(h) {',
  '  var out = [], i;',
  '  for (i = 0; i < h.length; i += 4) {',
  '    out[out.length] = String.fromCharCode(parseInt(h.substring(i, i + 4), 16));',
  '  }',
  '  return out.join("");',
  '}',
  'var esb64Run = function () {',
  '  var capsBefore = { atob: typeof atob, btoa: typeof btoa };',
  '  var failures = [];',
  '  var i;',
  '  for (i = 0; i < esb64Vectors.length; i++) {',
  '    var v = esb64Vectors[i];',
  '    var got = "?";',
  '    var failed = false;',
  '    try {',
  '      if (v.kind === "btoa") { got = ESB64.btoa(esb64HexToStr(v.in)); }',
  '      else if (v.kind === "atob") { got = ESB64.atob(esb64HexToStr(v.in)); }',
  '      else if (v.kind === "encodeUtf8") { got = ESB64.encodeUtf8(esb64HexToStr(v.in)); }',
  '      else if (v.kind === "decodeUtf8") { got = ESB64.decodeUtf8(v.in); }',
  '      got = esb64Hex(got);',
  '      if (v.errorExpected) { failures[failures.length] = v.label + " (expected error, got " + got + ")"; continue; }',
  '    } catch (e) {',
  '      if (v.errorExpected) { continue; }',
  '      failures[failures.length] = v.label + " (threw " + String(e) + ")"; continue;',
  '    }',
  '    if (got !== v.expect) { failures[failures.length] = v.label + " (expected " + v.expect + ", got " + got + ")"; }',
  '  }',
  '  var capsAfter = { atob: typeof atob, btoa: typeof btoa };',
  '  return { ok: failures.length === 0, total: esb64Vectors.length, failures: failures,',
  '    capsBefore: capsBefore, capsAfter: capsAfter, engine: $.version,',
  '    memo: ESB64.btoa("memo") === ESB64.btoa("memo"),',
  '    roundtrip: ESB64.decodeUtf8(ESB64.encodeUtf8("dieline \\u00e9 \\ud83d\\ude00")) === "dieline \\u00e9 \\ud83d\\ude00" };',
  '};',
  'esb64Run();'
].join('\n');
writeFileSync(probePath, probeSrc);

// ---- run through the COM tool -----------------------------------------------

console.log('live-verify: running ' + vectors.length + ' vectors in Illustrator...');
var pyOut;
try {
  pyOut = execFileSync('python', [TOOL, 'eval', '--file', probePath.replace(/\\/g, '/')], {
    encoding: 'utf8', timeout: 180000
  });
} catch (e) {
  console.error('live-verify: COM tool failed: ' + String((e.stdout || e.message) + '').slice(0, 2000));
  process.exit(1);
}

var env;
try {
  env = JSON.parse(pyOut.trim());
} catch (e) {
  console.error('live-verify: tool output not JSON: ' + pyOut.slice(0, 500));
  process.exit(1);
}
if (!env.ok || !env.result || env.result.ok !== true) {
  console.error('live-verify: tool/engine error: ' + JSON.stringify(env).slice(0, 1500));
  process.exit(1);
}
var report = env.result.result;
if (report.ok !== true) {
  console.error('live-verify: ' + report.failures.length + ' engine failure(s) of ' + report.total);
  for (var f = 0; f < report.failures.length; f++) console.error('  FAIL ' + report.failures[f]);
  process.exit(1);
}
console.log('live-verify: all ' + report.total + ' vectors passed in the engine (Illustrator ' + report.engine + ')');
console.log('live-verify: caps before ' + JSON.stringify(report.capsBefore) + ' -> after ' + JSON.stringify(report.capsAfter));
console.log('live-verify: memo=' + report.memo + ' roundtrip=' + report.roundtrip);
