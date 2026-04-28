// app.js — CadoCreator
import {
  escapeHtml, escapeAttr,
  findPhotoSiblings as _findPhotoSiblings,
  makeSiteMarkerIcon,
  makeBuildingMarkerIcon as _makeBuildingMarkerIcon,
  drawPlanCanvas as _drawPlanCanvas,
  getActivePlan as _getActivePlan,
  updateGalleryNav as _updateGalleryNav,
} from './shared.js';

// ===== CACHE (IndexedDB — pas de limite de taille) =====
const DB_NAME  = 'cadocreator';
const DB_STORE = 'state';
let _db        = null;
let _saveTimer = null;

async function _openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(DB_STORE);
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

function scheduleCacheSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveCacheNow, 1500);
}

async function saveCacheNow() {
  if (!state.sites.length) return;
  try {
    const db = await _openDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(JSON.stringify(state.sites), 'sites');
  } catch (e) {}
}

async function clearCacheState() {
  clearTimeout(_saveTimer);
  try {
    const db = await _openDB();
    db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete('sites');
  } catch (e) {}
}

async function checkCacheRestore() {
  try {
    const db  = await _openDB();
    const raw = await new Promise(resolve => {
      const req = db.transaction(DB_STORE, 'readonly').objectStore(DB_STORE).get('sites');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror   = () => resolve(null);
    });
    if (!raw) return;
    const sites = JSON.parse(raw);
    if (!Array.isArray(sites) || !sites.length) return;
    const names = sites.map(s => s.name || 'Sans nom').join(', ');
    if (!confirm(`Session non sauvegardée (${sites.length} site(s) : ${names}).\nRestaurer ?`)) {
      clearCacheState(); return;
    }
    sites.forEach(data => {
      data.photos      = data.photos      || [];
      data.buildings   = data.buildings   || [];
      data.sitePlans   = data.sitePlans   || [];
      data.perimeter   = data.perimeter   || null;
      data.accessArrow = data.accessArrow || null;
      if (state.sites.find(s => s.id === data.id)) return;
      state.sites.push(data);
      addSiteMarker(data);
      if (data.perimeter)   renderSitePerimeter(data);
      if (data.accessArrow) renderAccessArrow(data);
    });
    if (sites.length) selectSite(sites[0].id);
    updateTopBarButtons();
  } catch (e) {}
}

// ===== STATE =====
let state = {
  sites: [],
  activeSiteId: null,
  activeBuildingId: null,   // building currently open in plan view
  activeFloorId: null,       // floor within that building
  activeSitePlanId: null,    // site plan currently open
  activePhotoId: null,
  viewMode: 'map',           // 'map' | 'plan'
};

// ===== MAP =====
let map = null;
let siteMarkers     = {};   // siteId      -> L.Marker
let buildingMarkers = {};   // buildingId  -> L.Marker
let photoMarkers    = {};   // photoId     -> L.Marker
let searchResultMarker = null;
let perimeterLayer  = null; // L.Polygon for active site perimeter
let accessArrowMarker = null;

// ===== INTERACTION MODE =====
// 'perimeter-draw' | 'access-arrow' | 'move-photo' | 'orient-photo' | 'move-building' | 'move-site' | null
let interactionMode  = null;
let interactionSiteId = null;
let movePhotoId      = null;
let orientPhotoId    = null;
let moveBuildingId   = null;
let moveSiteId       = null;
let perimeterPoints  = [];
let perimeterPolyline = null;
let orientLine       = null; // L.Polyline preview

// ===== FLOOR PLAN =====
let plan = { img: null, scale: 1, offsetX: 0, offsetY: 0, dragging: false, dragStart: null };

// ===== PANNELLUM =====
let pannellumViewer = null;

// ===== VIEWER GALLERY =====
let viewerGallery    = [];  // photoIds at current point
let viewerGalleryIdx = 0;

// ===== PENDING LOAD / NAVIGATION =====
let pendingLoadFile    = null; // fichier à charger après fermeture du site courant
let pendingNavigateUrl = null; // URL vers laquelle naviguer après fermeture du site courant

// ===== PHOTO ADDITION =====
let pendingPhotoType  = null;
let pendingPhotoPos   = null;
let pendingPhotoFiles = [];   // File[] sélectionnés / glissés

// ===== PLAN PHOTO MOVE =====
let planMoveGhostPos     = null; // {planX, planY, buildingId, floorId, sitePlanId}
let movePlanPhotoSiblings = [];  // photo objects being moved together
let movePlanPhotoCleanup  = null;

// ===== SITE FORM TEMP =====
let sfEditingId = null;
let sfTempContacts = [];
let sfTempIcon = '🏛';
let sfTempIllustration = undefined;

// ===== BUILDING FORM TEMP =====
let bfTempLat = null;
let bfTempLon = null;
let bfTempIcon = '🏢';

// ===== FLOOR FORM TEMP (adding floor to existing building) =====
let addFloorBuildingId = null;

// ===== SEARCH =====
let searchTimer = null;

// ===== STEP PROMPT QUEUE =====
let stepQueue = [];

// ===== CONSTANTS =====
// Typologies de sites (zones d'intervention)
const SITE_ICONS = [
  '🏘', // Zone résidentielle pavillonnaire
  '🏙', // Zone urbaine dense
  '🏭', // Zone industrielle / ZI
  '🏬', // Zone commerciale / centre commercial
  '🏥', // Site hospitalier / sanitaire
  '🏫', // Campus scolaire / universitaire
  '🌾', // Zone agricole / rurale
  '🌲', // Zone boisée / forêt
  '🏛', // Centre historique / patrimoine
  '🚂', // Gare / infrastructure ferroviaire
  '✈', // Aéroport / aérodrome
  '⚓', // Port / zone portuaire
  '🏖', // Zone littorale / plage
  '🏔', // Zone montagneuse
  '🌊', // Zone inondable / bord de rivière
  '⚡', // Site industriel à risque (SEVESO)
  '🎡', // Parc de loisirs / attraction
  '🏟', // Enceinte sportive
  '🏕', // Camping / aire de loisirs
  '🔥', // Site sinistré / zone d'intervention
];

// Typologies de bâtiments (nomenclature SDIS / pompiers)
const BUILDING_ICONS = [
  '🏠', // Maison individuelle
  '🏡', // Maison avec jardin / villa
  '🏘', // Lotissement / habitat groupé
  '🏢', // Immeuble collectif / tour résidentielle
  '🏗', // Chantier / construction en cours
  '🏫', // École / collège / lycée / université
  '🏥', // Hôpital / clinique / EHPAD
  '🏨', // Hôtel / hébergement touristique
  '🏪', // Commerce / boutique de proximité
  '🏬', // Centre commercial / grande surface
  '🏦', // Banque / administration financière
  '🏤', // Administration publique / mairie
  '🏭', // Usine / industrie / ICPE
  '📦', // Entrepôt / stockage / logistique
  '🌾', // Ferme / exploitation agricole
  '🏟', // Stade / arène / enceinte sportive
  '🎭', // Théâtre / salle de spectacle / cinéma
  '🎪', // Salle polyvalente / chapiteau / MJC
  '⛪', // Église / temple protestant
  '🕌', // Mosquée
  '🛕', // Temple / pagode / lieu de culte
  '🕍', // Synagogue
  '🏛', // Musée / patrimoine / monument historique
  '🏰', // Château / site historique classé
  '🚒', // Caserne de pompiers / SDIS
  '⛽', // Station-service / dépôt carburant
  '🅿', // Parking / garage / parc de stationnement
];

// ===== HELPERS =====
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getActiveSite() {
  return state.sites.find(s => s.id === state.activeSiteId) || null;
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
  const modalIds = ['modal-site-form','modal-add-photo','modal-add-floor',
                    'modal-add-building','modal-add-siteplan','modal-step-prompt','modal-close-site'];
  const anyOpen = modalIds.some(
    mid => mid !== id && !document.getElementById(mid).classList.contains('hidden')
  );
  if (!anyOpen) document.getElementById('modal-backdrop').classList.add('hidden');
}

async function makeThumbnail(dataURL, size = 64) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      const sc = size / Math.min(img.width, img.height);
      const sw = img.width * sc, sh = img.height * sc;
      ctx.drawImage(img, (size - sw) / 2, (size - sh) / 2, sw, sh);
      resolve(c.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(null);
    img.src = dataURL;
  });
}

// ===== MAP INITIALISATION =====
function initMap() {
  if (map) return;

  const osmLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  });

  const googleHybridLayer = L.tileLayer(
    'https://mt{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
    {
      subdomains: ['0','1','2','3'],
      attribution: '© Google',
      maxZoom: 20,
    }
  );

  map = L.map('map', { layers: [osmLayer] }).setView([46.6, 2.3], 6);

  L.control.layers(
    { 'OpenStreetMap': osmLayer, 'Google Hybride': googleHybridLayer },
    {},
    { position: 'topright' }
  ).addTo(map);

  map.on('contextmenu', onMapRightClick);
  map.on('click', onMapClick);
}

// ===== MAP CLICK (navigation only — handles interaction modes) =====
function onMapClick(e) {
  if (interactionMode === 'perimeter-draw') { addPerimeterPoint(e.latlng);  return; }
  if (interactionMode === 'access-arrow')   { placeAccessArrow(e.latlng);   return; }
  if (interactionMode === 'move-photo')     { commitMovePhoto(e.latlng);    return; }
  if (interactionMode === 'orient-photo')   { commitOrientPhoto(e.latlng);  return; }
  if (interactionMode === 'move-building')  { commitMoveBuilding(e.latlng); return; }
  if (interactionMode === 'move-site')      { commitMoveSite(e.latlng);     return; }
  if (interactionMode === 'orient-access-arrow') return; // handled by map.once('click')
  hideMapContextMenu();
}

// ===== MAP RIGHT-CLICK =====
function onMapRightClick(e) {
  L.DomEvent.preventDefault(e.originalEvent);
  hideMapContextMenu();

  if (interactionMode) return; // ignore right-click during special modes

  const latlng = e.latlng;
  const pt = e.containerPoint;

  if (!state.activeSiteId) {
    showMapContextMenu(pt, [
      { label: '📍 Créer un nouveau site ici', action: () => openSiteForm(null, latlng.lat, latlng.lng, '') },
    ]);
  } else {
    showMapContextMenu(pt, [
      { label: '📷 Ajouter une photo ici', action: () => openPhotoTypeMenu(latlng) },
      { label: '🏢 Ajouter un bâtiment ici', action: () => openBuildingForm(latlng.lat, latlng.lng) },
    ]);
  }
}

