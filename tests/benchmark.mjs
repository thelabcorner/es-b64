#!/usr/bin/env node
// ESB64 Node-side benchmark: runs the facade benchmark lanes (btoa/atob
// against the native Node implementations) plus large-payload timing.
import { btoa, atob, encodeUtf8, decodeUtf8, benchmark } from '../dist/esb64-core.esm.mjs';

var items = benchmark(200);
for (var i = 0; i < items.length; i++) {
  var it = items[i];
  console.log(it.lane.padEnd(12) + ' median ' + String(it.medianUs).padStart(8) + ' us  min ' +
    String(it.minUs).padStart(6) + '  p95 ' + String(it.p95Us).padStart(8) + '  ops/s ' +
    String(Math.round(it.opsPerSec)).padStart(9) + '  vsNative ' + (it.vsNative ? it.vsNative.toFixed(2) + 'x' : '-'));
}

var big = '';
for (var j = 0; j < 200000; j++) big += 'dieline-export \u00e9\u00e8 \ud83d\ude00 ';
var t0 = process.hrtime.bigint();
var bigB64 = encodeUtf8(big);
var t1 = process.hrtime.bigint();
var back = decodeUtf8(bigB64);
var t2 = process.hrtime.bigint();
console.log('4.2M-char unicode payload: encodeUtf8 ' + Number(t1 - t0) / 1e6 + ' ms, decodeUtf8 ' +
  Number(t2 - t1) / 1e6 + ' ms, roundtrip-ok=' + (back === big) + ', out ' + bigB64.length + ' chars');
