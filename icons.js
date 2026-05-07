// icons.js — set d'icônes SVG stroke (style Lucide-like)
// Chaque icône est une string SVG complète, prête à injecter via innerHTML.
// Format commun : viewBox 24x24, stroke="currentColor", fill="none", stroke-width=2.
// Couleur et taille héritées du conteneur (currentColor + width/height = 1em).

const SVG_OPEN = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
const SVG_CLOSE = '</svg>';
const wrap = (body) => SVG_OPEN + body + SVG_CLOSE;

export const ICONS = {
  // ===== SITE ICONS =====
  beach:      wrap('<path d="M12 22V10"/><path d="M12 10c-3-2-7-2-9 1"/><path d="M12 10c3-2 7-2 9 1"/><path d="M12 10c0-3 2-6 6-6"/><path d="M12 10c0-3-2-6-6-6"/><path d="M3 22h18"/>'),
  mountain:   wrap('<path d="m3 20 6-10 4 6 3-4 5 8z"/>'),
  waves:      wrap('<path d="M2 8c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2"/><path d="M2 14c2 0 2 2 4 2s2-2 4-2 2 2 4 2 2-2 4-2 2 2 4 2"/>'),
  anchor:     wrap('<circle cx="12" cy="5" r="2.5"/><line x1="12" y1="7.5" x2="12" y2="22"/><line x1="6" y1="13" x2="18" y2="13"/><path d="M3 14a9 9 0 0 0 18 0"/>'),
  plane:      wrap('<path d="M21 12 13 4v6L3 14v2l10-2v6l-2 1v2l4-1 4 1v-2l-2-1v-6z"/>'),
  helicopter: wrap('<line x1="2" y1="5" x2="22" y2="5"/><line x1="12" y1="5" x2="12" y2="9"/><path d="M5 13a4 4 0 0 1 4-4h7l3 4v3H8z"/><line x1="3" y1="20" x2="21" y2="20"/><line x1="9" y1="16" x2="9" y2="20"/>'),
  takeoff:    wrap('<path d="M2 22h20"/><path d="M3 18 18 5l3 1-2 4-13 9z"/><line x1="9" y1="14" x2="6" y2="11"/>'),
  island:     wrap('<path d="M12 14V4"/><path d="M12 4c-2 0-4 1-4 3"/><path d="M12 4c2 0 4 1 4 3"/><path d="M3 18h18"/><path d="M5 22h14"/>'),
  tent:       wrap('<path d="M3 20 12 4l9 16z"/><line x1="12" y1="4" x2="12" y2="20"/>'),
  trees:      wrap('<path d="M7 14 4 19h6z"/><path d="M7 10 5 14h4z"/><path d="M7 6 5.5 9h3z"/><line x1="7" y1="14" x2="7" y2="22"/><path d="M17 17l-3 5h6z"/><path d="M17 12l-2 5h4z"/><path d="M17 7l-1.5 5h3z"/><line x1="17" y1="17" x2="17" y2="22"/>'),
  flag:       wrap('<line x1="5" y1="22" x2="5" y2="3"/><path d="M5 3h13l-3 4 3 4H5"/>'),
  stadium:    wrap('<ellipse cx="12" cy="12" rx="10" ry="5"/><path d="M2 12c0 3 4 5 10 5s10-2 10-5"/><line x1="6" y1="9" x2="6" y2="15"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="18" y1="9" x2="18" y2="15"/>'),
  ferris:     wrap('<circle cx="12" cy="11" r="8"/><circle cx="12" cy="11" r="1.5"/><line x1="12" y1="3" x2="12" y2="19"/><line x1="4" y1="11" x2="20" y2="11"/><line x1="6" y1="5" x2="18" y2="17"/><line x1="6" y1="17" x2="18" y2="5"/><path d="M6 22h12"/><line x1="9" y1="22" x2="12" y2="11"/><line x1="15" y1="22" x2="12" y2="11"/>'),
  cinema:     wrap('<rect x="2" y="6" width="20" height="14" rx="1"/><path d="M2 10h20"/><path d="M6 6 4 10"/><path d="M11 6 9 10"/><path d="M16 6 14 10"/><path d="M21 6 19 10"/>'),
  casino:     wrap('<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/><circle cx="12" cy="12" r="1"/>'),
  train:      wrap('<rect x="5" y="3" width="14" height="14" rx="2"/><line x1="5" y1="11" x2="19" y2="11"/><circle cx="9" cy="14" r="0.5"/><circle cx="15" cy="14" r="0.5"/><line x1="6" y1="20" x2="9" y2="17"/><line x1="18" y1="20" x2="15" y2="17"/>'),
  power:      wrap('<polygon points="13 2 4 14 11 14 9 22 20 10 13 10"/>'),
  oil:        wrap('<path d="M5 22V8a3 3 0 0 1 3-3h6a3 3 0 0 1 3 3v14"/><line x1="3" y1="22" x2="21" y2="22"/><path d="M5 12h10"/><path d="M17 9l3-2v5l-3-2"/>'),
  landmark:   wrap('<line x1="3" y1="22" x2="21" y2="22"/><path d="M3 10 12 4l9 6"/><line x1="6" y1="10" x2="6" y2="19"/><line x1="10" y1="10" x2="10" y2="19"/><line x1="14" y1="10" x2="14" y2="19"/><line x1="18" y1="10" x2="18" y2="19"/><line x1="3" y1="19" x2="21" y2="19"/>'),
  ship:       wrap('<path d="M2 16h20l-2 5H4z"/><path d="M5 16V9l7-4 7 4v7"/><line x1="12" y1="5" x2="12" y2="2"/>'),

  // ===== BUILDING ICONS =====
  home:       wrap('<path d="m3 11 9-8 9 8v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><polyline points="9 22 9 13 15 13 15 22"/>'),
  house:      wrap('<path d="M3 12 12 4l9 8"/><path d="M5 10v11h14V10"/><rect x="10" y="14" width="4" height="7"/>'),
  building:   wrap('<rect x="5" y="2" width="14" height="20" rx="1"/><line x1="9" y1="6" x2="11" y2="6"/><line x1="13" y1="6" x2="15" y2="6"/><line x1="9" y1="10" x2="11" y2="10"/><line x1="13" y1="10" x2="15" y2="10"/><line x1="9" y1="14" x2="11" y2="14"/><line x1="13" y1="14" x2="15" y2="14"/><path d="M10 22v-4h4v4"/>'),
  building2:  wrap('<path d="M3 22V8h8v14"/><path d="M11 22V4h10v18"/><line x1="6" y1="12" x2="8" y2="12"/><line x1="6" y1="16" x2="8" y2="16"/><line x1="14" y1="8" x2="16" y2="8"/><line x1="18" y1="8" x2="20" y2="8"/><line x1="14" y1="12" x2="16" y2="12"/><line x1="18" y1="12" x2="20" y2="12"/><line x1="14" y1="16" x2="16" y2="16"/><line x1="18" y1="16" x2="20" y2="16"/>'),
  hospital:   wrap('<rect x="4" y="4" width="16" height="16" rx="1"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>'),
  bank:       wrap('<path d="M3 10 12 4l9 6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="6" y1="10" x2="6" y2="18"/><line x1="10" y1="10" x2="10" y2="18"/><line x1="14" y1="10" x2="14" y2="18"/><line x1="18" y1="10" x2="18" y2="18"/><line x1="3" y1="18" x2="21" y2="18"/><line x1="2" y1="22" x2="22" y2="22"/>'),
  store:      wrap('<path d="M3 8 5 3h14l2 5"/><path d="M3 8v13h18V8"/><path d="M3 8c0 2 2 3 4 3s3-1 3-3c0 2 1 3 2 3s2-1 2-3c0 2 1 3 2 3s4-1 4-3"/><rect x="9" y="14" width="6" height="7"/>'),
  hotel:      wrap('<path d="M2 18V8h20v10"/><line x1="2" y1="22" x2="22" y2="22"/><path d="M5 12h6v3"/><circle cx="7" cy="11" r="1.5"/>'),
  castle:     wrap('<path d="M3 22V8l3 2V6l3 2V6l3 2V6l3 2V6l3 2v12z"/><line x1="3" y1="14" x2="21" y2="14"/><rect x="10" y="16" width="4" height="6"/>'),
  church:     wrap('<line x1="12" y1="2" x2="12" y2="6"/><line x1="10" y1="4" x2="14" y2="4"/><path d="M12 6 5 11v11h14V11z"/><rect x="10" y="14" width="4" height="8"/>'),
  police:     wrap('<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z"/><polygon points="12 8 13 11 16 11 13.5 13 14.5 16 12 14 9.5 16 10.5 13 8 11 11 11"/>'),
  shield:     wrap('<path d="M12 2 4 5v6c0 5 3.5 9 8 11 4.5-2 8-6 8-11V5z"/>'),
  flame:      wrap('<path d="M8.5 14a4 4 0 0 0 7 0c0-2-2-3-2-5 0-1 1-3 1-3s-2 1-4 4c-1-2 0-5 0-5s-4 4-4 8c0 1 1 1 2 1z"/>'),
  bunker:     wrap('<path d="M3 18a9 9 0 0 1 18 0z"/><line x1="2" y1="18" x2="22" y2="18"/><line x1="2" y1="22" x2="22" y2="22"/><line x1="9" y1="13" x2="9" y2="18"/><line x1="15" y1="13" x2="15" y2="18"/>'),
  package:    wrap('<path d="M3 7v10l9 5 9-5V7l-9-5z"/><path d="M3 7l9 5 9-5"/><line x1="12" y1="12" x2="12" y2="22"/><line x1="7.5" y1="4.5" x2="16.5" y2="9.5"/>'),
  factory:    wrap('<path d="M3 22V11l5 3V11l5 3V11l5 3V8h2v14z"/><line x1="3" y1="22" x2="22" y2="22"/><line x1="7" y1="18" x2="9" y2="18"/><line x1="11" y1="18" x2="13" y2="18"/><line x1="15" y1="18" x2="17" y2="18"/>'),
  parking:    wrap('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>'),
  fuel:       wrap('<line x1="3" y1="22" x2="14" y2="22"/><path d="M4 22V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v17"/><line x1="4" y1="11" x2="14" y2="11"/><path d="M14 8h2a2 2 0 0 1 2 2v6a2 2 0 0 0 2 2 1 1 0 0 0 1-1V9l-3-3"/>'),
  shower:     wrap('<line x1="4" y1="4" x2="11" y2="11"/><path d="M3 7a3 3 0 0 1 3-3"/><path d="M14 14a4 4 0 0 0-8 0c0 1 8 1 8 0z"/><line x1="8" y1="16" x2="7" y2="20"/><line x1="10" y1="16" x2="10" y2="20"/><line x1="12" y1="16" x2="13" y2="20"/>'),
  wrench:     wrap('<path d="M14 4a4 4 0 0 1 5 5l-1 1 3 3-3 3-3-3-7 7a3 3 0 0 1-4-4l7-7-3-3 3-3 3 3z"/>'),
  crosshair:  wrap('<circle cx="12" cy="12" r="9"/><line x1="12" y1="2" x2="12" y2="7"/><line x1="12" y1="17" x2="12" y2="22"/><line x1="2" y1="12" x2="7" y2="12"/><line x1="17" y1="12" x2="22" y2="12"/><circle cx="12" cy="12" r="1"/>'),
  target:     wrap('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2.5"/>'),
  shirt:      wrap('<path d="M9 3 4 6l2 4 2-1v12h8V9l2 1 2-4-5-3-2 2h-2z"/>'),
  scissors:   wrap('<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><line x1="20" y1="4" x2="8.12" y2="15.88"/><line x1="14.47" y1="14.48" x2="20" y2="20"/><line x1="8.12" y1="8.12" x2="12" y2="12"/>'),
  syringe:    wrap('<line x1="14" y1="3" x2="21" y2="10"/><line x1="17" y1="6" x2="13" y2="10"/><line x1="11" y1="8" x2="16" y2="13"/><line x1="9" y1="10" x2="14" y2="15"/><line x1="13" y1="14" x2="3" y2="24" transform="translate(0,-3)"/><line x1="6" y1="17" x2="11" y2="22"/>'),
  music:      wrap('<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>'),
  beer:       wrap('<path d="M5 7h11v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1z"/><path d="M16 9h2a3 3 0 0 1 0 6h-2"/><line x1="8" y1="11" x2="8" y2="17"/><line x1="11" y1="11" x2="11" y2="17"/><path d="M5 7c0-2 2-3 4-3 1-2 4-2 5 0 2 0 3 1 3 3"/>'),
  utensils:   wrap('<path d="M7 2v8a2 2 0 0 1-4 0V2"/><line x1="5" y1="2" x2="5" y2="22"/><path d="M19 2c-2 0-3 4-3 7s3 3 3 3v10"/>'),
  drama:      wrap('<path d="M3 8c0-2 2-3 5-3s4 1 4 3v3c0 3-2 5-4.5 5S3 14 3 11z"/><circle cx="6" cy="9" r="0.5"/><circle cx="9" cy="9" r="0.5"/><path d="M12 8c0-2 2-3 5-3s4 1 4 3v3c0 3-2 5-4.5 5S12 14 12 11z"/><circle cx="15" cy="9" r="0.5"/><circle cx="18" cy="9" r="0.5"/>'),
  cart:       wrap('<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l3 13h12l2-9H6"/>'),
};

// Helpers --------------------------------------------------------------------

// Rend une icône : si key est un id Lucide connu, renvoie le SVG ;
// sinon renvoie tel quel (compat emojis stockés dans les anciennes données).
export function renderIcon(key) {
  if (!key) return '';
  return ICONS[key] || key;
}

export const SITE_ICONS = [
  'beach','mountain','waves','anchor','plane','helicopter','takeoff','island','tent','trees',
  'flag','stadium','ferris','cinema','casino','train','power','oil','landmark','ship',
];

export const BUILDING_ICONS = [
  'home','house','building','building2','hospital','bank','store','hotel','castle','church',
  'police','shield','flame','bunker','package','factory','parking','fuel','shower','wrench',
  'crosshair','target','shirt','scissors','syringe','music','beer','utensils','drama','cart',
];
