(function () {
  const iconShapes = {
    'layout-dashboard': '<rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/>',
    'file-spreadsheet': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M12 11v8"/>',
    'scan-search': '<path d="M3 7V5a2 2 0 0 1 2-2h2m10 0h2a2 2 0 0 1 2 2v2M3 17v2a2 2 0 0 0 2 2h2m10 0h2a2 2 0 0 0 2-2v-2"/><circle cx="11" cy="11" r="3"/><path d="m20 20-2.5-2.5"/>',
    'spell-check-2': '<path d="m6 16 6-12 6 12M8 12h8M3 20h18M16 19l2 2 4-4"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5m4-1v5l3 2"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    'chart-no-axes-column-increasing': '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
    'settings-2': '<path d="M20 7h-9m-4 0H4m16 10h-5m-4 0H4"/><circle cx="9" cy="7" r="2"/><circle cx="13" cy="17" r="2"/>',
    'shield-check': '<path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11"/><path d="m9 12 2 2 4-4"/>',
    'log-out': '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    'chevron-right': '<path d="m9 18 6-6-6-6"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    files: '<path d="M15 2H6a2 2 0 0 0-2 2v14"/><path d="M18 6H9a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2Z"/><path d="M11 11h5m-5 4h5"/>',
    'rows-3': '<rect x="3" y="4" width="18" height="5" rx="1"/><rect x="3" y="11" width="18" height="5" rx="1"/><rect x="3" y="18" width="18" height="2" rx="1"/>',
    'columns-3': '<rect x="4" y="3" width="5" height="18" rx="1"/><rect x="11" y="3" width="5" height="18" rx="1"/><rect x="18" y="3" width="2" height="18" rx="1"/>',
    sparkles: '<path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3ZM19 14l1.2 2.8L23 18l-2.8 1.2L19 22l-1.2-2.8L15 18l2.8-1.2L19 14ZM5 2l1 2 2 1-2 1-1 2-1-2-2-1 2-1 1-2Z"/>',
    'arrow-up-right': '<path d="M7 17 17 7M7 7h10v10"/>',
    'circle-check': '<circle cx="12" cy="12" r="10"/><path d="m8 12 2.5 2.5L16 9"/>',
    'circle-x': '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/>',
    'clock-3': '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    'refresh-cw': '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.6 9a7 7 0 0 1 11.6-2L20 12M4 12l2.8 5a7 7 0 0 0 11.6-2"/>',
    'file-up': '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M12 18v-6m-3 3 3-3 3 3"/>',
    'arrow-right': '<path d="M5 12h14m-7-7 7 7-7 7"/>',
    'cloud-upload': '<path d="M20 16.2A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 16.3"/><path d="M12 12v9m-4-5 4-4 4 4"/>',
    'lock-keyhole': '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4m-5 5v2"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5m5-5v12"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    'table-2': '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18m6-18v18"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/>',
    'arrow-left': '<path d="M19 12H5m7 7-7-7 7-7"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    'circle-alert': '<circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/>',
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off': '<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.7 10.7 0 0 1 12 5c6.4 0 10 7 10 7a14 14 0 0 1-3 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7a10.7 10.7 0 0 0 3-.4"/>',
    'table-properties': '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18"/><path d="m13 12 1.5 1.5L18 10"/>',
    'loader-circle': '<path d="M21 12a9 9 0 1 1-6.2-8.6"/>',
    'copy-check': '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3m5-2 2 2 4-4"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3.1 5.2 2 2 0 0 1 5.1 3h3a2 2 0 0 1 2 1.7l.5 2.8a2 2 0 0 1-.6 1.8L8.1 11a16 16 0 0 0 4.9 4.9l1.7-1.9a2 2 0 0 1 1.8-.6l2.8.5a2 2 0 0 1 1.7 2Z"/>',
    'map-pin': '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
    'globe-2': '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
    'list-checks': '<path d="m3 6 2 2 4-4m-6 10 2 2 4-4M13 6h8m-8 8h8m-8 6h8"/>'
  };

  function renderIcon(element) {
    const paths = iconShapes[element.getAttribute('data-lucide')];
    if (!paths) return;
    element.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  }
  window.ClearSheetIcons = { renderIcon };
  document.querySelectorAll('[data-lucide]').forEach(renderIcon);

  const appLayout = document.querySelector('.app-layout');
  const menuToggle = document.querySelector('[data-menu-toggle]');
  const menuClose = document.querySelector('[data-menu-close]');
  if (appLayout && menuToggle) {
    menuToggle.addEventListener('click', () => appLayout.classList.toggle('menu-open'));
    if (menuClose) menuClose.addEventListener('click', () => appLayout.classList.remove('menu-open'));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') appLayout.classList.remove('menu-open');
    });
  }

  const pollingWorkspace = document.querySelector('[data-profile-polling="true"]');
  if (pollingWorkspace) window.setTimeout(() => window.location.reload(), 3000);
})();