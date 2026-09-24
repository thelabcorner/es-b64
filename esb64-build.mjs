#!/usr/bin/env node
// ESB64 build: bundles the TypeScript core into
//   dist/ESB64.jsx                - bannerless IIFE (COM-eval / $.evalFile safe),
//                                   defines var ESB64 (the facade)
//   dist/vendor-esb64.js          - production drop-in: facade + install footer
//                                   that fills the global atob/btoa gap when
//                                   absent (true polyfill semantics)
//   dist/vendor-esb64-runtime.js  - slim atob/btoa-only vendor (per-eval
//                                   injection), same gap-fill footer
//   dist/ESB64-runtime.jsx        - build intermediate (bare bundle, no shim,
//                                   no footer - not standalone-loadable)
//   dist/esb64-core.esm.mjs       - ESM bundle of the core for Node harnesses
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

var ROOT = dirname(fileURLToPath(import.meta.url));
var DIST = join(ROOT, 'dist');
var ENTRY = join(ROOT, 'src', 'index.ts');
var ESTC = join(ROOT, '..', 'extendscript-toolchain', 'bin', 'estc.mjs');

function findEsbuild() {
  if (process.env.ESBUILD_PATH && existsSync(process.env.ESBUILD_PATH)) return process.env.ESBUILD_PATH;
  var direct = join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild');
  if (existsSync(direct)) return direct;
  var cacheDirs = [
    join(process.env.LOCALAPPDATA || '', 'npm-cache', '_npx'),
    join(process.env.USERPROFILE || '', 'AppData', 'Local', 'npm-cache', '_npx')
  ];
  for (var i = 0; i < cacheDirs.length; i++) {
    try {
      var entries = readdirSync(cacheDirs[i]);
      for (var j = 0; j < entries.length; j++) {
        var p = join(cacheDirs[i], entries[j], 'node_modules', 'esbuild', 'bin', 'esbuild');
        if (existsSync(p)) return p;
      }
    } catch (ignore) {}
  }
  return 'npx esbuild';
}

function esmBuild(entry, outfile) {
  execFileSync(process.execPath, [
    findEsbuild(), entry, '--bundle', '--outfile=' + outfile,
    '--format=esm', '--platform=node', '--target=es2019',
    '--log-level=warning'
  ], { stdio: 'inherit' });
}

function estcBuild(config) {
  execFileSync(process.execPath, [ESTC, 'build', '--config', config], {
    cwd: ROOT,
    stdio: 'inherit'
  });
}

mkdirSync(DIST, { recursive: true });

// 1. ESM core bundle (Node harnesses import this).
esmBuild(ENTRY, join(DIST, 'esb64-core.esm.mjs'));

// 2. Canonical ExtendScript facade. ESTC owns ES3 normalization and keeps
// esbuild's helper compatibility bundle-local instead of mutating host globals.
var jsx = join(DIST, 'ESB64.jsx');
estcBuild('./extendscript.estc.config.mjs');

