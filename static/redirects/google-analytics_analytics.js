/* CleanFeed surrogate for Google Analytics (analytics.js): keeps pages that call ga() working. */
(function () {
  'use strict';
  var noop = function () {};
  var Tracker = function () {};
  Tracker.prototype.get = noop;
  Tracker.prototype.set = noop;
  Tracker.prototype.send = noop;
  var w = window;
  var name = w.GoogleAnalyticsObject || 'ga';
  var queue = w[name] && w[name].q;
  var ga = function () {
    var len = arguments.length;
    if (len === 0) return;
    var args = Array.prototype.slice.call(arguments);
    var last = args[len - 1];
    var hit = last && typeof last === 'object' ? last.hitCallback : null;
    if (typeof hit === 'function') {
      try { hit(); } catch (e) {}
    }
    if (typeof args[0] === 'function') {
      try { args[0](new Tracker()); } catch (e) {}
    }
  };
  ga.create = function () { return new Tracker(); };
  ga.getByName = function () { return new Tracker(); };
  ga.getAll = function () { return [new Tracker()]; };
  ga.remove = noop;
  ga.loaded = true;
  w[name] = ga;
  // Run queued callbacks (e.g. hitCallback-driven navigation).
  if (Array.isArray(queue)) {
    for (var i = 0; i < queue.length; i++) {
      try { ga.apply(null, queue[i]); } catch (e) {}
    }
  }
  var dl = w.dataLayer;
  if (dl && typeof dl.hide === 'object' && typeof dl.hide.end === 'function') {
    try { dl.hide.end(); } catch (e) {}
  }
})();
