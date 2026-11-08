/* CleanFeed surrogate for the AMP runtime: un-hides the body AMP keeps invisible until it loads. */
(function () {
  'use strict';
  var head = document.head;
  if (!head) return;
  var style = document.querySelector('style[amp-boilerplate]');
  if (style) style.remove();
  var s = document.createElement('style');
  s.textContent = 'body{animation:none!important;opacity:1!important;visibility:visible!important}';
  head.appendChild(s);
})();
