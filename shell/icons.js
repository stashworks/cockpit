/* Line icons for the shell (the shelf shows an icon, not the card's name, "and better icons than
   what we are using now"). 24-unit stroke paths in the style of the mock's rails; a card is looked up by its type id,
   with its emoji as the fallback so a plugin's new card still has a face. */
(function () {
  'use strict';
  var P = {
    conversation: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M16 13H8M16 17H8M10 9H8',
    files: 'M3 7V5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2M3 7h18v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM7 12h4M7 15h7',
    fleet: 'M12 8V4H8M4 8h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM2 14h2M20 14h2M15 13v2M9 13v2',
    performance: 'M22 12h-4l-3 9L9 3l-3 9H2',
    project: 'M12 20V10M18 20V4M6 20v-4M3 20h18',
    backups: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M14 7h4M14 17h4',
    'home-greeting': 'M12 2v6M4.9 10.9l1.4 1.4M2 18h2M20 18h2M19.1 10.9l-1.4 1.4M22 22H2M8 6l4-4 4 4M16 18a4 4 0 0 0-8 0',
    'home-projects': 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
    'home-alerts': 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
    alerts: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
    'tk-attention': 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 8v4M12 16h.01',
    tickets: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM9 3v18M15 3v12',
    'tk-deploys': 'M4.5 16.5c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.2 2.2 0 0 0-2.9-.1zM12 15l-3-3a22 22 0 0 1 2-4A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22 22 0 0 1-4 2zM9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5',
    'tk-pipeline': 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
    architecture: 'M3 21h18M5 21V7l7-4 7 4v14M9 21v-6h6v6M9 10h.01M15 10h.01',
    database: 'M12 8c5 0 9-1.3 9-3s-4-3-9-3-9 1.3-9 3 4 3 9 3zM3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3',
    tests: 'M9 3h6M10 3v6l-5.5 9A2 2 0 0 0 6.2 21h11.6a2 2 0 0 0 1.7-3L14 9V3',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    // the two cards that fell back to their coloured emoji did not match the look and feel of the others
    notes: 'M6 4h12a1 1 0 0 1 1 1v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM9 2v4M15 2v4M8.5 11h7M8.5 15h7M8.5 19h4',
    'events-log': 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
    views: 'M3 4h18v16H3zM3 9h18M3 14h18M9 9v11',
    card: 'M3 5h18v14H3zM3 9h18'
  };
  /* THEMES: the same drawings in a different hand.
     A theme is how a path is drawn; 'emoji' is the face the card registered with. */
  var THEMES = {
    hand: { name: 'Hand drawn', what: 'the line icons as drawn - round, light', width: 1.8, cap: 'round' },
    bold: { name: 'Bold', what: 'the same lines, heavier', width: 2.6, cap: 'round' },
    thin: { name: 'Fine', what: 'the same lines, hairline', width: 1.15, cap: 'round' },
    duotone: { name: 'Duotone', what: 'the lines over a tinted fill', width: 1.6, cap: 'round', fill: 'currentColor', fillOpacity: .18 },
    square: { name: 'Square', what: 'the same lines with square ends', width: 1.8, cap: 'square' },
    emoji: { name: 'Emoji', what: 'the coloured pictures the cards came with' }
  };
  /* the person's choice: the theme for every card, and per card an icon (any drawing, or an emoji) and optionally its own theme.
     Kept on Home (person "icons"), so it is one choice across every project. */
  var CFG = { theme: 'hand', per: {} };
  function svg(name, size, theme) {
    var d = P[name]; if (!d) return '';
    var t = THEMES[theme] || THEMES[CFG.theme] || THEMES.hand; if (!t.width) t = THEMES.hand;
    return '<svg class="ico" width="' + (size || 20) + '" height="' + (size || 20) + '" viewBox="0 0 24 24" fill="' + (t.fill || 'none') + '"' + (t.fillOpacity ? ' fill-opacity="' + t.fillOpacity + '"' : '') + ' stroke="currentColor" stroke-width="' + t.width + '" stroke-linecap="' + t.cap + '" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
  }
  function emoji(ch) { return '<span class="ico ico-emoji">' + ch + '</span>'; }
  /* a card type's icon: the person's pick for it, else the theme's drawing of it, else the emoji it registered with, else a plain card */
  function of(card, size) {
    if (!card) return svg('card', size);
    var o = CFG.per[card.id];
    if (o && o.emoji) return emoji(o.emoji);
    var theme = (o && o.theme) || CFG.theme, name = (o && o.icon) || card.id;
    if (theme === 'emoji' && !(o && o.icon)) return card.icon ? emoji(card.icon) : svg(name, size, 'hand');
    return svg(name, size, theme === 'emoji' ? 'hand' : theme) || (card.icon ? emoji(card.icon) : svg('card', size, theme));
  }
  function load() { return fetch('/api/p/home/layout?person=icons').then(function (r) { return r.json(); }).then(function (c) { if (c && typeof c === 'object' && c.per) CFG = { theme: THEMES[c.theme] ? c.theme : 'hand', per: c.per || {} }; }).catch(function () { /* the defaults */ }); }
  function save() { return fetch('/api/p/home/layout?person=icons', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(CFG) }); }
  /* the faces already on screen follow a change at once: every card header, the shelves, the picker */
  function refresh() {
    document.querySelectorAll('.card[data-type] .ch h3 .h-ico').forEach(function (h) { var el = h.closest('.card'), c = window.Layout && Layout.state.cards[el.dataset.type]; if (c) h.innerHTML = of(c, 14); });
    if (window.Layout && Layout.place) Layout.place();
  }
  window.Icons = { svg: svg, of: of, has: function (n) { return !!P[n]; }, paths: P, themes: THEMES, cfg: function () { return CFG; },
    setTheme: function (t) { if (THEMES[t]) CFG.theme = t; refresh(); return save(); },
    setCard: function (id, o) { if (!o || (!o.icon && !o.emoji && !o.theme)) delete CFG.per[id]; else CFG.per[id] = o; refresh(); return save(); },
    load: load, refresh: refresh };
})();
