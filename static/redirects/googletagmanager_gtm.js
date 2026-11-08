/* CleanFeed surrogate for Google Tag Manager: honors eventCallback so pages don't hang. */
(function () {
  'use strict';
  var w = window;
  var dl = w.dataLayer = w.dataLayer || [];
  var run = function (o) {
    if (o && typeof o.eventCallback === 'function') {
      try { setTimeout(o.eventCallback, 1); } catch (e) {}
    }
  };
  for (var i = 0; i < dl.length; i++) run(dl[i]);
  var push = dl.push;
  dl.push = function () {
    for (var j = 0; j < arguments.length; j++) run(arguments[j]);
    return push.apply(dl, arguments);
  };
  w.google_tag_manager = w.google_tag_manager || {};
})();
