/* CleanFeed surrogate for Amazon Publisher Services (apstag). */
(function () {
  'use strict';
  var noop = function () {};
  window.apstag = {
    init: noop,
    setDisplayBids: noop,
    targetingKeys: function () { return []; },
    fetchBids: function (cfg, cb) { if (typeof cb === 'function') { try { cb([]); } catch (e) {} } },
    _Q: [],
  };
})();
