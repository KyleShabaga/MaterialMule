// Post-build: the canvas loads React and ReactDOM asynchronously, after this script has run.
// Wrap the bundle so it starts as soon as both globals exist and are filled in (the UMD builds
// assign an empty object first, then populate it), and before the canvas renders any artboard.
const fs = require("fs")
const file = __dirname + "/dist/strata-ui.js"
const bundle = fs.readFileSync(file, "utf8")
const wrapped = `(function () {
  var started = false;
  function ready(R, D) { return R && D && typeof R.createElement === "function" && typeof D.createPortal === "function"; }
  function start() {
    if (started) return;
    started = true;
    ${bundle}
  }
  if (ready(window.React, window.ReactDOM)) { start(); return; }
  var R = window.React, D = window.ReactDOM;
  function check() { if (ready(R, D)) start(); }
  Object.defineProperty(window, "React", { configurable: true, get: function () { return R; }, set: function (v) { R = v; queueMicrotask(check); } });
  Object.defineProperty(window, "ReactDOM", { configurable: true, get: function () { return D; }, set: function (v) { D = v; queueMicrotask(check); } });
})();
`
fs.writeFileSync(file, wrapped)
console.log("wrapped", wrapped.length)