// ===== MAP MOUSEMOVE (orient preview) =====
function onMapMousemove(e) {
  if (interactionMode !== 'orient-photo') return;
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === orientPhotoId);
  if (!photo || photo.lat == null) return;

  if (orientLine) { orientLine.remove(); orientLine = null; }
  orientLine = L.polyline([[photo.lat, photo.lon], [e.latlng.lat, e.latlng.lng]], {
    color: '#ffd700', weight: 2, dashArray: '5 4', opacity: 0.8,
  }).addTo(map);
}

// ===== CONTEXT MENU =====
function showMapContextMenu(containerPoint, items) {
  const menu = document.getElementById('map-context-menu');
  menu.innerHTML = '';
  items.forEach(item => {
    if (!item.label) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-menu-btn';
    btn.textContent = item.label;
    btn.addEventListener('click', () => {
      hideMapContextMenu();
      item.action();
    });
    menu.appendChild(btn);
  });

  // Position relative to map container
  const mapEl = document.getElementById('map-container');
  const rect = mapEl.getBoundingClientRect();
  let x = containerPoint.x;
  let y = containerPoint.y;

  menu.classList.remove('hidden');
  // Keep within bounds
  const mw = menu.offsetWidth || 200;
  const mh = menu.offsetHeight || 80;
  if (x + mw > mapEl.clientWidth)  x = mapEl.clientWidth  - mw - 4;
  if (y + mh > mapEl.clientHeight) y = mapEl.clientHeight - mh - 4;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function hideMapContextMenu() {
  document.getElementById('map-context-menu').classList.add('hidden');
}

// ===== PHOTO TYPE SELECTOR (after right-click "ajouter une photo") =====
function openPhotoTypeMenu(latlng) {
  const pt = map.latLngToContainerPoint(latlng);
  showMapContextMenu(pt, [
    { label: '📷 Photo normale (45°)',      action: () => startAddPhotoAt(latlng.lat, latlng.lng, 'normal') },
    { label: '🌅 Photo panoramique (120°)', action: () => startAddPhotoAt(latlng.lat, latlng.lng, 'panoramic') },
    { label: '🔵 Photo 360°',               action: () => startAddPhotoAt(latlng.lat, latlng.lng, '360') },
  ]);
}

// ===== ADDRESS SEARCH =====
function initSearch() {
  const input   = document.getElementById('map-search-input');
  const results = document.getElementById('map-search-results');

  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) { results.classList.add('hidden'); results.innerHTML = ''; return; }
    searchTimer = setTimeout(() => fetchAddresses(q), 300);
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Escape') { input.blur(); results.classList.add('hidden'); }
  });

  document.addEventListener('click', e => {
    if (!document.getElementById('map-search').contains(e.target)) {
      results.classList.add('hidden');
    }
  });
}

async function fetchAddresses(q) {
  const results = document.getElementById('map-search-results');
  try {
    const url = `https://api-adresse.data.gouv.fr/search/?q=${encodeURIComponent(q)}&limit=6`;
    const res  = await fetch(url);
    const data = await res.json();

    results.innerHTML = '';
    if (!data.features?.length) {
      results.innerHTML = '<div class="search-result-item" style="color:var(--color-text-muted)">Aucun résultat</div>';
      results.classList.remove('hidden');
      return;
    }

    data.features.forEach(f => {
      const [lon, lat] = f.geometry.coordinates;
      const div = document.createElement('div');
      div.className = 'search-result-item';
      div.innerHTML = `
        <div class="search-result-label">${escapeHtml(f.properties.label)}</div>
        <div class="search-result-context">${escapeHtml(f.properties.context || '')}</div>`;
      div.addEventListener('click', () => {
        document.getElementById('map-search-input').value = f.properties.label;
        results.classList.add('hidden');
        placeSearchResult(lat, lon, f.properties.label);
      });
      results.appendChild(div);
    });
    results.classList.remove('hidden');
  } catch (err) {
    console.warn('Address search error:', err);
  }
}

function placeSearchResult(lat, lon, label) {
  if (searchResultMarker) { searchResultMarker.remove(); searchResultMarker = null; }

  const icon = L.divIcon({
    className: '',
    html: '<div class="search-pin" title="' + escapeAttr(label) + '">🔍</div>',
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });

  searchResultMarker = L.marker([lat, lon], { icon }).addTo(map);
  map.setView([lat, lon], 16);
}

// ===== SITE MANAGEMENT =====
function openSiteForm(siteId, lat, lon, address) {
  sfEditingId = siteId;

  const site = siteId ? state.sites.find(s => s.id === siteId) : null;
  document.getElementById('modal-site-form-title').textContent = site ? 'Options du site' : 'Nouveau site';
  document.getElementById('btn-sf-confirm').textContent = site ? 'Sauvegarder' : 'Créer le site';
  document.getElementById('sf-perimeter-row').classList.toggle('hidden', !siteId);

  document.getElementById('sf-name').value    = site?.name    || '';
  document.getElementById('sf-address').value = site?.address || address || '';
  document.getElementById('sf-lat').value     = site?.lat ?? lat ?? '';
  document.getElementById('sf-lon').value     = site?.lon ?? lon ?? '';

  sfTempContacts     = JSON.parse(JSON.stringify(site?.contacts || []));
  sfTempIcon         = site?.icon || '🏛';
  sfTempIllustration = undefined;

  renderSfIconBank();
  renderSfContacts();
  updateSfIllustrationPreview(site?.illustration || null);

  showModal('modal-site-form');
}

function confirmSiteForm() {
  const name    = document.getElementById('sf-name').value.trim() || 'Nouveau site';
  const address = document.getElementById('sf-address').value.trim();
  const lat     = parseFloat(document.getElementById('sf-lat').value);
  const lon     = parseFloat(document.getElementById('sf-lon').value);

  if (sfEditingId) {
    const site = state.sites.find(s => s.id === sfEditingId);
    if (site) {
      site.name    = name;
      site.address = address;
      if (!isNaN(lat)) site.lat = lat;
      if (!isNaN(lon)) site.lon = lon;
      site.icon     = sfTempIcon;
      site.contacts = JSON.parse(JSON.stringify(sfTempContacts));
      if (sfTempIllustration !== undefined) site.illustration = sfTempIllustration;

      removeSiteMarker(site.id);
      addSiteMarker(site);
      renderSidebar();
    }
    hideModal('modal-site-form');
    updateTopBarButtons();
    return;
  }

  // Creating new
  if (isNaN(lat) || isNaN(lon)) { alert('Les coordonnées GPS sont requises.'); return; }
  const site = {
    id: uid(),
    name,
    address,
    lat,
    lon,
    icon: sfTempIcon,
    illustration: sfTempIllustration !== undefined ? sfTempIllustration : null,
    contacts: JSON.parse(JSON.stringify(sfTempContacts)),
    buildings: [],
    sitePlans: [],
    photos: [],
    perimeter: null,
    accessArrow: null,
  };
  state.sites.push(site);
  addSiteMarker(site);
  selectSite(site.id);

  hideModal('modal-site-form');
  updateTopBarButtons();

  // Propose optional steps
  stepQueue = [
    {
      title: 'Dessiner le périmètre',
      text: 'Voulez-vous tracer le périmètre du site (contour en pointillés rouges) ?',
      yesAction: () => startPerimeterDraw(site.id),
    },
    {
      title: 'Flèche d\'accès principal',
      text: 'Voulez-vous placer la flèche d\'accès principal du site ?',
      yesAction: () => startAccessArrowPlacement(site.id),
    },
  ];
  runNextStep();
}

// ===== STEP PROMPT =====
function runNextStep() {
  if (!stepQueue.length) return;
  const step = stepQueue.shift();
  document.getElementById('step-prompt-title').textContent = step.title;
  document.getElementById('step-prompt-text').textContent  = step.text;

  document.getElementById('btn-step-yes').onclick = () => {
    hideModal('modal-step-prompt');
    step.yesAction();
  };
  document.getElementById('btn-step-later').onclick = () => {
    hideModal('modal-step-prompt');
    runNextStep();
  };

  showModal('modal-step-prompt');
}

// ===== PERIMETER DRAWING =====
function startPerimeterDraw(siteId) {
  interactionMode   = 'perimeter-draw';
  interactionSiteId = siteId;
  perimeterPoints   = [];

  document.getElementById('map').classList.add('map-cursor-crosshair');
  setStepBanner(
    'Cliquez pour ajouter des points au périmètre. Double-clic pour fermer.',
    [
      { label: 'Fermer le périmètre', primary: true,  action: finishPerimeter },
      { label: 'Annuler',             primary: false, action: cancelPerimeter },
    ]
  );

  // Double-click to finish
  map.once('dblclick', e => {
    L.DomEvent.stopPropagation(e);
    finishPerimeter();
  });
}

function addPerimeterPoint(latlng) {
  perimeterPoints.push([latlng.lat, latlng.lng]);

  if (perimeterPolyline) perimeterPolyline.remove();
  if (perimeterPoints.length >= 2) {
    perimeterPolyline = L.polyline(perimeterPoints, {
      color: 'red', dashArray: '8 6', weight: 2, opacity: 0.85,
    }).addTo(map);
  }
}

function finishPerimeter() {
  clearStepBanner();
  document.getElementById('map').classList.remove('map-cursor-crosshair');
  map.off('dblclick');

  if (perimeterPolyline) { perimeterPolyline.remove(); perimeterPolyline = null; }

  const site = state.sites.find(s => s.id === interactionSiteId);
  if (site && perimeterPoints.length >= 3) {
    site.perimeter = { points: perimeterPoints.map(([lat, lon]) => ({ lat, lon })) };
    renderSitePerimeter(site);
  }

  interactionMode = null;
  perimeterPoints = [];
  runNextStep();
}

function cancelPerimeter() {
  clearStepBanner();
  document.getElementById('map').classList.remove('map-cursor-crosshair');
  map.off('dblclick');
  if (perimeterPolyline) { perimeterPolyline.remove(); perimeterPolyline = null; }
  interactionMode = null;
  perimeterPoints = [];
  runNextStep();
}

function renderSitePerimeter(site) {
  if (perimeterLayer) { perimeterLayer.remove(); perimeterLayer = null; }
  if (!site?.perimeter?.points?.length) return;
  const pts = site.perimeter.points.map(p => [p.lat, p.lon]);
  perimeterLayer = L.polygon(pts, {
    color: 'red', dashArray: '8 6', weight: 2, fill: false, opacity: 0.8,
  }).addTo(map);
}

