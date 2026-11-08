/* CleanFeed surrogate for AdSense (adsbygoogle.js): accepts pushes, renders nothing. */
(function () {
  'use strict';
  var w = window;
  var impl = { push: function () {}, loaded: true };
  var queued = w.adsbygoogle;
  w.adsbygoogle = impl;
  if (Array.isArray(queued)) {
    for (var i = 0; i < queued.length; i++) {
      var q = queued[i];
      if (q && typeof q.onload === 'function') { try { q.onload(); } catch (e) {} }
    }
  }
})();
