#target illustrator
// ESB64 capability probe: reports what the engine exposes before/after the
// vendor install. Run via the COM tool:
//   python .../ILLUSTRATOR_COM_TOOL.py eval --file probes/esb64-capability-probe.jsx
// Adjust the vendor path below to your checkout.
var esb64CapProbe = (function () {
  var VENDOR = "C:/Program Files/Adobe/Adobe Illustrator 2026/Presets/en_US/Scripts/esb64/dist/vendor-esb64.js";
  var out = { engine: $.version };
  var g = $.global;
  out.before = {
    atob: typeof g.atob,
    btoa: typeof g.btoa,
    escape: typeof g.escape,
    unescape: typeof g.unescape,
    JSON: typeof g.JSON
  };
  try {
    $.evalFile(File(VENDOR));
    out.after = {
      atob: typeof g.atob,
      btoa: typeof g.btoa,
      sameFacade: typeof ESB64 === "object" && typeof ESB64.btoa === "function"
    };
    out.caps = ESB64.capabilities();
    var nul = String.fromCharCode(0);
    out.nulEncode = ESB64.btoa(nul + "A");          // 'AEE=' - charAt bug would corrupt
    out.nulDecode = ESB64.atob("AEE=") === nul + "A";
    out.roundtrip = ESB64.decodeUtf8(ESB64.encodeUtf8("dieline \u00e9 \ud83d\ude00 \u65e5\u672c\u8a9e")) ===
      "dieline \u00e9 \ud83d\ude00 \u65e5\u672c\u8a9e";
    out.throwing = (function () {
      try { g.atob("!"); return false; }
      catch (e) { return e.name === "InvalidCharacterError"; }
    })();
    out.installed = g.atob === ESB64.atob && g.btoa === ESB64.btoa;
  } catch (e) {
    out.error = String(e);
  }
  return out;
})();
esb64CapProbe;
