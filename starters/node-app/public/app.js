/* The {{TITLE}} shell: plain JS, no framework. Reads /api/health and /api/modules, builds the
   module bar, and lets each module's page live at /<module>/ (static) with its API under
   /api/<module>/. Nothing here knows what a module does. */
(function () {
  'use strict';
  var api = function (u) { return fetch(u).then(function (r) { return r.json(); }); };
  api('/api/health').then(function (h) {
    document.getElementById('env').textContent = h.env;
    document.getElementById('health').textContent = '{{NAME}} ' + h.version + ' · ' + h.env + ' · up ' + h.uptimeSec + 's · ' + (h.modules.length ? h.modules.length + ' module' + (h.modules.length === 1 ? '' : 's') : 'no modules yet');
  }).catch(function () { document.getElementById('health').textContent = 'the server is not answering'; });
  api('/api/modules').then(function (r) {
    var nav = document.getElementById('nav');
    (r.modules || []).forEach(function (m) { var a = document.createElement('a'); a.href = '/' + m.name + '/'; a.textContent = m.label; nav.appendChild(a); });
  });
})();
