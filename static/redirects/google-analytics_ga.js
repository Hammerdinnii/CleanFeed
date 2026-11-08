/* CleanFeed surrogate for legacy Google Analytics (ga.js / _gaq). */
(function () {
  'use strict';
  var noop = function () {};
  var tracker = new Proxy({}, { get: function () { return noop; } });
  var gat = { _getTracker: function () { return tracker; }, _getTrackerByName: function () { return tracker; }, _createTracker: function () { return tracker; }, _anonymizeIp: noop };
  window._gat = gat;
  var gaq = { push: function () {
    for (var i = 0; i < arguments.length; i++) {
      var a = arguments[i];
      if (typeof a === 'function') { try { a(); } catch (e) {} }
    }
    return 0;
  } };
  var old = window._gaq;
  window._gaq = gaq;
  if (Array.isArray(old)) gaq.push.apply(gaq, old);
})();
