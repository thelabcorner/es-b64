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

function jsxBuild(entry, outfile) {
  execFileSync(process.execPath, [
    findEsbuild(), entry, '--bundle', '--outfile=' + outfile,
    '--format=iife', '--global-name=ESB64', '--platform=neutral', '--target=es5',
    '--log-level=warning'
  ], { stdio: 'inherit' });
}

mkdirSync(DIST, { recursive: true });

// 1. ESM core bundle (Node harnesses import this).
esmBuild(ENTRY, join(DIST, 'esb64-core.esm.mjs'));

// 2. JSX bundle with the ES3 shim prepended. ExtendScript (SpiderMonkey 2014)
//    lacks Object.defineProperty and Function.prototype.bind, which esbuild's
//    ES5 export helpers require.
var jsx = join(DIST, 'ESB64.jsx');
jsxBuild(ENTRY, jsx);

var shim = [
  'if (typeof Object.defineProperty !== "function") {',
  '  Object.defineProperty = function (obj, prop, desc) {',
  '    if (desc) {',
  '      if (typeof desc.get === "function") {',
  '        if (typeof obj.__defineGetter__ === "function") { obj.__defineGetter__(prop, desc.get); }',
  '        else { obj[prop] = desc.get(); }',
  '      } else if ("value" in desc) {',
  '        obj[prop] = desc.value;',
  '      }',
  '    }',
  '    return obj;',
  '  };',
  '  Object.getOwnPropertyDescriptor = function (obj, prop) {',
  '    return { value: obj[prop], writable: true, enumerable: true, configurable: true };',
  '  };',
  '  Object.getOwnPropertyNames = function (obj) {',
  '    var a = [], k;',
  '    for (k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { a.push(k); } }',
  '    return a;',
  '  };',
  '}',
  'if (typeof Function.prototype.bind !== "function") {',
  '  Function.prototype.bind = function (thisArg) {',
  '    var fn = this;',
  '    var args = Array.prototype.slice.call(arguments, 1);',
  '    return function () {',
  '      return fn.apply(thisArg, args.concat(Array.prototype.slice.call(arguments)));',
  '    };',
  '  };',
  '}',
  ''
].join('\n');

var finalJsx = shim + readFileSync(jsx, 'utf8');
finalJsx = finalJsx.replace(/"use strict";?/g, '');
writeFileSync(jsx, finalJsx);

// 3. Production vendor: the same bundle + a gap-fill footer. Unlike ESON
//    (which REPLACES the host JSON because the native one is permissive),
//    native atob/btoa implementations are spec-fine, so the vendor only
//    installs when the globals are absent. install({ forceReplace: true })
//    overrides. The ESB64 facade is always available as the global `ESB64`.
var footer = [
  '(function () {',
  '  var g = null;',
  '  try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}',
  '  if (!g) { try { g = (function () { return this; })(); } catch (e2) {} }',
  '  if (!g) return;',
  '  if (typeof g.atob !== "function") { g.atob = ESB64.atob; }',
  '  if (typeof g.btoa !== "function") { g.btoa = ESB64.btoa; }',
  '})();',
  ''
].join('\n');

var vendor = finalJsx + '\n' + footer;
writeFileSync(join(DIST, 'vendor-esb64.js'), vendor);

// 4. Runtime-only vendor: tree-shaken atob+btoa core for per-eval injection.
var runtimeJsx = join(DIST, 'ESB64-runtime.jsx');
jsxBuild(join(ROOT, 'src', 'runtime.ts'), runtimeJsx);
var runtimeFinal = shim + readFileSync(runtimeJsx, 'utf8');
runtimeFinal = runtimeFinal.replace(/"use strict";?/g, '');
var runtimeVendor = runtimeFinal + '\n' + footer;
writeFileSync(join(DIST, 'vendor-esb64-runtime.js'), runtimeVendor);

console.log('[esb64-build] wrote ' + join(DIST, 'ESB64.jsx') + ', ' + join(DIST, 'vendor-esb64.js') + ', ' +
  join(DIST, 'vendor-esb64-runtime.js') + ' and ' + join(DIST, 'esb64-core.esm.mjs'));
