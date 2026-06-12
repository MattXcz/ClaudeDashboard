/* Custom SVG icon set for Claude Dashboard — all hand-drawn, stroke-based. */
(function () {
  const S = (inner, vb = '0 0 24 24') =>
    `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

  window.ICONS = {
    chat: S('<path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/><circle cx="9" cy="12" r=".8" fill="currentColor"/><circle cx="13" cy="12" r=".8" fill="currentColor"/><circle cx="17" cy="12" r=".8" fill="currentColor"/>'),
    usage: S('<path d="M3 20h18"/><rect x="5" y="11" width="3" height="6" rx="1"/><rect x="10.5" y="6" width="3" height="11" rx="1"/><rect x="16" y="9" width="3" height="8" rx="1"/>'),
    sessions: S('<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>'),
    agents: S('<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="18" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M10.8 7l-4 8.5M13.2 7l4 8.5M7.5 18h9"/>'),
    tools: S('<path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.6L3 17.6V21h3.4l5.7-5.7a4.5 4.5 0 0 0 5.6-6L14.5 12.5l-3-3z"/>'),
    skills: S('<path d="M12 2l2.4 5.3L20 8l-4 4.2 1 5.8-5-2.8-5 2.8 1-5.8L4 8l5.6-.7z"/>'),
    prompts: S('<path d="M4 5h16M4 12h10M4 19h7"/><path d="M19 16l2 2-2 2"/>'),
    feed: S('<path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1.6" fill="currentColor" stroke="none"/>'),
    send: S('<path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/>'),
    pulse: S('<path d="M3 12h4l2.5-7 5 14L17 12h4"/>'),
    token: S('<circle cx="12" cy="12" r="8"/><path d="M9.5 9.5h5M12 9.5V16"/>'),
    cost: S('<circle cx="12" cy="12" r="9"/><path d="M12 6.5v11M15 8.7c-.7-1-1.7-1.4-3-1.4-1.6 0-2.8.8-2.8 2.2 0 2.9 6 1.6 6 4.6 0 1.5-1.3 2.3-3.2 2.3-1.5 0-2.6-.6-3.2-1.6"/>'),
    msg: S('<path d="M4 6h16v10H8l-4 4z"/>'),
    clock: S('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>'),
    bot: S('<rect x="5" y="8" width="14" height="10" rx="3"/><path d="M12 8V4M9 4h6"/><circle cx="9.5" cy="13" r="1" fill="currentColor" stroke="none"/><circle cx="14.5" cy="13" r="1" fill="currentColor" stroke="none"/>'),
    user: S('<circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 5-5.5 8-5.5s6.5 1.5 8 5.5"/>'),
    folder: S('<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    branch: S('<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 7.2v9.6M18 11.2c0 3-3 4-7 4"/>'),
    error: S('<circle cx="12" cy="12" r="9"/><path d="M12 7.5V13M12 16.5h.01"/>'),
    check: S('<path d="M4 12.5l5 5L20 6.5"/>'),
    spark: S('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>'),
    think: S('<path d="M9 18h6M10 21h4"/><path d="M12 3a6.5 6.5 0 0 1 3.8 11.8c-.8.6-.8 1.2-.8 2.2h-6c0-1-.0-1.6-.8-2.2A6.5 6.5 0 0 1 12 3z"/>'),
  };

  /* Claude-ish starburst logo */
  window.LOGO = (size = 22) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none">
      <g stroke="url(#lg)" stroke-width="2.6" stroke-linecap="round">
        <defs><linearGradient id="lg" x1="0" y1="0" x2="32" y2="32">
          <stop offset="0" stop-color="#ff9d6e"/><stop offset="1" stop-color="#e0633c"/>
        </linearGradient></defs>
        <path d="M16 4v6M16 22v6M4 16h6M22 16h6M7.5 7.5l4.2 4.2M20.3 20.3l4.2 4.2M7.5 24.5l4.2-4.2M20.3 11.7l4.2-4.2"/>
      </g></svg>`;

  window.icon = (name) => (window.ICONS[name] || '');
  window.mountIcons = (root = document) => {
    root.querySelectorAll('.ic[data-ic]').forEach((el) => {
      if (!el.innerHTML) el.innerHTML = icon(el.dataset.ic);
    });
  };
})();