// ===== ACCESS ARROW =====
function startAccessArrowPlacement(siteId) {
  interactionMode   = 'access-arrow';
  interactionSiteId = siteId;

  document.getElementById('map').classList.add('map-cursor-aim');
  setStepBanner(
    'Cliquez sur la carte pour placer la flèche d\'accès principal.',
    [{ label: 'Annuler', primary: false, action: cancelAccessArrow }]
  );
}

function placeAccessArrow(latlng) {
  clearStepBanner();
  document.getElementById('map').classList.remove('map-cursor-aim');

  const site = state.sites.find(s => s.id === interactionSiteId);
  if (site) {
    site.accessArrow = { lat: latlng.lat, lon: latlng.lng, bearing: 0 };
    renderAccessArrow(site);
  }

  interactionMode = null;
  runNextStep();
}

function cancelAccessArrow() {
  clearStepBanner();
  document.getElementById('map').classList.remove('map-cursor-aim');
  interactionMode = null;
  runNextStep();
}

function renderAccessArrow(site) {
  if (accessArrowMarker) { accessArrowMarker.remove(); accessArrowMarker = null; }
  if (!site?.accessArrow) return;

  const a = site.accessArrow;
  const icon = makeAccessArrowIcon(a.bearing);

  accessArrowMarker = L.marker([a.lat, a.lon], { icon })
    .addTo(map)
    .on('contextmenu', e => {
      L.DomEvent.stopPropagation(e);
      showMapContextMenu(e.containerPoint, [
        { label: '↻ Orienter la flèche', action: () => startOrientAccessArrow(site) },
        { label: '✕ Supprimer la flèche', action: () => {
          accessArrowMarker.remove(); accessArrowMarker = null;
          site.accessArrow = null;
        }},
      ]);
    });
}

function makeAccessArrowIcon(bearing) {
  const rot = bearing || 0;
  const svg = `<svg width="32" height="32" viewBox="-16 -16 32 32" style="transform:rotate(${rot}deg);transform-origin:center;overflow:visible">
    <polygon points="0,-14 -6,-2 0,-6 6,-2" fill="#ffd700" stroke="#fff" stroke-width="1.5"/>
    <circle r="5" fill="#ffd700" stroke="#fff" stroke-width="1.5"/>
  </svg>`;
  return L.divIcon({
    className: 'access-arrow-marker',
    html: svg,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

function startOrientAccessArrow(site) {
  interactionMode = 'orient-access-arrow';

  const cancel = () => { clearStepBanner(); interactionMode = null; map.off('click', handler); };
  const handler = e => {
    const dx = e.latlng.lng - site.accessArrow.lon;
    const dy = e.latlng.lat - site.accessArrow.lat;
    site.accessArrow.bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
    renderAccessArrow(site);
    clearStepBanner();
    interactionMode = null;
    map.off('click', handler);
  };

  setStepBanner(
    'Cliquez sur la carte pour indiquer la direction de la flèche d\'accès.',
    [{ label: 'Annuler', primary: false, action: cancel }]
  );
  map.on('click', handler);
}

// ===== STEP BANNER =====
function setStepBanner(text, buttons) {
  document.getElementById('step-banner-text').textContent = text;
  const actionsEl = document.getElementById('step-banner-actions');
  actionsEl.innerHTML = '';
  buttons.forEach(b => {
    const btn = document.createElement('button');
    btn.className = b.primary ? 'btn-primary btn-sm' : 'btn-secondary btn-sm';
    btn.textContent = b.label;
    btn.addEventListener('click', b.action);
    actionsEl.appendChild(btn);
  });
  document.getElementById('step-banner').classList.remove('hidden');
  document.getElementById('map-container')?.classList.add('interaction-active');
}

function clearStepBanner() {
  document.getElementById('step-banner').classList.add('hidden');
  document.getElementById('map-container')?.classList.remove('interaction-active');
}

// ===== LOAD / SAVE =====
function loadSiteFromFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      // Migration: ensure new fields
      data.address      = data.address      || '';
      data.contacts     = data.contacts     || [];
      data.icon         = data.icon         || '🏛';
      data.illustration = data.illustration || null;
      data.buildings    = data.buildings    || [];
      data.sitePlans    = data.sitePlans    || [];
      data.perimeter    = data.perimeter    || null;
      data.accessArrow  = data.accessArrow  || null;
      // Migrate old floors[] to a default building
      if (data.floors && data.floors.length && !data.buildings.length) {
        data.buildings.push({
          id: uid(),
          name: 'Bâtiment principal',
          lat: data.lat,
          lon: data.lon,
          icon: '🏢',
          floors: data.floors,
        });
      }
      delete data.floors;
      // Migrate photo types: classic→normal
      (data.photos || []).forEach(p => {
        if (p.type === 'classic') p.type = 'normal';
        if (p.bearing == null) p.bearing = 0;
        if (p.buildingId == null) p.buildingId = null;
        if (p.sitePlanId == null) p.sitePlanId = null;
      });

      if (state.sites.find(s => s.id === data.id)) {
        if (!confirm(`Un site "${data.name}" est déjà chargé. Remplacer ?`)) return;
        removeSiteMarker(data.id);
        state.sites = state.sites.filter(s => s.id !== data.id);
      }

      state.sites.push(data);
      addSiteMarker(data);
      if (data.perimeter)   renderSitePerimeter(data);
      if (data.accessArrow) renderAccessArrow(data);

      selectSite(data.id);
      updateTopBarButtons();
    } catch (err) {
      alert('Fichier JSON invalide : ' + err.message);
    }
  };
  reader.readAsText(file);
}

function downloadSite(site) {
  const json = JSON.stringify(site, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = (site.name || 'site') + '.cado';
  a.click();
  URL.revokeObjectURL(url);
}

function saveSite() {
  const site = getActiveSite();
  if (!site) return;
  downloadSite(site);
  clearCacheState();
}

// ===== CLOSE SITE =====
function closeSite() {
  const site = getActiveSite();
  if (!site) return;
  document.getElementById('close-site-name').textContent = site.name || 'ce site';
  showModal('modal-close-site');
}

async function _doCloseSite(withSave) {
  hideModal('modal-close-site');
  const site = getActiveSite();
  if (!site) return;

  if (withSave) downloadSite(site);

  const siteId = site.id;

  // Reset active state
  state.activeSiteId     = null;
  state.activeBuildingId = null;
  state.activeFloorId    = null;
  state.activeSitePlanId = null;
  state.activePhotoId    = null;

  // Clean up map layers
  clearBuildingMarkers();
  clearPhotoMarkers();
  removeSiteMarker(siteId);
  if (perimeterLayer)    { perimeterLayer.remove();    perimeterLayer    = null; }
  if (accessArrowMarker) { accessArrowMarker.remove(); accessArrowMarker = null; }

  // Remove from memory
  state.sites = state.sites.filter(s => s.id !== siteId);

  // Update cache: vider si plus rien, sinon sauver les sites restants
  clearTimeout(_saveTimer);
  if (state.sites.length) {
    await saveCacheNow();
  } else {
    await clearCacheState();
  }

  // Update UI
  closeViewer();
  renderSidebar();
  renderSiteHeader();
  updateTopBarButtons();
  if (state.viewMode !== 'map') switchViewMode('map');

  const fileToLoad = pendingLoadFile;   pendingLoadFile    = null;
  const urlToGo    = pendingNavigateUrl; pendingNavigateUrl = null;
  if (fileToLoad) { loadSiteFromFile(fileToLoad); return; }
  if (urlToGo)    { window.location.href = urlToGo; }
}

// ===== SITE SELECTION =====
function selectSite(siteId) {
  const prev = state.activeSiteId;
  state.activeSiteId    = siteId;
  state.activeBuildingId = null;
  state.activeFloorId   = null;
  state.activeSitePlanId = null;
  state.activePhotoId   = null;

  if (prev && siteMarkers[prev]) {
    const prevSite = state.sites.find(s => s.id === prev);
    if (prevSite) updateSiteMarkerIcon(prev, false);
  }
  updateSiteMarkerIcon(siteId, true);

  // Clear old building markers, add new ones
  clearBuildingMarkers();
  clearPhotoMarkers();

  const site = getActiveSite();
  if (site) {
    (site.buildings || []).forEach(b => addBuildingMarker(b));
    (site.photos || []).filter(p => !p.floorId && !p.sitePlanId && p.lat != null)
      .forEach(p => addPhotoMarker(p));
    if (site.perimeter)   renderSitePerimeter(site);
    if (site.accessArrow) renderAccessArrow(site);
  }

  renderSidebar();
  switchViewMode('map');
  updateTopBarButtons();
  closeViewer();
  renderSiteHeader();

  if (site && map) {
    map.flyTo([site.lat, site.lon], Math.max(map.getZoom(), 17));
  }
}

function deselectSite() {
  if (!state.activeSiteId) return;
  const prev = state.activeSiteId;
  state.activeSiteId     = null;
  state.activeBuildingId = null;
  state.activeFloorId    = null;
  state.activeSitePlanId = null;
  state.activePhotoId    = null;

  updateSiteMarkerIcon(prev, false);
  clearBuildingMarkers();
  clearPhotoMarkers();
  if (perimeterLayer) { perimeterLayer.remove(); perimeterLayer = null; }
  if (accessArrowMarker) { accessArrowMarker.remove(); accessArrowMarker = null; }

  renderSidebar();
  renderSiteHeader();
  updateTopBarButtons();
  closeViewer();
  if (state.viewMode !== 'map') switchViewMode('map');
}

function updateTopBarButtons() {
  const hasSite = !!state.activeSiteId;
  document.getElementById('btn-save-site').disabled  = !hasSite;
  document.getElementById('btn-close-site').disabled = !hasSite;
}

// ===== SITE MARKERS =====
function addSiteMarker(site) {
  if (!map) return;
  const isActive = site.id === state.activeSiteId;
  const m = L.marker([site.lat, site.lon], { icon: makeSiteMarkerIcon(site, isActive) })
    .addTo(map)
    .on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (interactionMode) return;
      if (state.activeSiteId === site.id) {
        // Already selected: nothing (user can right-click for options)
      } else {
        selectSite(site.id);
      }
    })
    .on('contextmenu', e => {
      L.DomEvent.stopPropagation(e);
      if (interactionMode) return;
      hideMapContextMenu();
      showMapContextMenu(e.containerPoint, [
        { label: '⬡ Déplacer',        action: () => startMoveSite(site.id) },
        { label: '⚙ Options du site', action: () => openSiteForm(site.id) },
        { label: '✕ Désélectionner',  action: () => deselectSite() },
      ]);
    });
  siteMarkers[site.id] = m;
}

