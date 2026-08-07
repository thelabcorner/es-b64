#target illustrator
// ESB64 benchmark probe: runs the in-module benchmark in the live engine
// (medians of N iterations, $.hiresTimer). Adjust the vendor path below.
var esb64BenchProbe = (function () {
  var VENDOR = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/esb64/dist/vendor-esb64.js";
  var out = { engine: $.version, vendor: VENDOR };
  try {
    $.evalFile(File(VENDOR));
    out.items = ESB64.benchmark(50);
    // large-payload lanes (unique text so the memo never hits). NOTE: build
    // the payload with array+join - += concat in a loop is quadratic in this
    // engine (documented ExtendScript quirk).
    var parts = [];
    var i;
    for (i = 0; i < 20000; i++) parts[parts.length] = "dieline \u00e9\u00e8 \ud83d\ude00 \u65e5\u672c\u8a9e";
    var big = parts.join("");
    var t0 = $.hiresTimer;
    var bigB64 = ESB64.encodeUtf8(big);
    var t1 = $.hiresTimer;
    var back = ESB64.decodeUtf8(bigB64);
    var t2 = $.hiresTimer;
    var d1 = t1 - t0;
    var d2 = t2 - t1;
    out.bigPayload = {
      chars: big.length,
      outChars: bigB64.length,
      encodeMs: d1 > 0 && d1 < 10000000 ? d1 / 1000 : -1,
      decodeMs: d2 > 0 && d2 < 10000000 ? d2 / 1000 : -1,
      roundtripOk: back === big
    };
    out.memoHit = (function () {
      var p = "memo-hit-payload-\u00e9";
      var q = ESB64.btoa(p);
      var u0 = $.hiresTimer;
      var r1 = ESB64.btoa(p);
      var u1 = $.hiresTimer;
      var r2 = ESB64.btoa(p);
      var u2 = $.hiresTimer;
      return { hit: r1 === q && r2 === q, secondUs: u1 - u0, thirdUs: u2 - u1 };
    })();
  } catch (e) {
    out.error = String(e);
  }
  return out;
})();
esb64BenchProbe;
