#target illustrator
// ESB64 example 04: export artboard -> SVG data URL envelope (full build).
//
// The realistic Illustrator pattern: export the active artboard to SVG,
// ship the file as a base64 data URL (encodeUtf8 -- SVG is UTF-8, so the
// latin1-only btoa would corrupt non-ASCII), then decodeUtf8 the envelope
// and verify it is byte-identical to the exported file.
//
// Demonstrates the golden pipeline: preflight -> export -> encode -> verify
// -> report. Reads the document only; writes to %TEMP%.
//
// KNOWN HOST SIDE EFFECT (verified live on 30.6.0): exportFile(SVG) renames
// the active document to the export target filename (saved and unsaved docs
// alike; unsaved docs are also marked saved). The example snapshots and
// REPORTS the change below -- it cannot undo it (doc.name is read-only). For
// production use, export from a duplicated document or accept the rename.
//
// How to run: open a document with an artboard, then File > Scripts >
// Other Script..., or
//   python ILLUSTRATOR_COM_TOOL.py eval --file examples/04-svg-data-url-batch.jsx
// Report: %TEMP%\esb64example-04-report.json + last-statement value.

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

var out = { ok: false, checks: [], phase: 'preflight' };
function check(name, ok, detail) {
  out.checks.push({ name: name, ok: !!ok, detail: detail });
  if (!ok) out.ok = false;
}

// --- preflight --------------------------------------------------------------
var doc = app.activeDocument;
check('active-document', !!doc, doc ? '' : 'no open document -- open or create one first');
check('has-artboard', !!doc && doc.artboards.length > 0, doc && doc.artboards.length > 0 ? '' : 'document has no artboard');

if (doc && doc.artboards.length > 0) {
  out.phase = 'export';

  // snapshot: exportFile(SVG) renames the active document -- capture the
  // pre-state so the report can surface the side effect explicitly
  var docNameBefore = doc.name;
  var docSavedBefore = doc.saved;

  var svgPath = $.getenv('TEMP') + '/esb64-example-04.svg';
  var svgPathFs = svgPath.replace(/\\/g, '/');

  // --- commit: export the active artboard as uncompressed UTF-8 SVG --------
  // Pin the encoding: encodeUtf8 produces UTF-8 bytes, so the data URL is
  // only a truthful "image/svg+xml;base64" if the SVG really is UTF-8
  // (Illustrator's export default is iso-8859-1, which would corrupt
  // non-ASCII artwork through this pipeline).
  var opts = new ExportOptionsSVG();
  opts.compressed = false;
  opts.documentEncoding = SVGDocumentEncoding.UTF8;
  doc.exportFile(new File(svgPathFs), ExportType.SVG, opts); // arg 1 is a File

  var svgFile = new File(svgPathFs);
  check('svg-written', svgFile.exists && svgFile.length > 0, svgPathFs);
  var svgText = null;
  if (svgFile.exists) {
    svgFile.encoding = 'UTF-8';
    var opened = svgFile.open('r');
    if (opened) { svgText = svgFile.read(); svgFile.close(); }
    check('svg-readable', svgText !== null, '');
  }

  if (svgText !== null) {
    // --- encode: UTF-8 safe base64 -> data URL ------------------------------
    var b64 = ESB64.encodeUtf8(svgText);
    var dataUrl = 'data:image/svg+xml;base64,' + b64;

    var durlFile = new File($.getenv('TEMP') + '/esb64-example-04-dataurl.txt');
    durlFile.encoding = 'UTF-8';
    durlFile.open('w');
    durlFile.write(dataUrl);
    durlFile.close();
    check('dataurl-written', durlFile.exists && durlFile.length > 0, 'data URL is ' + dataUrl.length + ' chars');

    // --- verify: decode the envelope and compare byte-for-byte --------------
    var back = ESB64.decodeUtf8(dataUrl.substring('data:image/svg+xml;base64,'.length));
    check('roundtrip-byte-identical', back === svgText,
      back === svgText ? svgText.length + ' chars' : 'MISMATCH at first differing position');

    out.result = {
      svgPath: svgPathFs,
      svgChars: svgText.length,
      svgBytes: svgFile.length,
      dataUrlChars: dataUrl.length,
      envelopeOverhead: dataUrl.length - svgText.length,
      roundtrip: back === svgText,
      sideEffects: {
        docNameBefore: docNameBefore,
        docNameAfter: doc.name,
        savedBefore: docSavedBefore,
        savedAfter: doc.saved,
        note: 'exportFile(SVG) renamed the document to the export target (host behavior, not undoable)'
      }
    };
    out.ok = out.result.roundtrip && out.checks[out.checks.length - 1].ok;
    out.phase = 'done';
  }
}

// --- report ---------------------------------------------------------------
var __report = JSON.stringify(out, null, 2);
$.writeln('ESB64 example 04: ' + (out.ok ? 'PASS' : 'FAIL'));
$.writeln(__report);
var __rf = new File($.getenv('TEMP') + '/esb64example-04-report.json');
__rf.encoding = 'UTF-8';
__rf.open('w');
__rf.write(__report);
__rf.close();
__report;