function removeSiteMarker(siteId) {
  if (siteMarkers[siteId]) { siteMarkers[siteId].remove(); delete siteMarkers[siteId]; }
}

function updateSiteMarkerIcon(siteId, isActive) {
  const site = state.sites.find(s => s.id === siteId);
  if (!site || !siteMarkers[siteId]) return;
  siteMarkers[siteId].setIcon(makeSiteMarkerIcon(site, isActive));
}

// ===== BUILDING MANAGEMENT =====
function openBuildingForm(lat, lon) {
  bfTempLat  = lat;
  bfTempLon  = lon;
  bfTempIcon = '🏢';

  document.getElementById('bf-name').value = '';
  renderBfIconBank();
  showModal('modal-add-building');
}

function confirmBuildingForm() {
  const site = getActiveSite();
  if (!site) return;

  const name = document.getElementById('bf-name').value.trim() || 'Bâtiment';
  const building = {
    id: uid(),
    name,
    lat: bfTempLat,
    lon: bfTempLon,
    icon: bfTempIcon,
    floors: [],
  };

  site.buildings.push(building);
  addBuildingMarker(building);
  renderSidebar();
  hideModal('modal-add-building');
}

function deleteBuilding(buildingId) {
  const site = getActiveSite();
  if (!site || !confirm('Supprimer ce bâtiment et tous ses plans ?')) return;

  // Remove photos linked to this building
  site.photos = site.photos.filter(p => p.buildingId !== buildingId);
  site.buildings = site.buildings.filter(b => b.id !== buildingId);

  if (buildingMarkers[buildingId]) { buildingMarkers[buildingId].remove(); delete buildingMarkers[buildingId]; }

  if (state.activeBuildingId === buildingId) {
    state.activeBuildingId = null;
    state.activeFloorId    = null;
    switchViewMode('map');
  }
  renderSidebar();
}

function makeBuildingMarkerIcon(building) {
  return _makeBuildingMarkerIcon(building, building.id === state.activeBuildingId);
}

function addBuildingMarker(building) {
  if (!map) return;
  const m = L.marker([building.lat, building.lon], { icon: makeBuildingMarkerIcon(building) })
    .addTo(map)
    .on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (interactionMode) return;
      // Open first floor of this building
      if (building.floors?.length) {
        selectFloor(building.id, building.floors[0].id);
      }
    })
    .on('contextmenu', e => {
      L.DomEvent.stopPropagation(e);
      if (interactionMode) return;
      showMapContextMenu(e.containerPoint, [
        { label: '⬡ Déplacer',              action: () => startMoveBuilding(building.id) },
        { label: '🗑 Supprimer ce bâtiment', action: () => deleteBuilding(building.id) },
      ]);
    });
  buildingMarkers[building.id] = m;
}

function clearBuildingMarkers() {
  Object.values(buildingMarkers).forEach(m => m.remove());
  buildingMarkers = {};
}

// ===== PHOTO MARKERS =====
function makePhotoIcon(type, bearing, isActive) {
  const rot = ((bearing || 0) + 360) % 360;
  let svgInner, size, anchor;

  if (type === 'normal') {
    // 45° wedge pointing up
    size = 44; anchor = 22;
    svgInner = `
      <path d="M0,0 L-6.9,-16.6 A18,18,0,0,1,6.9,-16.6 Z" fill="#e94560" opacity="0.8"/>
      <circle r="6" fill="#e94560" stroke="white" stroke-width="${isActive ? 2.5 : 1.5}"/>`;
  } else if (type === 'panoramic') {
    // 120° wedge pointing up
    size = 48; anchor = 24;
    svgInner = `
      <path d="M0,0 L-15.6,-9 A18,18,0,0,1,15.6,-9 Z" fill="#e07b20" opacity="0.75"/>
      <circle r="6" fill="#e07b20" stroke="white" stroke-width="${isActive ? 2.5 : 1.5}"/>`;
  } else {
    // 360°: full circle + north arrow
    size = 40; anchor = 20;
    svgInner = `
      <circle r="15" fill="none" stroke="#2980b9" stroke-width="2.5" opacity="0.85"/>
      <polygon points="0,-15 -4,-9 4,-9" fill="#2980b9"/>
      <circle r="5" fill="#2980b9" stroke="white" stroke-width="${isActive ? 2.5 : 1.5}"/>`;
  }

  const glow = isActive ? 'drop-shadow(0 0 6px rgba(255,255,255,0.8))' : '';
  const html = `<div style="width:${size}px;height:${size}px;transform:rotate(${rot}deg);transform-origin:${anchor}px ${anchor}px;filter:drop-shadow(0 1px 4px rgba(0,0,0,0.6)) ${glow}">
    <svg width="${size}" height="${size}" viewBox="-${anchor} -${anchor} ${size} ${size}" style="overflow:visible">${svgInner}</svg>
  </div>`;

  return L.divIcon({
    className: 'photo-icon-wrapper',
    html,
    iconSize: [size, size],
    iconAnchor: [anchor, anchor],
  });
}

function addPhotoMarker(photo) {
  if (!map) return;
  const isActive = photo.id === state.activePhotoId;
  const icon = makePhotoIcon(photo.type, photo.bearing, isActive);

  const m = L.marker([photo.lat, photo.lon], { icon })
    .addTo(map)
    .on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (interactionMode) return;
      openViewer(photo.id);
    })
    .on('contextmenu', e => {
      L.DomEvent.stopPropagation(e);
      if (interactionMode) return;
      hideMapContextMenu();
      const siblingCount = findPhotoSiblings(photo).length;
      showMapContextMenu(e.containerPoint, [
        { label: '⬡ Déplacer le point',  action: () => startMovePhoto(photo.id) },
        { label: '↻ Orienter le point',  action: () => startOrientPhoto(photo.id) },
        { label: null },
        { label: photoAddLabel(photo.type), action: () => addPhotoToPoint(photo) },
        { label: null },
        { label: `🗑 Supprimer${siblingCount > 1 ? ' cette photo' : ' le point'}`, action: () => deletePhoto(photo.id) },
      ]);
    })
    .on('mouseover', function () { this.getElement()?.classList.add('hovered'); })
    .on('mouseout',  function () { this.getElement()?.classList.remove('hovered'); });

  photoMarkers[photo.id] = m;
}

function removePhotoMarker(photoId) {
  if (photoMarkers[photoId]) { photoMarkers[photoId].remove(); delete photoMarkers[photoId]; }
}

function clearPhotoMarkers() {
  Object.values(photoMarkers).forEach(m => m.remove());
  photoMarkers = {};
}

function refreshPhotoMarker(photoId) {
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === photoId);
  if (!photo) return;
  removePhotoMarker(photoId);
  if (photo.lat != null) addPhotoMarker(photo);
}

function refreshMarkerActive() {
  const site = getActiveSite();
  Object.entries(photoMarkers).forEach(([id, m]) => {
    const photo = site?.photos.find(p => p.id === id);
    if (photo) {
      m.setIcon(makePhotoIcon(photo.type, photo.bearing, id === state.activePhotoId));
    }
  });
}

// ===== MOVE PHOTO =====
function startMovePhoto(photoId) {
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === photoId);
  if (!photo) return;

  // Ghost all photos at this point
  findPhotoSiblings(photo).forEach(id => {
    photoMarkers[id]?.getElement()?.classList.add('ghost');
  });

  interactionMode = 'move-photo';
  movePhotoId     = photoId;
  setStepBanner(
    'Cliquez sur la nouvelle position du point (toutes ses photos seront déplacées).',
    [{ label: 'Annuler', primary: false, action: cancelMovePhoto }]
  );
}

function commitMovePhoto(latlng) {
  clearStepBanner();
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === movePhotoId);
  if (photo) {
    const oldLat = photo.lat, oldLon = photo.lon;
    site.photos
      .filter(p => p.lat === oldLat && p.lon === oldLon)
      .forEach(p => { p.lat = latlng.lat; p.lon = latlng.lng; refreshPhotoMarker(p.id); });
  }
  interactionMode = null;
  movePhotoId = null;
  scheduleCacheSave();
}

function cancelMovePhoto() {
  clearStepBanner();
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === movePhotoId);
  if (photo) {
    findPhotoSiblings(photo).forEach(id => {
      photoMarkers[id]?.getElement()?.classList.remove('ghost');
    });
  }
  interactionMode = null;
  movePhotoId = null;
}

// ===== MOVE BUILDING =====
function startMoveBuilding(buildingId) {
  const m = buildingMarkers[buildingId];
  if (!m) return;
  m.getElement()?.classList.add('ghost');
  interactionMode = 'move-building';
  moveBuildingId  = buildingId;
  setStepBanner(
    'Cliquez sur la nouvelle position du bâtiment.',
    [{ label: 'Annuler', primary: false, action: cancelMoveBuilding }]
  );
}

function commitMoveBuilding(latlng) {
  clearStepBanner();
  const site     = getActiveSite();
  const building = site?.buildings.find(b => b.id === moveBuildingId);
  if (building) {
    building.lat = latlng.lat;
    building.lon = latlng.lng;
    const m = buildingMarkers[moveBuildingId];
    if (m) { m.setLatLng([building.lat, building.lon]); m.getElement()?.classList.remove('ghost'); }
  }
  interactionMode = null;
  moveBuildingId  = null;
}

function cancelMoveBuilding() {
  clearStepBanner();
  buildingMarkers[moveBuildingId]?.getElement()?.classList.remove('ghost');
  interactionMode = null;
  moveBuildingId  = null;
}

// ===== MOVE SITE =====
function startMoveSite(siteId) {
  const m = siteMarkers[siteId];
  if (!m) return;
  m.getElement()?.classList.add('ghost');
  interactionMode = 'move-site';
  moveSiteId      = siteId;
  setStepBanner(
    'Cliquez sur la nouvelle position du site.',
    [{ label: 'Annuler', primary: false, action: cancelMoveSite }]
  );
}

function commitMoveSite(latlng) {
  clearStepBanner();
  const site = state.sites.find(s => s.id === moveSiteId);
  if (site) {
    site.lat = latlng.lat;
    site.lon = latlng.lng;
    const m = siteMarkers[moveSiteId];
    if (m) { m.setLatLng([site.lat, site.lon]); m.getElement()?.classList.remove('ghost'); }
  }
  interactionMode = null;
  moveSiteId      = null;
}

