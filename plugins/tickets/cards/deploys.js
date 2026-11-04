/* Recent deploys - what reached the main branch, by day, and what each environment says it is running. Read from the
   project's own git by the plugin's scan (first-parent commits on the branch: a merge is a PR that landed, a plain
   commit a direct push), plus the optional version endpoints. In a merge-deploys-to-UAT setup a landing IS the UAT
   deploy; prod is whatever the prod endpoint reports, and the gap between the two is the deploy that is owed. Each
   landing names the tickets its message mentions; with the GitHub plugin on, a merge links to its pull request. */
(function () {
  'use strict';
  var K = function () { return window.TicketCards; };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  /* ONE INSTANCE PER DESK CARD (Home step 1): bound to its project through ctx, so this card can sit on another
     project's desk - Home's - and read that project. */
  function Deploys(ctx0) {
  var X = ctx0;
  var S = { rows: null, releases: [], envs: [], meta: {}, repo: '', loading: false, err: null, days: 14, at: null, scanning: false, stampSeen: null };
  /* THE OWNER'S DAY, NOT UTC's (the
     card was slicing the date off the timestamp, so anything after 8pm here filed under tomorrow). */
  function whenLocal(s) { if (!s) return ''; var t = new Date(s); return isNaN(t) ? String(s).slice(0, 16).replace('T', ' ') : t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function localDay(at) { var t = new Date(at); return isNaN(t) ? String(at).slice(0, 10) : new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 10); }
  function dayLabel(d) { var t = new Date(d + 'T12:00:00'); var today = localDay(new Date().toISOString()); var y = localDay(new Date(Date.now() - 864e5).toISOString());
    return d === today ? 'today' : d === y ? 'yesterday' : t.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }); }
  /* the tickets between two commits, read from the landings list (newest first) */
  function ticketsBetween(prev, sha) {
    var rows = S.rows || [], out = [], on = !sha;
    for (var i = 0; i < rows.length; i++) {
      var short = String(rows[i].short || rows[i].sha || '').slice(0, 7);
      if (!on && short === String(sha).slice(0, 7)) on = true;
      if (!on) continue;
      if (prev && short === String(prev).slice(0, 7)) break;
      var tk = []; try { tk = JSON.parse(rows[i].tickets || '[]'); } catch (e) { tk = []; }
      tk.forEach(function (t) { if (out.indexOf(t) < 0) out.push(t); });
      if (out.length > 40) break;
    }
    return out;
  }
  function load() {
    if (S.loading) return; S.loading = true;
    var k = K();
    Promise.all([k.q('deploys', null, X), k.q('envs', null, X), k.q('meta', null, X), k.q('releases', null, X).catch(function () { return []; }), k.ghOn(X) ? k.ghq('meta', null, X).catch(function () { return []; }) : Promise.resolve([])]).then(function (r) {
      S.rows = r[0]; S.envs = r[1]; S.meta = {}; r[2].forEach(function (m) { S.meta[m.key] = m.value; });
      S.releases = r[3] || [];   // the deploys themselves - every time an environment began serving a different commit
      var gm = {}; (r[4] || []).forEach(function (m) { gm[m.key] = m.value; }); S.repo = gm.repo || '';
      S.err = null;
    }).catch(function (e) { S.rows = []; S.err = e.message; }).then(function () {
      S.loading = false; Layout.refresh(); });
  }
  function ver(v) { try { var j = JSON.parse(v); return j.version || j.sha || j.commit || j.gitSha || j.build || JSON.stringify(j).slice(0, 60); } catch (e) { return String(v || '').slice(0, 60); } }
    function render(el) {
      if (!K() || !K().on(X)) { if (K()) K().notOn(el, X); return; }
      var pl = window.PluginUI && window.PluginUI.info('tickets');
      var hd = el.parentElement && el.parentElement.querySelector('.ch .more');
      if (hd) {
        hd.innerHTML = '<span class="tkx" title="read the repository now" data-h="rescan">↻</span>';
        var rb = hd.querySelector('[data-h="rescan"]'); if (rb) rb.onclick = function () { S.scanning = true; Layout.refresh(); window.PluginUI.scan('tickets', function () { S.scanning = false; S.rows = null; S.err = null; Layout.refresh(); }); };
      }
      var stamp = ((pl && pl.lastScan) || {}).finished || ''; if (S.stampSeen !== stamp) { S.stampSeen = stamp; S.rows = null; S.err = null; }   // a read finished: show it
      if (S.scanning) { el.innerHTML = '<div class="muted small">reading the repository…</div>'; return; }
      var rv = X.room && X.room.version; if (S.err && S.at !== rv) { S.rows = null; S.err = null; }   // an error is not forever: the next room change retries
      S.at = rv;
      if (!S.rows) { load(); el.innerHTML = '<div class="muted small">reading…</div>'; return; }
      if (S.err) { el.innerHTML = '<div class="small dim">' + esc(S.err) + ' - <a href="#" id="tkd-retry">try again</a></div>'; el.querySelector('#tkd-retry').addEventListener('click', function (e) { e.preventDefault(); S.rows = null; S.err = null; load(); }); return; }
      var h = '';
      if (!S.meta.scannedAt) { el.innerHTML = '<div class="muted small">the repository has not been read yet' + (pl && pl.lastScan && !pl.lastScan.ok ? ' - the last read failed: ' + esc(pl.lastScan.note || '') : ' - it will be within a minute, or press ↻') + '</div>'; return; }
      if (S.meta.gitNote) h += '<div class="small dim" style="margin-bottom:6px">' + esc(S.meta.gitNote) + ' - Cockpit reads what reached the branch from git; without one there is nothing to show</div>';
      /* what each environment is SERVING, and when Cockpit last looked - never when it deployed (this line said "1fc108d today", which was the reading, and prod had not moved
         since 17 September). The deploys themselves are the section below. */
      if (S.envs.length) h += '<div class="kv" style="margin-bottom:8px">' + S.envs.map(function (e) { return '<b>' + esc(e.env) + '</b><span' + (e.ok ? '' : ' class="dim"') + '>' + (e.ok ? '<code>' + esc(ver(e.version)) + '</code>' : 'unreachable: ' + esc(e.note || '')) + ' <span class="dim small">read ' + K().ago(e.at) + '</span></span>'; }).join('') + '</div>';
      else if (!S.meta.gitNote) h += '<div class="small dim" style="margin-bottom:6px">no version endpoints in the plugin\'s settings - only what reached <b>' + esc(S.meta.branch || 'the branch') + '</b> is shown</div>';
      /* WHAT ACTUALLY SHIPPED, PER ENVIRONMENT.
         A release is a moment an environment started serving a different commit; under it, the tickets that arrived with it -
         the landings between what it served before and what it serves now. Landings that have not reached an environment are
         below, under their own heading, so "merged" is never read as "shipped". */
      var rel = (S.releases || []).slice(0, 12);
      if (rel.length) {
        h += '<div class="small" style="margin:2px 0 4px"><b>deployed</b> <span class="dim">- when an environment started serving something new</span></div>';
        rel.forEach(function (r) {
          var arrived = ticketsBetween(r.prev, r.sha);
          h += '<div class="dep"><span class="ok">\u2191</span><span><b>' + esc(r.env) + '</b> <code>' + esc(String(r.sha).slice(0, 7)) + '</code> <span class="dim">' + esc(whenLocal(r.at)) + '</span>'
            + (arrived.length ? ' <span class="small">' + arrived.slice(0, 8).map(function (t) { return esc(t); }).join(' ') + (arrived.length > 8 ? ' +' + (arrived.length - 8) : '') + '</span>' : '')
            + (r.prev ? ' <span class="dim small">was ' + esc(String(r.prev).slice(0, 7)) + '</span>' : '') + '</span></div>';
        });
      } else if (S.envs.length) {
        h += '<div class="small dim" style="margin:2px 0 6px">no deploy seen yet - Cockpit records one when an environment starts serving a different commit; it reads them on every scan</div>';
      }
      h += '<div class="small" style="margin:8px 0 2px"><b>landed on ' + esc(S.meta.branch || 'the branch') + '</b> <span class="dim">- merged, not necessarily deployed</span></div>';
      var cut = Date.now() - S.days * 864e5, byDay = {}, order = [];
      S.rows.forEach(function (c) { if (Date.parse(c.at) < cut) return; var d = localDay(c.at); if (!byDay[d]) { byDay[d] = []; order.push(d); } byDay[d].push(c); });
      if (!order.length && !S.meta.gitNote) h += '<div class="muted small">nothing reached ' + esc(S.meta.branch || 'the branch') + ' in ' + S.days + ' days</div>';
      order.forEach(function (d) {
        h += '<div class="small" style="margin:6px 0 2px"><b>' + esc(dayLabel(d)) + '</b> <span class="dim">' + byDay[d].length + ' landed</span></div>';
        byDay[d].forEach(function (c) { var tk = []; try { tk = JSON.parse(c.tickets); } catch (e) { /* */ }
          var subject = c.subject.replace(/\s*\(#\d+\)\s*$/, '');
          h += '<div class="dep"><span class="ok">' + (c.merge || c.pr ? '⇄' : '✓') + '</span><span>' + (c.pr && S.repo ? '<a href="https://github.com/' + esc(S.repo) + '/pull/' + c.pr + '" target="_blank">#' + c.pr + '</a> ' : '') + esc(subject) + ' <span class="dim small">' + esc(c.author || '') + ' · <code>' + esc(c.short) + '</code>' + (tk.length ? ' · ' + tk.map(function (n) { return '<a href="#" data-t="' + esc(n) + '">' + esc(n) + '</a>'; }).join(' ') : '') + '</span></span></div>';
        });
      });
      h += '<div class="small dim" style="margin-top:6px"><a href="#" id="tkd-more">' + (S.days >= 45 ? 'last 14 days' : 'last 45 days') + '</a> · ' + esc(S.meta.branch || '') + ' · read ' + K().ago(S.meta.scannedAt) + '</div>';
      if (!Layout.paint(el, h)) return;
      setTimeout(function () { Layout.snug(X.key); }, 0);   // as wide as its column, as tall as its list
      el.querySelectorAll('a[data-t]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); var n = a.dataset.t; K().rows(false, X).then(function (rows) { var r = rows.find(function (x) { return x.id === n || (x.number && '#' + x.number === n); }); K().openTicket(r ? r.id : n.replace(/^#/, ''), X); }); }); });
      el.querySelector('#tkd-more').addEventListener('click', function (e) { e.preventDefault(); S.days = S.days >= 45 ? 14 : 45; Layout.refresh(); });
    }
    return { render: render, use: function (c) { X = c; }, poke: function () { if (S.rows) { S.rows = null; load(); } } };
  }
  var INST = {};
  function inst(ctx) { ctx = ctx || (Layout.ctx ? Layout.ctx('tk-deploys') : null); var I = INST[ctx.key]; if (!I) I = INST[ctx.key] = Deploys(ctx); I.use(ctx); return I; }
  Layout.register({ id: 'tk-deploys', plugin: 'tickets', icon: '🚀', title: 'Recent deploys', purpose: 'what reached the main branch, by day, and what each environment reports running', zone: 'right', pos: 4, size: [6, 14], min: [4, 6], max: [12, 40], multi: true,
    render: function (el, density, size, ctx) { inst(ctx).render(el); } });
  setInterval(function () { if (window.ROOM) Object.keys(INST).forEach(function (k) { INST[k].poke(); }); }, 120000);
})();
