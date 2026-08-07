// ESB64 test entry. Runs in Node against the bundled ESM core, with Node's
// native atob/btoa as the differential oracle (Node >= 16 implements the
// WHATWG forgiving-base64), Buffer for UTF-8 encode parity and TextDecoder
// (Node >= 18) for UTF-8 decode parity. Failures propagate as a nonzero exit
// via an unhandled throw at the end.
import {
  btoa as esb64Btoa,
  atob as esb64Atob,
  encodeUtf8,
  decodeUtf8,
  utf8Encode,
  utf8Decode,
  capabilities
} from '../src/index';
import {
  makeB64Vectors,
  makeAtobVectors,
  makeUtf8Vectors,
  makeMixedPayload
} from './vectors';
import { WPT_B64_CORPUS } from './wpt-b64-corpus';

var count = 0;
var failures: string[] = [];

function ok(cond: boolean, name: string): void {
  count++;
  if (!cond) failures[failures.length] = name;
}

function eq(actual: any, expected: any, name: string): void {
  count++;
  if (actual !== expected) {
    failures[failures.length] = name + ' (expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) + ')';
  }
}

function throwsInvalidChar(fn: () => any, name: string): void {
  count++;
  try {
    fn();
    failures[failures.length] = name + ' (expected InvalidCharacterError, did not throw)';
  } catch (e: any) {
    if (!(e instanceof Error) || e.name !== 'InvalidCharacterError') {
      failures[failures.length] = name + ' (expected InvalidCharacterError, got ' + String(e) + ')';
    }
  }
}