function cancelMoveSite() {
  clearStepBanner();
  siteMarkers[moveSiteId]?.getElement()?.classList.remove('ghost');
  interactionMode = null;
  moveSiteId      = null;
}

// ===== ORIENT PHOTO =====
function startOrientPhoto(photoId) {
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === photoId);
  if (!photo) return;

  interactionMode = 'orient-photo';
  orientPhotoId   = photoId;

  map.on('mousemove', onMapMousemove);
  setStepBanner(
    'Cliquez sur la carte pour définir la direction de la photo.',
    [{ label: 'Annuler', primary: false, action: cancelOrientPhoto }]
  );
}

function commitOrientPhoto(latlng) {
  clearStepBanner();
  map.off('mousemove', onMapMousemove);
  if (orientLine) { orientLine.remove(); orientLine = null; }

  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === orientPhotoId);
  if (photo && photo.lat != null) {
    const dx = latlng.lng - photo.lon;
    const dy = latlng.lat - photo.lat;
    const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
    site.photos
      .filter(p => p.lat === photo.lat && p.lon === photo.lon)
      .forEach(p => { p.bearing = bearing; refreshPhotoMarker(p.id); });
    if (state.activePhotoId === photo.id) {
      document.getElementById('edit-photo-bearing').value = Math.round(bearing);
    }
    scheduleCacheSave();
  }

  interactionMode = null;
  orientPhotoId   = null;
}

function cancelOrientPhoto() {
  clearStepBanner();
  map.off('mousemove', onMapMousemove);
  if (orientLine) { orientLine.remove(); orientLine = null; }
  interactionMode = null;
  orientPhotoId   = null;
}

// ===== SIDEBAR =====
function renderSiteHeader() {
  const site = getActiveSite();
  document.getElementById('site-header-icon').textContent = site ? (site.icon || '🏛') : '';
  document.getElementById('site-header-name').textContent = site ? site.name : 'Aucun site sélectionné';
  document.getElementById('btn-deselect-site').classList.toggle('hidden', !site);
  document.getElementById('btn-site-options').classList.toggle('hidden', !site);
}

function renderSidebar() {
  const nav  = document.getElementById('sidebar-nav');
  const site = getActiveSite();
  nav.innerHTML = '';

  if (!site) {
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:16px 12px;color:var(--color-text-muted);font-size:12px;line-height:1.5';
    hint.textContent = 'Clic droit sur la carte pour créer un site, ou chargez un fichier .cado.';
    nav.appendChild(hint);
    return;
  }

  // Carte extérieure
  appendNavItem(nav, {
    icon: '🗺', label: 'Carte extérieure',
    active: state.viewMode === 'map',
    onClick: () => switchViewMode('map'),
  });

  // Site plans section
  if (site.sitePlans?.length || true) {
    const div = document.createElement('div');
    div.className = 'nav-divider';
    div.textContent = 'Plans du site';
    nav.appendChild(div);

    (site.sitePlans || []).forEach(sp => {
      appendNavItem(nav, {
        icon: '🗃', label: sp.name,
        active: state.activeSitePlanId === sp.id,
        onDelete: () => deleteSitePlan(sp.id),
        onClick: () => selectSitePlan(sp.id),
      });
    });

    const addSP = document.createElement('button');
    addSP.className = 'nav-add-btn';
    addSP.textContent = '+ Ajouter un plan de site';
    addSP.addEventListener('click', () => openAddSitePlanModal());
    nav.appendChild(addSP);
  }

  // Buildings section
  const bldDiv = document.createElement('div');
  bldDiv.className = 'nav-divider';
  bldDiv.textContent = 'Bâtiments';
  nav.appendChild(bldDiv);

  (site.buildings || []).forEach(building => {
    // Building header
    const bh = document.createElement('div');
    bh.className = 'nav-building-header';
    bh.innerHTML = `<span>${escapeHtml(building.icon || '🏢')}</span>
                    <span style="flex:1">${escapeHtml(building.name)}</span>
                    <button class="nav-bld-del" title="Supprimer">🗑</button>`;
    bh.querySelector('.nav-bld-del').addEventListener('click', e => {
      e.stopPropagation();
      deleteBuilding(building.id);
    });
    nav.appendChild(bh);

    // Floors
    building.floors.forEach(floor => {
      appendNavItem(nav, {
        icon: '📐', label: floor.name,
        active: state.activeFloorId === floor.id && state.activeBuildingId === building.id,
        sub: true,
        onDelete: () => deleteFloor(building.id, floor.id),
        onClick: () => selectFloor(building.id, floor.id),
      });
    });

    // Add floor button
    const addFloorBtn = document.createElement('button');
    addFloorBtn.className = 'nav-add-btn nav-add-sub';
    addFloorBtn.textContent = '+ Ajouter un niveau';
    addFloorBtn.addEventListener('click', () => openAddFloorModal(building.id));
    nav.appendChild(addFloorBtn);
  });

}

function appendNavItem(nav, { icon, label, active, sub, onDelete, onClick }) {
  const item = document.createElement('div');
  item.className = 'nav-item' + (active ? ' active' : '') + (sub ? ' nav-sub' : '');
  item.innerHTML = `<span class="nav-item-icon">${icon}</span>
                    <span class="nav-item-label">${escapeHtml(label)}</span>
                    ${onDelete ? '<button class="nav-item-del" title="Supprimer">✕</button>' : ''}`;
  item.addEventListener('click', e => {
    if (e.target.classList.contains('nav-item-del')) { onDelete(); return; }
    onClick();
  });
  nav.appendChild(item);
}

// ===== VIEW MODE =====
function switchViewMode(mode) {
  state.viewMode = mode;

  document.getElementById('map-container').classList.toggle('hidden', mode !== 'map');
  document.getElementById('plan-container').classList.toggle('hidden', mode !== 'plan');
  document.getElementById('map-search').classList.toggle('hidden', mode !== 'map');

  if (mode === 'map') {
    setTimeout(() => { if (map) map.invalidateSize(); }, 50);
  } else {
    renderPlan();
  }
  renderSidebar();
}

// ===== FLOOR MANAGEMENT =====
function selectFloor(buildingId, floorId) {
  state.activeBuildingId = buildingId;
  state.activeFloorId    = floorId;
  state.activeSitePlanId = null;
  state.activePhotoId    = null;

  // Update building markers
  Object.entries(buildingMarkers).forEach(([id, m]) => {
    const site = getActiveSite();
    const bld  = site?.buildings.find(b => b.id === id);
    if (bld) m.setIcon(makeBuildingMarkerIcon(bld));
  });

  switchViewMode('plan');
  closeViewer();
  renderSidebar();
}

function selectSitePlan(planId) {
  state.activeSitePlanId = planId;
  state.activeBuildingId = null;
  state.activeFloorId    = null;
  state.activePhotoId    = null;
  switchViewMode('plan');
  closeViewer();
  renderSidebar();
}

function openAddFloorModal(buildingId) {
  addFloorBuildingId = buildingId;
  document.getElementById('new-floor-name').value  = '';
  document.getElementById('input-floor-plan').value = '';
  showModal('modal-add-floor');
}

async function confirmAddFloor() {
  const site     = getActiveSite();
  const building = site?.buildings.find(b => b.id === addFloorBuildingId);
  if (!building) return;

  const name = document.getElementById('new-floor-name').value.trim() || 'Étage';
  const file = document.getElementById('input-floor-plan').files[0];
  let dataURL = null;
  if (file) dataURL = await fileToDataURL(file);

  const floor = { id: uid(), name, imageDataURL: dataURL || null };
  building.floors.push(floor);
  hideModal('modal-add-floor');
  selectFloor(building.id, floor.id);
}

function deleteFloor(buildingId, floorId) {
  const site     = getActiveSite();
  const building = site?.buildings.find(b => b.id === buildingId);
  if (!building || !confirm('Supprimer ce niveau et toutes ses photos ?')) return;

  site.photos = site.photos.filter(p => !(p.buildingId === buildingId && p.floorId === floorId));
  building.floors = building.floors.filter(f => f.id !== floorId);

  if (state.activeFloorId === floorId && state.activeBuildingId === buildingId) {
    state.activeFloorId    = null;
    state.activeBuildingId = null;
    switchViewMode('map');
  }
  renderSidebar();
}

function openAddSitePlanModal() {
  document.getElementById('new-siteplan-name').value  = '';
  document.getElementById('input-siteplan-file').value = '';
  showModal('modal-add-siteplan');
}

async function confirmAddSitePlan() {
  const site = getActiveSite();
  if (!site) return;

  const name = document.getElementById('new-siteplan-name').value.trim() || 'Plan';
  const file = document.getElementById('input-siteplan-file').files[0];
  let dataURL = null;
  if (file) dataURL = await fileToDataURL(file);

  const sp = { id: uid(), name, imageDataURL: dataURL || null };
  site.sitePlans.push(sp);
  hideModal('modal-add-siteplan');
  selectSitePlan(sp.id);
}

function deleteSitePlan(planId) {
  const site = getActiveSite();
  if (!site || !confirm('Supprimer ce plan de site ?')) return;

  site.photos   = site.photos.filter(p => p.sitePlanId !== planId);
  site.sitePlans = site.sitePlans.filter(sp => sp.id !== planId);

  if (state.activeSitePlanId === planId) {
    state.activeSitePlanId = null;
    switchViewMode('map');
  }
  renderSidebar();
}

// ===== FLOOR PLAN RENDERING =====
function getActivePlan() { return _getActivePlan(state, getActiveSite()); }

function renderPlan() {
  const active = getActivePlan();
  if (!active) return;

  document.getElementById('plan-floor-name').textContent = active.label;

  const canvas   = document.getElementById('plan-canvas');
  const viewport = document.getElementById('plan-viewport');

  if (!active.imageDataURL) {
    canvas.width = 0; canvas.height = 0;
    renderPlanMarkers();
    return;
  }

  const img = new Image();
  img.onload = () => {
    plan.img = img;
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    plan.scale   = Math.min(vw / img.width, vh / img.height, 1);
    plan.offsetX = (vw - img.width  * plan.scale) / 2;
    plan.offsetY = (vh - img.height * plan.scale) / 2;
    drawPlanCanvas();
    renderPlanMarkers();
  };
  img.src = active.imageDataURL;
}

