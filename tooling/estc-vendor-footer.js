(function () {
  var g = null;
  try { if (typeof $ !== "undefined" && $.global) { g = $.global; } } catch (e1) {}
  if (!g) { try { g = (function () { return this; })(); } catch (e2) {} }
  if (!g) return;
  if (typeof g.atob !== "function") { g.atob = ESB64.atob; }
  if (typeof g.btoa !== "function") { g.btoa = ESB64.btoa; }
})();
