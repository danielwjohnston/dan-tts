// Shared theme picker. Wires any <select class="theme-select"> and persists the choice.
(function () {
  var THEMES = [
    ['light', 'Default Light'], ['dark', 'Default Dark'],
    ['nord', 'Nord'], ['nord-light', 'Nord Light'],
    ['dracula', 'Dracula'], ['alucard', 'Alucard (Dracula Light)'],
    ['olive', 'Olive Garden Feast'], ['olive-dark', 'Olive Garden Feast Dark'],
    ['bauhaus', 'Bauhaus Lime Noir']
  ];
  // Themes with their own typeface: the font is fetched only when the theme is in use
  var FONTS = { bauhaus: 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap' };
  function loadFont(name) {
    var href = FONTS[name];
    if (!href || document.querySelector('link[href="' + href + '"]')) return;
    var l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href;
    (document.head || document.documentElement).appendChild(l);
  }
  var KEY = 'tts-theme';
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function apply(name) {
    if (!THEMES.some(function (t) { return t[0] === name; })) name = 'light';
    if (name === 'light') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', name);
    loadFont(name);
    try { localStorage.setItem(KEY, name); } catch (e) {}
    document.querySelectorAll('.theme-select').forEach(function (s) { s.value = name; });
  }
  var initial = stored() || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  apply(initial);
  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.theme-select').forEach(function (s) {
      s.innerHTML = THEMES.map(function (t) { return '<option value="' + t[0] + '">' + t[1] + '</option>'; }).join('');
      s.value = document.documentElement.getAttribute('data-theme') || 'light';
      s.onchange = function () { apply(s.value); };
    });
  });
})();