function updateActivePlanImage(dataURL) {
  const site = getActiveSite();
  if (!site) return;

  if (state.activeSitePlanId) {
    const sp = site.sitePlans?.find(sp => sp.id === state.activeSitePlanId);
    if (sp) { sp.imageDataURL = dataURL; renderPlan(); }
  } else if (state.activeBuildingId && state.activeFloorId) {
    const bld   = site.buildings?.find(b => b.id === state.activeBuildingId);
    const floor = bld?.floors?.find(f => f.id === state.activeFloorId);
    if (floor) { floor.imageDataURL = dataURL; renderPlan(); }
  }
}

function drawPlanCanvas() { _drawPlanCanvas(plan); }

function renderPlanMarkers() {
  const svg  = document.getElementById('plan-overlay');
  svg.innerHTML = '';
  const site = getActiveSite();
  if (!site) return;

  let photos = [];
  if (state.activeSitePlanId) {
    photos = site.photos.filter(p => p.sitePlanId === state.activeSitePlanId && p.planX != null);
  } else if (state.activeBuildingId && state.activeFloorId) {
    photos = site.photos.filter(
      p => p.buildingId === state.activeBuildingId && p.floorId === state.activeFloorId && p.planX != null
    );
  }

  photos.forEach(photo => {
    const sx = photo.planX * plan.scale + plan.offsetX;
    const sy = photo.planY * plan.scale + plan.offsetY;
    const isActive = photo.id === state.activePhotoId;
    const color = photo.type === '360' ? '#2980b9' : photo.type === 'panoramic' ? '#e07b20' : '#e94560';

    const isGhost = planMoveGhostPos &&
      photo.planX      === planMoveGhostPos.planX      &&
      photo.planY      === planMoveGhostPos.planY      &&
      photo.buildingId === planMoveGhostPos.buildingId &&
      photo.floorId    === planMoveGhostPos.floorId    &&
      photo.sitePlanId === planMoveGhostPos.sitePlanId;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'plan-pin');
    g.setAttribute('transform', `translate(${sx},${sy})`);
    if (isGhost) { g.setAttribute('opacity', '0.3'); g.setAttribute('pointer-events', 'none'); }

    // FOV wedge for plan markers
    const wedge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const rot = photo.bearing || 0;
    if (photo.type === 'normal') {
      wedge.setAttribute('d', 'M0,0 L-5,-12 A13,13,0,0,1,5,-12 Z');
    } else if (photo.type === 'panoramic') {
      wedge.setAttribute('d', 'M0,0 L-11,-6.5 A13,13,0,0,1,11,-6.5 Z');
    } else {
      wedge.setAttribute('d', `M0,-11 A11,11,0,1,1,-0.01,-11 Z`);
    }
    wedge.setAttribute('fill', color);
    wedge.setAttribute('opacity', '0.6');
    wedge.setAttribute('transform', `rotate(${rot})`);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', isActive ? 7 : 5.5);
    circle.setAttribute('fill', color);
    circle.setAttribute('stroke', 'white');
    circle.setAttribute('stroke-width', isActive ? 2 : 1.5);
    circle.setAttribute('class', 'plan-pin-circle');

    g.appendChild(wedge);
    g.appendChild(circle);
    g.addEventListener('click', () => { if (!planMoveGhostPos) openViewer(photo.id); });
    g.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!planMoveGhostPos) showPlanPhotoContextMenu(e, photo);
    });
    svg.appendChild(g);
  });
}

function showPlanPhotoContextMenu(e, photo) {
  const viewport = document.getElementById('plan-viewport');
  document.getElementById('plan-click-menu')?.remove();

  const rect = viewport.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const menu = document.createElement('div');
  menu.id = 'plan-click-menu';
  menu.className = 'plan-click-menu';
  menu.style.left = mx + 'px';
  menu.style.top  = my + 'px';

  const siblingCount = findPhotoSiblings(photo).length;
  const items = [
    { label: '⬡ Déplacer le point',  action: () => startMovePlanPhoto(photo) },
    { label: '↻ Orienter le point',  action: () => startOrientPlanPhoto(photo) },
    { label: null },
    { label: photoAddLabel(photo.type), action: () => addPhotoToPoint(photo) },
    { label: null },
    { label: `🗑 Supprimer${siblingCount > 1 ? ' cette photo' : ' le point'}`, action: () => deletePhoto(photo.id) },
  ];
  items.forEach(item => {
    if (!item.action) {
      const sep = document.createElement('div');
      sep.className = 'ctx-menu-sep';
      menu.appendChild(sep);
      return;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-menu-btn';
    btn.textContent = item.label;
    btn.addEventListener('click', ev => { ev.stopPropagation(); menu.remove(); item.action(); });
    menu.appendChild(btn);
  });

  viewport.appendChild(menu);
  setTimeout(() => {
    document.addEventListener('click', function close(ev) {
      if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', close); }
    });
  }, 10);
}

function startOrientPlanPhoto(photo) {
  const viewport    = document.getElementById('plan-viewport');
  let   orientLine  = null;

  const cleanup = () => {
    viewport.style.cursor = '';
    viewport.removeEventListener('mousemove', onMove);
    viewport.removeEventListener('click',     onClick, true);
    if (orientLine) { orientLine.remove(); orientLine = null; }
    clearStepBanner();
  };

  const onMove = e => {
    const rect = viewport.getBoundingClientRect();
    const cx   = e.clientX - rect.left;
    const cy   = e.clientY - rect.top;
    const sx   = photo.planX * plan.scale + plan.offsetX;
    const sy   = photo.planY * plan.scale + plan.offsetY;
    const svg  = document.getElementById('plan-overlay');
    if (orientLine) orientLine.remove();
    orientLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    orientLine.setAttribute('x1', sx); orientLine.setAttribute('y1', sy);
    orientLine.setAttribute('x2', cx); orientLine.setAttribute('y2', cy);
    orientLine.setAttribute('stroke', '#ffd700');
    orientLine.setAttribute('stroke-width', '2');
    orientLine.setAttribute('stroke-dasharray', '5,4');
    orientLine.setAttribute('opacity', '0.9');
    orientLine.setAttribute('pointer-events', 'none');
    svg.appendChild(orientLine);
  };

  const onClick = e => {
    e.stopPropagation();
    const rect    = viewport.getBoundingClientRect();
    const mx      = e.clientX - rect.left;
    const my      = e.clientY - rect.top;
    const planX   = (mx - plan.offsetX) / plan.scale;
    const planY   = (my - plan.offsetY) / plan.scale;
    const dx      = planX - photo.planX;
    const dy      = planY - photo.planY;
    // dy est inversé vs coordonnées cartésiennes (y écran = bas = sud)
    const bearing = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
    const site    = getActiveSite();
    findPhotoSiblings(photo).forEach(id => {
      const p = site?.photos.find(ph => ph.id === id);
      if (p) p.bearing = bearing;
    });
    cleanup();
    renderPlanMarkers();
    if (state.activePhotoId === photo.id)
      document.getElementById('edit-photo-bearing').value = Math.round(bearing);
    scheduleCacheSave();
  };

  viewport.style.cursor = 'crosshair';
  viewport.addEventListener('mousemove', onMove);
  viewport.addEventListener('click', onClick, true); // capture: avant les pins SVG
  setStepBanner(
    'Cliquez sur le plan pour définir la direction de la photo.',
    [{ label: 'Annuler', primary: false, action: cleanup }]
  );
}

function startMovePlanPhoto(photo) {
  const site = getActiveSite();
  if (!site) return;

  movePlanPhotoSiblings = findPhotoSiblings(photo)
    .map(id => site.photos.find(p => p.id === id))
    .filter(Boolean);

  planMoveGhostPos = {
    planX: photo.planX, planY: photo.planY,
    buildingId: photo.buildingId, floorId: photo.floorId, sitePlanId: photo.sitePlanId,
  };
  renderPlanMarkers();

  const viewport = document.getElementById('plan-viewport');
  let lastDragMoved = false;

  const onMouseDown = () => { lastDragMoved = false; };
  const onMouseMove = () => { lastDragMoved = true; };

  const cleanup = () => {
    viewport.style.cursor = '';
    viewport.removeEventListener('mousedown', onMouseDown);
    viewport.removeEventListener('mousemove', onMouseMove);
    viewport.removeEventListener('click', onClick, true);
    planMoveGhostPos      = null;
    movePlanPhotoSiblings = [];
    movePlanPhotoCleanup  = null;
    clearStepBanner();
    renderPlanMarkers();
  };

  const onClick = e => {
    if (lastDragMoved) return; // ignore drag-release
    e.stopPropagation();
    const rect     = viewport.getBoundingClientRect();
    const mx       = e.clientX - rect.left;
    const my       = e.clientY - rect.top;
    const newPlanX = (mx - plan.offsetX) / plan.scale;
    const newPlanY = (my - plan.offsetY) / plan.scale;
    movePlanPhotoSiblings.forEach(p => { p.planX = newPlanX; p.planY = newPlanY; });
    cleanup();
    scheduleCacheSave();
  };

  movePlanPhotoCleanup = cleanup;
  viewport.style.cursor = 'crosshair';
  viewport.addEventListener('mousedown', onMouseDown);
  viewport.addEventListener('mousemove', onMouseMove);
  viewport.addEventListener('click', onClick, true);
  setStepBanner(
    'Cliquez sur le plan pour déplacer ce point (toutes ses photos seront déplacées).',
    [{ label: 'Annuler', primary: false, action: cleanup }]
  );
}

function photoAddLabel(type) {
  if (type === 'panoramic') return '🌅 Ajouter une photo panoramique';
  if (type === '360')       return '🔵 Ajouter une photo 360°';
  return '📷 Ajouter une photo normale';
}

function addPhotoToPoint(photo) {
  if (photo.lat != null) {
    startAddPhotoAt(photo.lat, photo.lon, photo.type);
  } else {
    startAddPhotoOnPlan(photo.planX, photo.planY, photo.type);
  }
}

function initPlanEvents() {
  const viewport = document.getElementById('plan-viewport');

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    plan.offsetX = mx - (mx - plan.offsetX) * factor;
    plan.offsetY = my - (my - plan.offsetY) * factor;
    plan.scale  *= factor;
    drawPlanCanvas();
    renderPlanMarkers();
  }, { passive: false });

  let dragMoved = false;

  viewport.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    plan.dragging = true;
    dragMoved = false;
    plan.dragStart = { x: e.clientX - plan.offsetX, y: e.clientY - plan.offsetY };
  });

  window.addEventListener('mousemove', e => {
    if (!plan.dragging) return;
    const newX = e.clientX - plan.dragStart.x;
    const newY = e.clientY - plan.dragStart.y;
    if (Math.abs(newX - plan.offsetX) > 3 || Math.abs(newY - plan.offsetY) > 3) dragMoved = true;
    plan.offsetX = newX;
    plan.offsetY = newY;
    drawPlanCanvas();
    renderPlanMarkers();
  });

  window.addEventListener('mouseup', () => { plan.dragging = false; });

  // Right-click on plan viewport: add photo
  viewport.addEventListener('contextmenu', e => {
    e.preventDefault();
    const site = getActiveSite();
    if (!site || (!state.activeFloorId && !state.activeSitePlanId)) return;
    if (plan.dragging || dragMoved) return;

    document.getElementById('plan-click-menu')?.remove();

    const rect  = viewport.getBoundingClientRect();
    const mx    = e.clientX - rect.left;
    const my    = e.clientY - rect.top;
    const planX = (mx - plan.offsetX) / plan.scale;
    const planY = (my - plan.offsetY) / plan.scale;

    const menu = document.createElement('div');
    menu.id = 'plan-click-menu';
    menu.className = 'plan-click-menu';
    menu.style.left = mx + 'px';
    menu.style.top  = my + 'px';
    menu.innerHTML = `
      <button class="ctx-menu-btn" data-type="normal">📷 Photo normale (45°)</button>
      <button class="ctx-menu-btn" data-type="panoramic">🌅 Photo panoramique (120°)</button>
      <button class="ctx-menu-btn" data-type="360">🔵 Photo 360°</button>`;

    menu.querySelectorAll('[data-type]').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        menu.remove();
        startAddPhotoOnPlan(planX, planY, btn.dataset.type);
      });
    });

    viewport.appendChild(menu);
    setTimeout(() => {
      document.addEventListener('click', function closeMenu(ev) {
        if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener('click', closeMenu); }
      });
    }, 10);
  });
}