// 2b. Accelerated self-extracting single-file bundle (ESB64.accel.jsx).
// Requires: native/bin/ESB64Native.dll (npm run native-build) + the sibling
// espack repo (../espack). Composition: espack bundle (defines ESPAK with the
// inlined atob lane + the embedded DLL) + this facade (defines ESB64) + the
// accelerator adapter (ESPAK.attach: ES3-first, native swap on success).
// Skips silently when the inputs are absent so the base build keeps working.
var ACCELERATOR = [
  '',
  '(function () {',
  '  // ESB64 accelerator adapter (ESPAK capability switch) - ES3 first, native',
  '  // swap on success. Parity contract: the native lane must produce',
  '  // byte-identical results to the ES3 lane for every input dispatched',
  '  // here; esb64\'s differential corpus runs in both modes (live-verify).',
  '  if (typeof ESPAK !== "object" || !ESPAK || typeof ESPAK.attach !== "function") return;',
  '  var origAtob = ESB64.atob;',
  '  var origBtoa = ESB64.btoa;',
  '  var NON_LATIN1_RE = /[^\\x00-\\xff]/;',
  '  var NON_ASCII_RE = /[^\\x01-\\x7f]/;',
  '  function invalidCharacter(msg) {',
  '    var e = new Error(msg);',
  '    try { e.name = "InvalidCharacterError"; } catch (ignore) {}',
  '    return e;',
  '  }',
  '  // Lane C (merge architecture v1): attach by NAME, never index 0 - the',
  '  // merged bundle carries multiple payloads and index 0 is not ESB64Native.',
  '  var accel = ESPAK.attach({',
  '    es3: null,',
  '    buildNative: function (lib) {',
  '      return {',
  '        atob: function (text) {',
  '          var raw = String(text);',
  '          // NUL/non-ASCII cannot cross the string boundary reliably:',
  '          // keep the WHATWG-exact ES3 lane for them.',
  '          if (NON_ASCII_RE.test(raw)) return origAtob(raw);',
  '          var out;',
  '          try { out = lib.b64decode(raw); }',
  '          catch (e) {',
  '            if (typeof e.number === "number" && e.number === 10001) {',
  '              throw invalidCharacter("atob: the string to be decoded is not correctly encoded");',
  '            }',
  '            // Any other POSITIVE native error (e.g. 10004 allocator',
  '            // exhaustion) is a transient lane failure: fall back to the ES3',
  '            // lane for this call. Negative codes are fatal, never returned.',
  '            if (typeof e.number === "number" && e.number > 0) return origAtob(raw);',
  '            throw e;',
  '          }',
  '          if (typeof out !== "string") return origAtob(raw);',
  '          return out;',
  '        },',
  '        btoa: function (text) {',
  '          var raw = String(text);',
  '          if (raw.indexOf("\\0") >= 0 || NON_LATIN1_RE.test(raw)) return origBtoa(raw);',
  '          var out;',
  '          try { out = lib.b64encode(raw); }',
  '          catch (e) {',
  '            if (typeof e.number === "number" && e.number === 10002) {',
  '              throw invalidCharacter("btoa: the string to be encoded contains characters outside of the Latin1 range");',
  '            }',
  '            // Any other POSITIVE native error (e.g. 10004 allocator',
  '            // exhaustion) is a transient lane failure: fall back to the ES3',
  '            // lane for this call. Negative codes are fatal, never returned.',
  '            if (typeof e.number === "number" && e.number > 0) return origBtoa(raw);',
  '            throw e;',
  '          }',
  '          return out;',
  '        }',
  '      };',
  '    },',
  '    onMode: function (mode, lib, impl) {',
  '      if (mode === "native") {',
  '        ESB64.atob = impl.atob;',
  '        ESB64.btoa = impl.btoa;',
  '        ESB64.encodeLatin1 = impl.btoa;',
  '        ESB64.decodeLatin1 = impl.atob;',
  '        var g = null;',
  '        try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}',
  '        if (g) {',
  '          if (g.atob === origAtob) g.atob = impl.atob;',
  '          if (g.btoa === origBtoa) g.btoa = impl.btoa;',
  '        }',
  '      }',
  '    }',
  '  }, "ESB64Native");',
  '  if (accel && accel.mode) ESB64.acceleration = accel.mode;',
  '  var g = null;',
  '  try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}',
  '  if (g) { g.ESB64 = ESB64; g.ESPAK = ESPAK; }',
  '}());',
  ''
].join('\n');