function bytesToText(bytes: number[]): string {
  var s = '';
  var i: number;
  for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ---- 1. btoa vectors + native differential ------------------------------

var b64Vectors = makeB64Vectors();
for (var i = 0; i < b64Vectors.length; i++) {
  var v = b64Vectors[i];
  if (v.throws) {
    throwsInvalidChar(function (): any { return esb64Btoa(v.input); }, 'btoa throws: ' + v.name);
  } else {
    var actual = esb64Btoa(v.input);
    if (v.expect !== undefined) {
      eq(actual, v.expect, 'btoa: ' + v.name);
    }
    eq(actual, btoa(v.input), 'btoa native parity: ' + v.name);
    // round trip through native atob
    eq(atob(actual), String(v.input), 'native atob(btoa(x)): ' + v.name);
  }
}

// ---- 2. atob vectors + native differential ------------------------------

var atobVectors = makeAtobVectors();
for (var j = 0; j < atobVectors.length; j++) {
  var av = atobVectors[j];
  if (av.throws) {
    throwsInvalidChar(function (): any { return esb64Atob(av.input); }, 'atob throws: ' + av.name);
    try {
      atob(av.input);
      failures[failures.length] = 'native atob parity (throws expected): ' + av.name;
    } catch (e2: any) {
      eq(e2.name, 'InvalidCharacterError', 'native atob error name: ' + av.name);
    }
  } else {
    var d = esb64Atob(av.input);
    eq(d, av.expect, 'atob: ' + av.name);
    eq(d, atob(av.input), 'atob native parity: ' + av.name);
  }
}

// ---- 3. WPT base64.json corpus -------------------------------------------

for (var k = 0; k < WPT_B64_CORPUS.length; k++) {
  var wpt = WPT_B64_CORPUS[k];
  var input = wpt[0];
  var expected = wpt[1];
  if (expected === null) {
    throwsInvalidChar(function (): any { return esb64Atob(input); }, 'wpt throws: ' + JSON.stringify(input));
    var threwNative = false;
    try {
      atob(input);
    } catch (e3) {
      threwNative = true;
    }
    eq(threwNative, true, 'wpt native parity (throws): ' + JSON.stringify(input));
  } else {
    eq(esb64Atob(input), bytesToText(expected), 'wpt: ' + JSON.stringify(input));
    eq(atob(input), bytesToText(expected), 'wpt native parity: ' + JSON.stringify(input));
    // btoa (latin1) of the decoded bytes must match canonical b64 of the
    // same bytes (inputs with whitespace/missing padding normalize)
    var canonical = btoa(bytesToText(expected));
    eq(esb64Btoa(bytesToText(expected)), canonical, 'wpt b64 roundtrip: ' + JSON.stringify(input));
  }
}

// ---- 4. UTF-8 lanes vs Buffer / TextDecoder -------------------------------

var utf8Vectors = makeUtf8Vectors();
for (var u = 0; u < utf8Vectors.length; u++) {
  var uv = utf8Vectors[u];
  if (uv.b64 !== undefined && uv.b64 !== '') {
    var enc = encodeUtf8(uv.input);
    eq(enc, uv.b64, 'encodeUtf8: ' + uv.name);
    eq(enc, Buffer.from(uv.input, 'utf8').toString('base64'), 'encodeUtf8 buffer parity: ' + uv.name);
    if (!uv.noRoundtrip) {
      eq(decodeUtf8(enc), uv.input, 'decodeUtf8 roundtrip: ' + uv.name);
    } else {
      // TextEncoder semantics: lone surrogates normalize to U+FFFD
      eq(decodeUtf8(enc), uv.noRoundtripExpect, 'decodeUtf8 lone-surrogate normalization: ' + uv.name);
    }
  }
  if (uv.byteB64 !== undefined) {
    var dec = decodeUtf8(uv.byteB64);
    eq(dec, uv.expect, 'decodeUtf8: ' + uv.name);
    if (!uv.invalidSeq) {
      // Valid byte streams: Node's TextDecoder (ICU) matches WHATWG. Malformed
      // streams diverge (ICU emits one FFFD per bad byte; WHATWG groups
      // errors), so those expectations are hardcoded, not oracle-differenced.
      // ignoreBOM: TextDecoder strips a leading U+FEFF by default; the codec
      // round-trips BOMs byte-exactly instead.
      var bytes = Buffer.from(uv.byteB64, 'base64');
      var td = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
      eq(dec, td, 'decodeUtf8 TextDecoder parity: ' + uv.name);
    }
  }
}

// mixed payload full pipeline: encode -> decode identity (Node and local)
var mixed = makeMixedPayload();
var mixedB64 = encodeUtf8(mixed);
eq(mixedB64, Buffer.from(mixed, 'utf8').toString('base64'), 'mixed payload buffer parity');
eq(decodeUtf8(mixedB64), mixed, 'mixed payload roundtrip');

// utf8Encode/utf8Decode raw lanes
var rawBytes = utf8Encode(mixed);
eq(rawBytes, Buffer.from(mixed, 'utf8').toString('binary'), 'utf8Encode buffer parity');
eq(utf8Decode(rawBytes), mixed, 'utf8Decode roundtrip');

// ---- 5. Memo sanity --------------------------------------------------------

var m1 = esb64Btoa('memo-test');
var m2 = esb64Btoa('memo-test');
eq(m1, m2, 'btoa memo same value');
var d1 = esb64Atob('bWVtby10ZXN0');
var d2 = esb64Atob('bWVtby10ZXN0');
eq(d1, d2, 'atob memo same value');
// '__proto__' is a legal payload and must not corrupt the memo store
eq(esb64Btoa('__proto__'), btoa('__proto__'), 'btoa __proto__ payload');
eq(esb64Atob('X19wcm90b19f'), atob('X19wcm90b19f'), 'atob __proto__ payload');
// memoized errors re-throw AS ERRORS (same type/name, not a string)
var errCount = 0;
var e4: any;
var e6: any;
try { esb64Atob('bad!'); } catch (e5) { errCount++; e4 = e5; }
try { esb64Atob('bad!'); } catch (e5) { errCount++; e6 = e5; }
eq(errCount, 2, 'atob memoized error re-throws');
ok(e4 instanceof Error, 'memoized error is an Error');
ok(e6 instanceof Error, 'memoized re-throw is still an Error');
eq(e6 && e6.name, 'InvalidCharacterError', 'memoized re-throw keeps the error name');
var errCount2 = 0;
try { esb64Btoa('\u0100'); } catch (e5) { errCount2++; }
try { esb64Btoa('\u0100'); } catch (e5) { errCount2++; ok(e5 instanceof Error, 'btoa memoized re-throw is an Error'); }
eq(errCount2, 2, 'btoa memoized error re-throws');

// ---- 6. capabilities --------------------------------------------------------

var caps = capabilities();
eq(caps.nativeAtob, true, 'caps native atob in Node');
eq(caps.nativeBtoa, true, 'caps native btoa in Node');
eq(caps.utf8, true, 'caps utf8');

// ---- report ------------------------------------------------------------------

if (failures.length > 0) {
  console.error('ESB64: ' + failures.length + ' failure(s) of ' + count + ' checks');
  for (var f = 0; f < failures.length; f++) {
    console.error('  FAIL ' + failures[f]);
  }
  throw new Error(failures.length + " failure(s)");
}
console.log('ESB64: all ' + count + ' checks passed');