// ===== PHOTO ADDITION =====
function startAddPhotoAt(lat, lon, type) {
  pendingPhotoPos  = { lat, lon, buildingId: null, floorId: null, sitePlanId: null, planX: null, planY: null };
  pendingPhotoType = type;
  openAddPhotoModal(type);
}

function startAddPhotoOnPlan(planX, planY, type) {
  const buildingId = state.activeBuildingId || null;
  const floorId    = state.activeFloorId || null;
  const sitePlanId = state.activeSitePlanId || null;
  pendingPhotoPos  = { lat: null, lon: null, buildingId, floorId, sitePlanId, planX, planY };
  pendingPhotoType = type;
  openAddPhotoModal(type);
}

function updatePhotoFileList() {
  const list = document.getElementById('photo-file-list');
  if (!pendingPhotoFiles.length) { list.classList.add('hidden'); list.innerHTML = ''; return; }
  list.classList.remove('hidden');
  list.innerHTML = '';
  pendingPhotoFiles.forEach((f, i) => {
    const item = document.createElement('div');
    item.className = 'photo-file-item';
    const name = document.createElement('span');
    name.textContent = f.name;
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'btn-icon btn-sm'; btn.textContent = '✕';
    btn.addEventListener('click', () => { pendingPhotoFiles.splice(i, 1); updatePhotoFileList(); });
    item.appendChild(name); item.appendChild(btn);
    list.appendChild(item);
  });
}

function openAddPhotoModal(type) {
  const titles = { normal: 'Photo normale', panoramic: 'Photo panoramique (120°)', '360': 'Photo 360°' };
  document.getElementById('modal-add-photo-title').textContent = 'Ajouter : ' + (titles[type] || type);
  document.getElementById('input-new-photo-file').value = '';
  document.getElementById('new-photo-title').value = '';
  document.getElementById('new-photo-desc').value  = '';
  pendingPhotoFiles = [];
  updatePhotoFileList();
  showModal('modal-add-photo');
}

async function confirmAddPhoto() {
  const site = getActiveSite();
  if (!site || !pendingPhotoPos) return;
  if (!pendingPhotoFiles.length) { alert('Sélectionnez au moins une image.'); return; }

  const baseTitle = document.getElementById('new-photo-title').value.trim();
  const desc      = document.getElementById('new-photo-desc').value.trim();
  const type      = pendingPhotoType;
  const multi     = pendingPhotoFiles.length > 1;
  const pos       = { ...pendingPhotoPos };

  hideModal('modal-add-photo');
  pendingPhotoPos  = null;
  pendingPhotoType = null;

  // Inherit bearing from existing photos at the same point, if any
  const existingAtPoint = site.photos.filter(p => {
    if (pos.lat != null) return p.lat === pos.lat && p.lon === pos.lon;
    return p.planX === pos.planX && p.planY === pos.planY &&
           p.buildingId === pos.buildingId && p.floorId === pos.floorId &&
           p.sitePlanId === pos.sitePlanId;
  });
  const inheritedBearing = existingAtPoint.length > 0 ? (existingAtPoint[0].bearing ?? 0) : 0;

  const added = [];
  for (let i = 0; i < pendingPhotoFiles.length; i++) {
    const file    = pendingPhotoFiles[i];
    const dataURL = await fileToDataURL(file);
    const thumb   = await makeThumbnail(dataURL);
    const title   = baseTitle
      ? (multi ? `${baseTitle} ${i + 1}` : baseTitle)
      : file.name.replace(/\.[^.]+$/, '');
    const photo   = { id: uid(), type, title, description: desc, dataURL, thumbnail: thumb, bearing: inheritedBearing, ...pos };
    site.photos.push(photo);
    added.push(photo);
  }
  pendingPhotoFiles = [];

  if (added[0].lat != null) added.forEach(p => addPhotoMarker(p));
  else renderPlanMarkers();
  openViewer(added[0].id); // findPhotoSiblings inclut anciens + nouveaux
  scheduleCacheSave();
}

function deletePhoto(photoId) {
  const site = getActiveSite();
  if (!site || !confirm('Supprimer cette photo ?')) return;
  site.photos = site.photos.filter(p => p.id !== photoId);
  removePhotoMarker(photoId);
  renderPlanMarkers();
  scheduleCacheSave();

  const idx = viewerGallery.indexOf(photoId);
  if (idx < 0) { if (state.activePhotoId === photoId) closeViewer(); return; }
  viewerGallery.splice(idx, 1);
  if (!viewerGallery.length) { closeViewer(); return; }
  viewerGalleryIdx = Math.min(viewerGalleryIdx, viewerGallery.length - 1);
  const next = site.photos.find(p => p.id === viewerGallery[viewerGalleryIdx]);
  if (next) { state.activePhotoId = next.id; refreshMarkerActive(); _renderViewerPhoto(next); updateGalleryNav(); }
  else closeViewer();
}

// ===== VIEWER =====
function findPhotoSiblings(photo) {
  return _findPhotoSiblings(photo, getActiveSite()?.photos ?? []);
}

function openViewer(photoId, gallery = null) {
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === photoId);
  if (!photo) return;

  viewerGallery    = gallery ?? findPhotoSiblings(photo);
  viewerGalleryIdx = Math.max(0, viewerGallery.indexOf(photoId));
  state.activePhotoId = photoId;
  refreshMarkerActive();
  renderPlanMarkers();
  _renderViewerPhoto(photo);
  updateGalleryNav();
}

function _renderViewerPhoto(photo) {
  document.getElementById('viewer-panel').classList.remove('hidden');
  document.getElementById('viewer-title').textContent = photo.title || 'Photo';

  document.getElementById('classic-viewer').classList.add('hidden');
  document.getElementById('panorama-viewer').classList.add('hidden');
  if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }

  if (photo.type === '360') {
    document.getElementById('panorama-viewer').classList.remove('hidden');
    if (photo.dataURL) {
      pannellumViewer = pannellum.viewer('pannellum-container', {
        type: 'equirectangular', panorama: photo.dataURL, autoLoad: true, showControls: true,
        northOffset: photo.bearing || 0,
      });
    }
  } else {
    document.getElementById('classic-viewer').classList.remove('hidden');
    document.getElementById('classic-photo-img').src = photo.dataURL || '';
    document.getElementById('classic-photo-caption').textContent = photo.description || '';
  }

  document.getElementById('edit-photo-title').value = photo.title || '';
  document.getElementById('edit-photo-desc').value  = photo.description || '';
  document.getElementById('bearing-row').classList.remove('hidden');
  document.getElementById('edit-photo-bearing').value = Math.round(photo.bearing ?? 0);
}

function updateGalleryNav() { _updateGalleryNav(viewerGallery, viewerGalleryIdx); }

function navigateGallery(delta) {
  const site = getActiveSite();
  if (!site || !viewerGallery.length) return;
  viewerGalleryIdx = ((viewerGalleryIdx + delta) + viewerGallery.length) % viewerGallery.length;
  const photo = site.photos.find(p => p.id === viewerGallery[viewerGalleryIdx]);
  if (!photo) return;
  state.activePhotoId = photo.id;
  refreshMarkerActive();
  renderPlanMarkers();
  _renderViewerPhoto(photo);
  updateGalleryNav();
}

function closeViewer() {
  state.activePhotoId  = null;
  viewerGallery        = [];
  viewerGalleryIdx     = 0;
  document.getElementById('viewer-panel').classList.add('hidden');
  if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }
  refreshMarkerActive();
  renderPlanMarkers();
}

// ===== PHOTO EDITOR =====
function applyEditorChanges() {
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === state.activePhotoId);
  if (!photo) return;
  photo.title       = document.getElementById('edit-photo-title').value;
  photo.description = document.getElementById('edit-photo-desc').value;
  document.getElementById('viewer-title').textContent = photo.title || 'Photo';
}

function applyBearingChange() {
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === state.activePhotoId);
  if (!photo) return;

  const raw = document.getElementById('edit-photo-bearing').value;
  photo.bearing = raw === '' ? 0 : ((parseFloat(raw) % 360) + 360) % 360;
  document.getElementById('edit-photo-bearing').value = Math.round(photo.bearing);

  if (photo.lat != null) refreshPhotoMarker(photo.id);
  else renderPlanMarkers();
}

// ===== SITE FORM HELPERS =====
function renderSfIconBank() {
  renderIconBank('sf-icon-bank', SITE_ICONS, sfTempIcon, icon => { sfTempIcon = icon; });
}

