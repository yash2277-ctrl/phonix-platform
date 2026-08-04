/* ═══════════════════════════════════════════════════════════════
   PHØNIX — shared theme controller
   Load this in <head> (blocking) so the correct theme is applied
   before first paint. Without that you get a white flash on every
   navigation, which is far worse than the few ms it costs.

   Swiss dark mode is a strict inversion: white↔black. The red
   accent is held constant because it is a functional signal,
   not decoration.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  var KEY = 'phonix_theme';

  function systemPrefersDark() {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /** Resolve the theme to use: explicit choice wins, otherwise follow the OS. */
  function resolve() {
    var saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) { /* private mode */ }
    if (saved === 'dark' || saved === 'light') return saved;
    return systemPrefersDark() ? 'dark' : 'light';
  }

  /** Apply to <html> immediately (body may not exist yet at head-time). */
  function apply(theme, persist) {
    var dark = theme === 'dark';
    var root = document.documentElement;
    root.classList.toggle('dark', dark);
    root.classList.toggle('light', !dark);

    if (document.body) {
      document.body.classList.toggle('dark', dark);
      document.body.classList.toggle('light', !dark);
    }

    // Match the browser chrome (address bar on mobile) to the page.
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#000000' : '#FFFFFF');

    if (persist) { try { localStorage.setItem(KEY, theme); } catch (e) {} }
    updateToggles(dark);
    return theme;
  }

  /** Swap every toggle's icon to show the action, not the state. */
  function updateToggles(dark) {
    var icon = dark ? 'sun' : 'moon';
    document.querySelectorAll('[data-theme-toggle]').forEach(function (btn) {
      var use = btn.querySelector('use');
      if (use) use.setAttribute('href', '#i-' + icon);
      btn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      btn.setAttribute('title', dark ? 'Light mode' : 'Dark mode');
    });
    var sel = document.getElementById('settingsTheme');
    if (sel) sel.value = dark ? 'dark' : 'light';
  }

  var current = apply(resolve(), false);

  // Body doesn't exist during head execution — mirror the classes once it does.
  document.addEventListener('DOMContentLoaded', function () {
    apply(current, false);
  });

  // Follow the OS live, but only while the user hasn't chosen explicitly.
  if (window.matchMedia) {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var onChange = function (e) {
      var saved = null;
      try { saved = localStorage.getItem(KEY); } catch (err) {}
      if (!saved) current = apply(e.matches ? 'dark' : 'light', false);
    };
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
  }

  // Keep tabs in sync.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY && e.newValue) current = apply(e.newValue, false);
  });

  window.PhonixTheme = {
    get: function () { return current; },
    set: function (t) { return (current = apply(t, true)); },
    toggle: function () { return (current = apply(current === 'dark' ? 'light' : 'dark', true)); }
  };
})();
