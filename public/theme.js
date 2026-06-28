(function () {
  'use strict';
  var STORAGE_KEY = 'relativity-theme';
  var DEFAULT = 'light';

  function getTheme() {
    try { return localStorage.getItem(STORAGE_KEY) || DEFAULT; } catch (e) { return DEFAULT; }
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem(STORAGE_KEY, theme); } catch (e) {}
  }

  // Apply before first paint to prevent FOUC
  setTheme(getTheme());

  document.addEventListener('DOMContentLoaded', function () {
    document.querySelectorAll('.theme-toggle').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        setTheme(next);
        document.dispatchEvent(new CustomEvent('themechange'));
      });
    });
  });
})();