function buildAccel() {
  var espackDir = join(ROOT, '..', 'espack');
  var espackBuild = join(espackDir, 'espack-build.mjs');
  var dll = join(ROOT, 'native', 'bin', 'ESB64Native.dll');
  if (!existsSync(espackBuild)) {
    console.log('[esb64-build] accel skipped: espack repo not found at ' + espackDir);
    return;
  }
  if (!existsSync(dll)) {
    console.log('[esb64-build] accel skipped: ' + dll + ' missing (run npm run native-build)');
    return;
  }
  var accelBundle = join(DIST, '.esb64-accel-bundle.jsx');
  // accelerator-only bundle: the shared "1" in the espack 1+n model (the
  // ESB64Native DLL unpacks once per system via the JSX lane, then serves
  // every espack bundle; there is no per-bundle payload here).
  execFileSync(process.execPath, [espackBuild, '--accel', dll, '--accel-version', '2', '--out', accelBundle,
    '--name', 'esb64', '--quiet'], {
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      ESB64_RUNTIME_PATH: join(DIST, 'vendor-esb64-runtime.js')
    })
  });
  var bundleText = readFileSync(accelBundle, 'utf8');
  var facadeText = readFileSync(join(DIST, 'ESB64.jsx'), 'utf8');
  // Lane C (merge architecture): emit the manifest sidecar (pinned schema
  // contract/manifest-schema-v1) + the loader-free facade artifact for the
  // composer. Accel-only: no payloads, the shared ESB64Native accelerator is
  // the single "1" that every merged bundle shares.
  var dllBytes = readFileSync(dll);
  var accelManifest = {
    format: 'espack-manifest',
    version: 1,
    bundleName: 'esb64',
    cacheDir: '',
    chunkSize: 24576, // mirrors espack-build.mjs CHUNK_SIZE
    accel: {
      name: 'ESB64Native',
      version: '2',
      len: dllBytes.length,
      b64: dllBytes.toString('base64'),
      fileName: 'ESB64Native_v2.dll'
    },
    payloads: []
  };
  writeFileSync(join(DIST, 'ESB64.manifest.json'), JSON.stringify(accelManifest, null, 2) + '\n');
  var facadeOut = facadeText + '\n' + ACCELERATOR +
    '// ESB64.facade.jsx - loader-free facade + espack adapter (composer appends to a merged bundle; requires ESPAK on $.global)\n';
  writeFileSync(join(DIST, 'ESB64.facade.jsx'), facadeOut);
  var accelOut = bundleText + '\n' + facadeText + '\n' + ACCELERATOR +
    '// ESB64.accel.jsx - self-extracting single-file bundle (espack 1+n + ESB64 + accelerator)\n';
  writeFileSync(join(DIST, 'ESB64.accel.jsx'), accelOut);
  console.log('[esb64-build] wrote ' + join(DIST, 'ESB64.accel.jsx') + ' (' + accelOut.length + ' bytes)' +
    ' + ESB64.manifest.json + ESB64.facade.jsx');
  minifyAccel(accelOut);
}

// Minify the accelerated bundle via the adobe-extendscript-minification
// skill's conservative pipeline (UglifyJS + switch repair + directive
// restore + node --check). The espack banner (leading block comment) is
// extracted BEFORE minification and restored after - the conservative
// config strips comments, and the banner identifies the generated artifact.
function minifyAccel(accelOut) {
  var skillDir = join(ROOT, '..', 'agent-skills', 'adobe-extendscript-minification');
  var minifyScript = join(skillDir, 'scripts', 'minify-jsx.py');
  var minifyConfig = join(skillDir, 'configs', 'conservative.json');
  if (!existsSync(minifyScript) || !existsSync(minifyConfig)) {
    console.log('[esb64-build] accel minify skipped: minification skill not found at ' + skillDir);
    return;
  }
  var m = accelOut.match(/^\/\*[\s\S]*?\*\//);
  var banner = m ? m[0] : '';
  var body = m ? accelOut.substring(m[0].length) : accelOut;
  var bodyPath = join(DIST, '.esb64-accel-bundle.body.jsx');
  var minPath = join(DIST, '.esb64-accel-bundle.min.jsx');
  writeFileSync(bodyPath, body, 'utf8');
  execFileSync('python', [minifyScript, '--in', bodyPath, '--config', minifyConfig,
    '--out', minPath], { stdio: 'inherit' });
  var minBody = readFileSync(minPath, 'utf8');
  var minOut = (banner ? banner + '\n' : '') + minBody;
  var minFinal = join(DIST, 'ESB64.accel.min.jsx');
  writeFileSync(minFinal, minOut, 'utf8');
  console.log('[esb64-build] wrote ' + minFinal + ' (' + minOut.length + ' bytes, banner preserved)');
}

// 3. Production vendor: ESTC applies the gap-fill footer after normalization.
estcBuild('./extendscript.vendor.estc.config.mjs');

// 4. Runtime-only artifacts: tree-shaken atob+btoa core for per-eval injection.
estcBuild('./extendscript.runtime.estc.config.mjs');
estcBuild('./extendscript.runtime-vendor.estc.config.mjs');

// 5. Accelerated self-extracting bundle (when the DLL + espack exist).
if (process.argv.includes('--accel')) {
  buildAccel();
}

console.log('[esb64-build] wrote ' + join(DIST, 'ESB64.jsx') + ', ' + join(DIST, 'vendor-esb64.js') + ', ' +
  join(DIST, 'vendor-esb64-runtime.js') + ' and ' + join(DIST, 'esb64-core.esm.mjs'));
