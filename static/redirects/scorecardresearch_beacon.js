/* CleanFeed surrogate for comScore beacon.js. */
(function () {
  'use strict';
  var noop = function () {};
  window.COMSCORE = { purge: noop, beacon: noop };
  window.self.COMSCORE = window.COMSCORE;
})();