function renderBfIconBank() {
  renderIconBank('bf-icon-bank', BUILDING_ICONS, bfTempIcon, icon => { bfTempIcon = icon; });
}

function renderIconBank(containerId, icons, selected, onSelect) {
  const bank = document.getElementById(containerId);
  bank.innerHTML = '';
  icons.forEach(icon => {
    const btn = document.createElement('button');
    btn.className = 'icon-bank-btn' + (icon === selected ? ' selected' : '');
    btn.textContent = icon;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      onSelect(icon);
      bank.querySelectorAll('.icon-bank-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    bank.appendChild(btn);
  });
}

function updateSfIllustrationPreview(dataURL) {
  const p = document.getElementById('sf-illustration-preview');
  p.innerHTML = dataURL
    ? `<img class="illus-img" src="${dataURL}" alt="Illustration" />`
    : '<div class="illus-empty">Aucune illustration</div>';
}

function renderSfContacts() {
  const list = document.getElementById('sf-contacts-list');
  list.innerHTML = '';
  sfTempContacts.forEach((c, i) => {
    const row = document.createElement('div');
    row.className = 'contact-row';
    row.innerHTML = `
      <input class="input-field c-name"     type="text"  placeholder="Nom"      value="${escapeAttr(c.name     || '')}" />
      <input class="input-field c-fonction" type="text"  placeholder="Fonction" value="${escapeAttr(c.fonction || '')}" />
      <input class="input-field c-phone"    type="text"  placeholder="Tél."     value="${escapeAttr(c.phone    || '')}" />
      <input class="input-field c-email"    type="email" placeholder="Email"    value="${escapeAttr(c.email    || '')}" />
      <button class="btn-icon btn-sm" type="button" title="Supprimer">✕</button>`;
    row.querySelectorAll('input').forEach(inp => {
      inp.addEventListener('input', () => {
        sfTempContacts[i].name     = row.querySelector('.c-name').value;
        sfTempContacts[i].fonction = row.querySelector('.c-fonction').value;
        sfTempContacts[i].phone    = row.querySelector('.c-phone').value;
        sfTempContacts[i].email    = row.querySelector('.c-email').value;
      });
    });
    row.querySelector('button').addEventListener('click', () => {
      sfTempContacts.splice(i, 1);
      renderSfContacts();
    });
    list.appendChild(row);
  });
}

// ===== INIT =====
function init() {
  initMap();
  initSearch();
  initPlanEvents();

  // ---- Top bar ----
  document.getElementById('btn-load-site').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.cado,.json';
    inp.onchange = e => {
      const file = e.target.files[0];
      if (!file) return;
      if (state.activeSiteId) {
        pendingLoadFile = file;
        document.getElementById('close-site-name').textContent = getActiveSite()?.name || 'ce site';
        showModal('modal-close-site');
      } else {
        loadSiteFromFile(file);
      }
    };
    inp.click();
  });
  document.getElementById('btn-save-site').addEventListener('click', saveSite);
  document.getElementById('btn-close-site').addEventListener('click', closeSite);
  document.getElementById('link-cadotour').addEventListener('click', e => {
    if (!state.activeSiteId) return;
    e.preventDefault();
    pendingNavigateUrl = 'cadotour.html';
    document.getElementById('close-site-name').textContent = getActiveSite()?.name || 'ce site';
    showModal('modal-close-site');
  });

  document.getElementById('btn-close-save').addEventListener('click',    () => _doCloseSite(true));
  document.getElementById('btn-close-discard').addEventListener('click', () => _doCloseSite(false));
  document.getElementById('btn-close-cancel').addEventListener('click',  () => {
    pendingLoadFile    = null;
    pendingNavigateUrl = null;
    hideModal('modal-close-site');
  });

  // ---- Sidebar ----
  document.getElementById('btn-deselect-site').addEventListener('click', deselectSite);
  document.getElementById('btn-site-options').addEventListener('click', () => {
    if (state.activeSiteId) openSiteForm(state.activeSiteId);
  });

  // ---- Site form ----
  document.getElementById('btn-sf-confirm').addEventListener('click', confirmSiteForm);
  document.getElementById('btn-sf-cancel').addEventListener('click', () => hideModal('modal-site-form'));
  document.getElementById('btn-sf-add-contact').addEventListener('click', () => {
    sfTempContacts.push({ id: uid(), name: '', fonction: '', phone: '', email: '' });
    renderSfContacts();
  });
  document.getElementById('btn-sf-illustration').addEventListener('click', () => {
    document.getElementById('input-sf-illustration').click();
  });
  document.getElementById('input-sf-illustration').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    sfTempIllustration = await fileToDataURL(file);
    updateSfIllustrationPreview(sfTempIllustration);
  });
  document.getElementById('btn-sf-clear-illustration').addEventListener('click', () => {
    sfTempIllustration = null;
    updateSfIllustrationPreview(null);
  });

  document.getElementById('btn-sf-redefine-perimeter').addEventListener('click', () => {
    const siteId = sfEditingId;
    hideModal('modal-site-form');
    if (siteId) startPerimeterDraw(siteId);
  });

  // ---- Building form ----
  document.getElementById('btn-bf-confirm').addEventListener('click', confirmBuildingForm);
  document.getElementById('btn-bf-cancel').addEventListener('click', () => hideModal('modal-add-building'));

  // ---- Add floor modal ----
  document.getElementById('btn-create-floor').addEventListener('click', confirmAddFloor);
  document.getElementById('btn-cancel-add-floor').addEventListener('click', () => hideModal('modal-add-floor'));

  // ---- Add site plan modal ----
  document.getElementById('btn-create-siteplan').addEventListener('click', confirmAddSitePlan);
  document.getElementById('btn-cancel-add-siteplan').addEventListener('click', () => hideModal('modal-add-siteplan'));

  // ---- Add photo modal ----
  document.getElementById('btn-confirm-add-photo').addEventListener('click', confirmAddPhoto);
  document.getElementById('btn-cancel-add-photo').addEventListener('click', () => {
    hideModal('modal-add-photo');
    pendingPhotoPos = null; pendingPhotoType = null; pendingPhotoFiles = [];
  });

  // ---- Plan image upload ----
  document.getElementById('btn-upload-plan').addEventListener('click', () => {
    document.getElementById('input-upload-plan').click();
  });
  document.getElementById('input-upload-plan').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const dataURL = await fileToDataURL(file);
    updateActivePlanImage(dataURL);
  });

  // ---- Viewer / editor ----
  document.getElementById('btn-close-viewer').addEventListener('click', closeViewer);
  document.getElementById('edit-photo-title').addEventListener('blur', applyEditorChanges);
  document.getElementById('edit-photo-desc').addEventListener('blur', applyEditorChanges);
  document.getElementById('edit-photo-bearing').addEventListener('change', applyBearingChange);
  document.getElementById('btn-clear-bearing').addEventListener('click', () => {
    document.getElementById('edit-photo-bearing').value = 0;
    applyBearingChange();
  });

  document.getElementById('btn-edit-photo-file').addEventListener('click', () => {
    document.getElementById('input-edit-photo-file').click();
  });
  document.getElementById('input-edit-photo-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file || !state.activePhotoId) return;
    const site  = getActiveSite();
    const photo = site?.photos.find(p => p.id === state.activePhotoId);
    if (!photo) return;
    photo.dataURL   = await fileToDataURL(file);
    photo.thumbnail = await makeThumbnail(photo.dataURL);
    openViewer(photo.id);
  });

  document.getElementById('btn-delete-photo').addEventListener('click', () => {
    if (state.activePhotoId) deletePhoto(state.activePhotoId);
  });

  // ---- Modal backdrop ----
  document.getElementById('modal-backdrop').addEventListener('click', () => {
    const modalIds = ['modal-site-form','modal-add-photo','modal-add-floor',
                      'modal-add-building','modal-add-siteplan','modal-step-prompt'];
    modalIds.forEach(id => {
      if (!document.getElementById(id).classList.contains('hidden')) hideModal(id);
    });
  });

  // ---- Keyboard ----
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      hideMapContextMenu();
      if      (interactionMode === 'perimeter-draw')       cancelPerimeter();
      else if (interactionMode === 'access-arrow')         cancelAccessArrow();
      else if (interactionMode === 'move-photo')           cancelMovePhoto();
      else if (interactionMode === 'orient-photo')         cancelOrientPhoto();
      else if (interactionMode === 'move-building')        cancelMoveBuilding();
      else if (interactionMode === 'move-site')            cancelMoveSite();
      else if (interactionMode === 'orient-access-arrow') { clearStepBanner(); interactionMode = null; }
    }
  });

  // Hide context menu on map click (non-interaction)
  document.getElementById('map').addEventListener('click', () => {
    if (!interactionMode) hideMapContextMenu();
  });

  renderSiteHeader();
  renderSidebar();

  // ---- Galerie : navigation + plein écran ----
  document.getElementById('btn-viewer-prev').addEventListener('click', () => navigateGallery(-1));
  document.getElementById('btn-viewer-next').addEventListener('click', () => navigateGallery(+1));
  document.getElementById('btn-viewer-fullscreen').addEventListener('click', () => {
    const wrap = document.getElementById('viewer-media-wrap');
    if (!document.fullscreenElement) wrap.requestFullscreen?.();
    else document.exitFullscreen?.();
  });
  const _onFsChange = () => {
    const btn = document.getElementById('btn-viewer-fullscreen');
    if (document.fullscreenElement) {
      btn.textContent = '✕';
      btn.title = 'Quitter le plein écran';
    } else {
      btn.textContent = '⛶';
      btn.title = 'Plein écran';
    }
  };
  document.addEventListener('fullscreenchange', _onFsChange);
  document.addEventListener('webkitfullscreenchange', _onFsChange);

  // ---- Zone de dépôt photos ----
  const dropZone  = document.getElementById('photo-drop-zone');
  const fileInput = document.getElementById('input-new-photo-file');
  document.getElementById('btn-pick-photos').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    pendingPhotoFiles.push(...Array.from(e.target.files));
    e.target.value = '';
    updatePhotoFileList();
  });
  dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    pendingPhotoFiles.push(...Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')));
    updatePhotoFileList();
  });

  // ---- Cache auto-save (IndexedDB) ----
  setInterval(() => { if (state.sites.length) saveCacheNow(); }, 4000);
  window.addEventListener('beforeunload', () => { if (state.sites.length) saveCacheNow(); });
  checkCacheRestore();
}

document.addEventListener('DOMContentLoaded', init);
