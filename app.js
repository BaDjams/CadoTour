// app.js — CadoCreator
import {
  escapeHtml, escapeAttr,
  findPointByPhotoId,
  makeSiteMarkerIcon,
  makeBuildingMarkerIcon as _makeBuildingMarkerIcon,
  drawPlanCanvas as _drawPlanCanvas,
  getActivePlan as _getActivePlan,
  updateGalleryNav as _updateGalleryNav,
} from './shared.js';
import { initDrawing } from './drawing.js';
import { SITE_ICONS, BUILDING_ICONS, renderIcon } from './icons.js';
import * as imageStore from './imageStore.js';
import * as progress from './progress.js';
import { initViewerSplitter, showResizer, hideResizer } from './splitter.js';
import * as fflate from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';
import { ZipReader, BlobReader, BlobWriter, TextWriter } from 'https://cdn.jsdelivr.net/npm/@zip.js/zip.js@2.7.55/+esm';

// ===== CACHE (IndexedDB — pas de limite de taille) =====
const DB_STORE = imageStore.STORE_STATE_NAME;
let _saveTimer = null;
// IDs des sites chargés depuis .cado qui ont été réellement modifiés depuis
// leur chargement (ajout photo, dessin, suppression…). Seuls ceux-ci sont
// persistés : un .cado ouvert sans modification n'a pas besoin de failsafe
// car l'utilisateur peut simplement le recharger.
const _modifiedZipSites    = new Set();
const _zipSiteDeletedPhotos = new Map(); // siteId → Set<photoId> originales supprimées
let   _pendingRestore = null;            // données pré-chargées pour le modal de restauration

async function _openDB() { return imageStore.openDB(); }

function scheduleCacheSave() {
  clearTimeout(_saveTimer);
  // Marquer le site actif comme modifié s'il vient d'un .cado
  const site = getActiveSite?.();
  if (site && siteZipSources.has(site.id)) _modifiedZipSites.add(site.id);
  _saveTimer = setTimeout(saveCacheNow, 1500);
}

async function saveCacheNow() {
  if (!state.sites.length) return;
  try {
    const db = await _openDB();
    const tx = db.transaction(DB_STORE, 'readwrite');
    // Sites .cado : inclus uniquement s'ils ont été modifiés depuis le chargement.
    // _cadoFilename + _deletedPhotoIds permettent le rechargement complet au réveil.
    const serializable = state.sites
      .filter(s => !siteZipSources.has(s.id) || _modifiedZipSites.has(s.id))
      .map(s => {
        if (!siteZipSources.has(s.id)) return s;
        const deletedIds = _zipSiteDeletedPhotos.get(s.id);
        return {
          ...s,
          _cadoFilename:    siteZipSources.get(s.id)?.filename || null,
          _deletedPhotoIds: deletedIds ? [...deletedIds] : [],
          points: (s.points || []).map(pt => ({
            ...pt,
            photos: (pt.photos || []).filter(ph => ph.imageId),
          })),
        };
      });
    if (!serializable.length) return;
    tx.objectStore(DB_STORE).put(JSON.stringify(serializable), 'sites');
  } catch (e) { console.warn('Cache save failed:', e); }
}

async function clearCacheState() {
  clearTimeout(_saveTimer);
  try {
    const db = await _openDB();
    db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete('sites');
  } catch (e) { console.warn('Cache clear failed:', e); }
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
    const validSites = sites.filter(s => Array.isArray(s.points));
    if (!validSites.length) { clearCacheState(); return; }

    // Pré-charge tous les handles depuis IDB avant d'afficher le modal.
    // Nécessaire car requestPermission() exige un geste utilisateur — les handles
    // doivent être en mémoire pour y accéder directement depuis le clic du bouton.
    const zipEntries = [];
    const pureSites  = [];
    for (const s of validSites) {
      if (s._deletedPhotoIds !== undefined) {
        const handle = await imageStore.getZipHandle(s.id);
        zipEntries.push({ cachedSite: s, handle });
      } else {
        pureSites.push(s);
      }
    }

    _pendingRestore = { zipEntries, pureSites };
    _showRestoreModal(zipEntries, pureSites);
  } catch (e) { console.warn('Cache restore failed:', e); }
}

function _showRestoreModal(zipEntries, pureSites) {
  const list = document.getElementById('restore-session-list');
  list.innerHTML = '';

  for (const { cachedSite, handle } of zipEntries) {
    const adds  = (cachedSite.points || [])
      .flatMap(p => (p.photos || []).filter(ph => ph.imageId && !ph.imageFile)).length;
    const dels  = (cachedSite._deletedPhotoIds || []).length;
    const draws = _countCachedDrawings(cachedSite);
    const parts = [];
    if (adds)  parts.push(`+${adds} photo${adds > 1 ? 's' : ''}`);
    if (dels)  parts.push(`-${dels} suppression${dels > 1 ? 's' : ''}`);
    if (draws) parts.push(`${draws} dessin${draws > 1 ? 's' : ''}`);
    const filename = cachedSite._cadoFilename || cachedSite.name || 'fichier .cado';
    const badge    = handle
      ? '<span style="color:var(--color-success,#22c55e)">↺ rechargé depuis le fichier</span>'
      : '<span style="color:var(--color-warning,#f59e0b)">⚠ restauration partielle</span>';
    const detail = parts.length ? ` — ${parts.join(', ')}` : '';
    const row = document.createElement('p');
    row.style.cssText = 'margin:4px 0;font-size:13px;line-height:1.4';
    row.innerHTML = `<strong>${escapeHtml(filename)}</strong>${escapeHtml(detail)}<br><small>${badge}</small>`;
    list.appendChild(row);
  }

  for (const s of pureSites) {
    const row = document.createElement('p');
    row.style.cssText = 'margin:4px 0;font-size:13px';
    row.textContent = s.name || 'Site sans nom';
    list.appendChild(row);
  }

  showModal('modal-restore-session');
}

function _countCachedDrawings(site) {
  let n = 0;
  const count = layers => (layers || []).forEach(l => n += (l.shapes || []).length);
  count(site.mapDrawingLayers);
  for (const bld of site.buildings || [])
    for (const fl of bld.floors || []) count(fl.layers);
  for (const sp of site.sitePlans || []) count(sp.layers);
  return n;
}

// Fusionne les modifications en cache sur un site rechargé depuis le .cado d'origine.
function _applyZipDelta(freshSite, cachedSite) {
  const deletedPhotoIds = new Set(cachedSite._deletedPhotoIds || []);
  const cachedPtById   = new Map((cachedSite.points || []).map(p => [p.id, p]));
  const freshPtIds     = new Set((freshSite.points  || []).map(p => p.id));

  // Points supprimés : présents dans le fresh mais absents du cache
  freshSite.points = (freshSite.points || [])
    .filter(pt => cachedPtById.has(pt.id))
    .map(pt => {
      const cached = cachedPtById.get(pt.id);
      // Photos originales non supprimées — préférer la version cache (a imageId + métadonnées à jour)
      const keptOriginals = pt.photos
        .filter(ph => !deletedPhotoIds.has(ph.id))
        .map(ph => cached.photos.find(c => c.id === ph.id) ?? ph);
      // Photos ajoutées par l'utilisateur : imageId présent, pas de imageFile
      const addedPhotos = cached.photos.filter(ph => ph.imageId && !ph.imageFile);
      return { ...pt, ...cached, photos: [...keptOriginals, ...addedPhotos] };
    });

  // Points créés par l'utilisateur : dans le cache mais pas dans le .cado d'origine
  for (const pt of cachedSite.points || []) {
    if (!freshPtIds.has(pt.id)) freshSite.points.push(pt);
  }

  // Calques de dessin sur les étages
  const cachedBldById = new Map((cachedSite.buildings || []).map(b => [b.id, b]));
  for (const bld of freshSite.buildings || []) {
    const cBld = cachedBldById.get(bld.id);
    if (!cBld) continue;
    const cFlById = new Map((cBld.floors || []).map(f => [f.id, f]));
    for (const fl of bld.floors || []) {
      const cFl = cFlById.get(fl.id);
      if (cFl?.layers) fl.layers = cFl.layers;
    }
  }

  // Calques de dessin sur les plans de site
  const cachedSpById = new Map((cachedSite.sitePlans || []).map(s => [s.id, s]));
  for (const sp of freshSite.sitePlans || []) {
    const cSp = cachedSpById.get(sp.id);
    if (cSp?.layers) sp.layers = cSp.layers;
  }

  // Calques de dessin sur la carte extérieure
  if ((cachedSite.mapDrawingLayers || []).length) {
    freshSite.mapDrawingLayers = cachedSite.mapDrawingLayers;
  }
}

// Ouvre un fichier .cado via File System Access API (showOpenFilePicker) si disponible,
// sinon via <input type="file"> classique. Retourne {file, handle} ou null si annulé.
async function _pickCadoFile() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'Fichier CadoTour', accept: {
          'application/octet-stream': ['.cado'],
          'application/json':         ['.json'],
        }}],
        multiple: false,
      });
      return { file: await handle.getFile(), handle };
    } catch (e) {
      if (e.name === 'AbortError') return null;
      // Navigateur partiellement compatible — fallback silencieux
    }
  }
  return new Promise(resolve => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.accept = '.cado,.json';
    inp.onchange = e => resolve(e.target.files[0] ? { file: e.target.files[0], handle: null } : null);
    inp.addEventListener('cancel', () => resolve(null));
    inp.click();
  });
}

function countSiteImages(site) {
  let n = 0;
  if (site.illustrationId || site.illustrationFile || (typeof site.illustration === 'string' && site.illustration.startsWith('data:'))) n++;
  for (const sp of site.sitePlans || []) if (sp.imageId || sp.imageFile || sp.imageDataURL) n++;
  for (const bld of site.buildings || []) {
    for (const fl of bld.floors || []) if (fl.imageId || fl.imageFile || fl.imageDataURL) n++;
  }
  for (const pt of site.points || []) {
    for (const ph of pt.photos || []) if (ph.imageId || ph.imageFile || ph.dataURL) n++;
  }
  return n;
}

// Compte uniquement les images extraites au chargement (lazy load) :
// illustration + plans de site + plans d'étage. Les photos des points sont
// extraites à la demande et ne participent pas à la barre de progression du load.
function countEagerImages(site) {
  let n = 0;
  if (site.illustrationId || site.illustrationFile || (typeof site.illustration === 'string' && site.illustration.startsWith('data:'))) n++;
  for (const sp of site.sitePlans || []) if (sp.imageId || sp.imageFile || sp.imageDataURL) n++;
  for (const bld of site.buildings || []) {
    for (const fl of bld.floors || []) if (fl.imageId || fl.imageFile || fl.imageDataURL) n++;
  }
  return n;
}

async function normalizeSite(data, onProgress = () => {}) {
  data.address      = data.address      || '';
  data.contacts     = data.contacts     || [];
  data.icon         = data.icon         || 'landmark';
  data.buildings    = data.buildings    || [];
  data.sitePlans    = data.sitePlans    || [];
  data.points       = data.points       || [];
  data.perimeter         = data.perimeter         || null;
  data.accessArrow       = data.accessArrow       || null;
  data.mapDrawingLayers  = data.mapDrawingLayers  || [];
  delete data.photos; // ancien champ — modèle obsolète
  delete data.floors; // ancien champ — modèle obsolète

  let done = 0;
  const tick = () => { done++; onProgress(done); };

  // Migration : illustration en dataURL → Blob + illustrationId
  if (typeof data.illustration === 'string' && data.illustration.startsWith('data:')) {
    data.illustrationId = await imageStore.migrateDataURL(data.illustration);
    delete data.illustration;
    tick();
  } else if (data.illustration && typeof data.illustration === 'object') {
    // garde-fou : ancien format objet → drop
    delete data.illustration;
  }

  // Migration : floor.imageDataURL → floor.imageId
  for (const bld of data.buildings) {
    bld.floors = bld.floors || [];
    for (const floor of bld.floors) {
      if (floor.imageDataURL) {
        floor.imageId = await imageStore.migrateDataURL(floor.imageDataURL);
        delete floor.imageDataURL;
        tick();
      }
    }
  }

  // Migration : sitePlan.imageDataURL → sitePlan.imageId
  for (const sp of data.sitePlans) {
    if (sp.imageDataURL) {
      sp.imageId = await imageStore.migrateDataURL(sp.imageDataURL);
      delete sp.imageDataURL;
      tick();
    }
  }

  // Migration : photos[].dataURL → photos[].imageId (et drop des thumbnails inutilisés)
  for (const pt of data.points) {
    if (pt.bearing == null) pt.bearing = 0;
    pt.photos = pt.photos || [];
    for (const ph of pt.photos) {
      if (ph.dataURL) {
        ph.imageId = await imageStore.migrateDataURL(ph.dataURL);
        delete ph.dataURL;
        tick();
      }
      delete ph.thumbnail;
    }
  }
}

// ===== STATE =====
let state = {
  sites: [],
  activeSiteId: null,
  activeBuildingId: null,   // building currently open in plan view
  activeFloorId: null,       // floor within that building
  activeSitePlanId: null,    // site plan currently open
  activePointId: null,       // point currently open in the viewer
  activePhotoId: null,       // photo within that point currently shown
  viewMode: 'map',           // 'map' | 'plan'
};

// ===== MAP =====
let map = null;
let baseLayers      = {};
let mbtilesLayer    = null;
let siteMarkers     = {};   // siteId      -> L.Marker
let buildingMarkers = {};   // buildingId  -> L.Marker
let pointMarkers    = {};   // pointId     -> L.Marker
let searchResultMarker = null;
let perimeterLayer  = null;
let accessArrowMarker = null;

// Sources ZIP des sites chargés en lazy : le ZipReader reste ouvert tant que
// le site est en mémoire pour permettre l'extraction des photos à la demande.
//   siteId → { reader: ZipReader, entries: Map<filename, Entry> }
const siteZipSources = new Map();
// Dédup des extractions concurrentes : si plusieurs callers résolvent la
// même photo simultanément (clic + preload navigation), une seule extraction.
const _lazyExtractionPending = new Map(); // photo → Promise<imageId>

async function _ensurePhotoImageId(photo, siteId) {
  if (photo.imageId) return photo.imageId;
  if (!photo.imageFile) return null;
  if (_lazyExtractionPending.has(photo)) return _lazyExtractionPending.get(photo);
  const promise = (async () => {
    const bundle = siteZipSources.get(siteId);
    if (!bundle) return null;
    const entry = bundle.entries.get(photo.imageFile);
    if (!entry) return null;
    const mime = photo.imageMime || 'application/octet-stream';
    const blob = await entry.getData(new BlobWriter(mime));
    photo.imageId = await imageStore.putBlob(blob);
    // On garde imageFile/imageMime pour permettre la passe-through au save
    // (si le user n'édite jamais la photo, on évite l'aller-retour IDB).
    return photo.imageId;
  })();
  _lazyExtractionPending.set(photo, promise);
  try { return await promise; }
  finally { _lazyExtractionPending.delete(photo); }
}

async function _closeSiteZipSource(siteId) {
  const bundle = siteZipSources.get(siteId);
  if (!bundle) return;
  siteZipSources.delete(siteId);
  _modifiedZipSites.delete(siteId);
  _zipSiteDeletedPhotos.delete(siteId);
  imageStore.deleteZipHandle(siteId).catch(() => {});
  try { await bundle.reader.close(); } catch { /* swallow */ }
}

// ===== INTERACTION MODE =====
// 'perimeter-draw' | 'access-arrow' | 'move-point' | 'orient-point' | 'move-building' | 'move-site' | null
let interactionMode  = null;
let interactionSiteId = null;
let movePointId      = null;
let orientPointId    = null;
let moveBuildingId   = null;
let moveSiteId       = null;
let perimeterPoints  = [];
let perimeterPolyline = null;
let perimeterRubberBand = null;
let perimeterFirstMarker = null;
let orientLine       = null;

// ===== FLOOR PLAN =====
let plan = { img: null, scale: 1, offsetX: 0, offsetY: 0, dragging: false, dragStart: null };

// ===== DRAWING =====
let drawing; // initialized in init()

// ===== PANNELLUM =====
let pannellumViewer = null;

// ===== VIEWER GALLERY =====
let viewerGalleryIdx = 0;

// ===== PENDING LOAD / NAVIGATION =====
let pendingLoadFile    = null;
let pendingLoadHandle  = null;
let pendingNavigateUrl = null;

// ===== PHOTO ADDITION =====
// { kind: 'new', type, position: {lat,lon} | {planX,planY,buildingId,floorId,sitePlanId} }
// { kind: 'existing', pointId }
let pendingPhotoTarget = null;
let pendingPhotoFiles  = [];

// ===== PLAN POINT MOVE =====
let planMovePointId   = null;
let planMoveCleanup   = null;

// ===== SITE FORM TEMP =====
let sfEditingId = null;
let sfTempContacts = [];
let sfTempIcon = 'landmark';
let sfTempIllustration = undefined;

// ===== BUILDING FORM TEMP =====
let bfTempLat = null;
let bfTempLon = null;
let bfTempIcon = 'building';

// ===== FLOOR FORM TEMP =====
let addFloorBuildingId = null;

// ===== BUILDING EDIT TEMP =====
let editBuildingId = null;

// ===== SEARCH =====
let searchTimer = null;

// ===== STEP PROMPT QUEUE =====
let stepQueue = [];

// ===== CONSTANTS =====
const CLUSTER_ZOOM_THRESHOLD = 17;

// SITE_ICONS / BUILDING_ICONS sont désormais importés depuis ./icons.js (SVG Lucide-like).
// Ancienne version emoji conservée ci-dessous pour pouvoir re-basculer rapidement.
//
// const SITE_ICONS = [
//   '🏘','🏙','🏭','🏬','🏥','🏫','🌾','🌲','🏛','🚂',
//   '✈','⚓','🏖','🏔','🌊','⚡','🎡','🏟','🏕','🔥',
// ];
//
// const BUILDING_ICONS = [
//   '🏠','🏡','🏘','🏢','🏗','🏫','🏥','🏨','🏪','🏬',
//   '🏦','🏤','🏭','📦','🌾','🏟','🎭','🎪','⛪','🕌',
//   '🛕','🕍','🏛','🏰','🚒','⛽','🅿',
// ];

// ===== HELPERS =====
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function getActiveSite() {
  return state.sites.find(s => s.id === state.activeSiteId) || null;
}

function getActivePoint() {
  const site = getActiveSite();
  if (!site || !state.activePointId) return null;
  return site.points.find(p => p.id === state.activePointId) || null;
}

function getActivePhoto() {
  const point = getActivePoint();
  if (!point || !state.activePhotoId) return null;
  return point.photos.find(ph => ph.id === state.activePhotoId) || null;
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
  const modalIds = ['modal-site-form','modal-add-photo','modal-add-floor',
                    'modal-add-building','modal-add-siteplan','modal-step-prompt','modal-close-site','modal-edit-building',
                    'modal-restore-session'];
  const anyOpen = modalIds.some(
    mid => mid !== id && !document.getElementById(mid).classList.contains('hidden')
  );
  if (!anyOpen) document.getElementById('modal-backdrop').classList.add('hidden');
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
      maxZoom: 21,
    }
  );

  map = L.map('map', { layers: [osmLayer] }).setView([46.6, 2.3], 6);

  baseLayers = { 'OpenStreetMap': osmLayer, 'Google Hybride': googleHybridLayer };
  L.control.layers(baseLayers, {}, { position: 'topright' }).addTo(map);

  const MbtilesLayer = L.TileLayer.extend({
    createTile(coords, done) {
      const tile = document.createElement('img');
      const url = window.tileSourceReadTile(coords.x, coords.y, coords.z);
      if (url) {
        tile.src = url;
        tile.onload  = () => { URL.revokeObjectURL(url); done(null, tile); };
        tile.onerror = () => { URL.revokeObjectURL(url); done(null, tile); };
      } else {
        done(null, tile);
      }
      return tile;
    }
  });

  window.tileSourceOnChange = function(info) {
    if (mbtilesLayer) { map.removeLayer(mbtilesLayer); mbtilesLayer = null; }
    if (info) {
      Object.values(baseLayers).forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
      const zooms = window.tileSourceGetZooms();
      mbtilesLayer = new MbtilesLayer('', { minZoom: zooms[0], maxZoom: zooms[zooms.length - 1] });
      mbtilesLayer.addTo(map);
      if (info.bounds) {
        const [w, s, e, n] = info.bounds;
        map.fitBounds([[s, w], [n, e]]);
      }
    } else {
      const def = baseLayers['OpenStreetMap'] || Object.values(baseLayers)[0];
      if (def && !map.hasLayer(def)) def.addTo(map);
    }
  };

  map.on('contextmenu', onMapRightClick);
  map.on('click', onMapClick);
  map.on('zoomend', updateMarkersVisibility);
}

// ===== MAP CLICK =====
function onMapClick(e) {
  if (interactionMode === 'perimeter-draw') { addPerimeterPoint(e.latlng);  return; }
  if (interactionMode === 'access-arrow')   { placeAccessArrow(e.latlng);   return; }
  if (interactionMode === 'move-point')     { commitMovePoint(e.latlng);    return; }
  if (interactionMode === 'orient-point')   { commitOrientPoint(e.latlng);  return; }
  if (interactionMode === 'move-building')  { commitMoveBuilding(e.latlng); return; }
  if (interactionMode === 'move-site')      { commitMoveSite(e.latlng);     return; }
  if (interactionMode === 'map-drawing')    { drawing.addMapPoint(e.latlng); return; }
  if (interactionMode === 'orient-access-arrow') return;
  hideMapContextMenu();
}

function onMapRightClick(e) {
  L.DomEvent.preventDefault(e.originalEvent);
  hideMapContextMenu();

  if (interactionMode) return;

  const latlng = e.latlng;
  const pt = e.containerPoint;

  if (!state.activeSiteId) {
    showMapContextMenu(pt, [
      { label: '📍 Créer un nouveau site ici', action: () => openSiteForm(null, latlng.lat, latlng.lng, '') },
    ]);
  } else {
    showMapContextMenu(pt, [
      { label: '📷 Photo normale (45°)',      action: () => startAddPhotoAt(latlng.lat, latlng.lng, 'normal') },
      { label: '🌅 Photo panoramique (120°)', action: () => startAddPhotoAt(latlng.lat, latlng.lng, 'panoramic') },
      { label: '🔵 Photo 360°',               action: () => startAddPhotoAt(latlng.lat, latlng.lng, '360') },
      { label: '🚁 Vue aérienne/drône',       action: () => startAddPhotoAt(latlng.lat, latlng.lng, 'drone') },
      { label: null },
      { label: '🏢 Ajouter un bâtiment ici', action: () => openBuildingForm(latlng.lat, latlng.lng) },
    ]);
  }
}

function onMapMousemove(e) {
  if (interactionMode === 'perimeter-draw' && perimeterPoints.length > 0) {
    if (perimeterRubberBand) { perimeterRubberBand.remove(); perimeterRubberBand = null; }
    const lastPt = perimeterPoints[perimeterPoints.length - 1];
    perimeterRubberBand = L.polyline([lastPt, [e.latlng.lat, e.latlng.lng]], {
      color: 'red', dashArray: '4 3', weight: 1.5, opacity: 0.5,
    }).addTo(map);
    return;
  }
  if (interactionMode !== 'orient-point') return;
  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === orientPointId);
  if (!point || point.lat == null) return;

  if (orientLine) { orientLine.remove(); orientLine = null; }
  orientLine = L.polyline([[point.lat, point.lon], [e.latlng.lat, e.latlng.lng]], {
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

  const mapEl = document.getElementById('map-container');
  let x = containerPoint.x;
  let y = containerPoint.y;

  menu.classList.remove('hidden');
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

// ===== PHOTO TYPE SELECTOR =====
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
function renderSfPerimeterSection(site) {
  const section = document.getElementById('sf-perimeter-section');
  section.innerHTML = '';

  const makeGroup = (labelText, btns) => {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'margin-bottom:10px';
    const lbl = document.createElement('div');
    lbl.className = 'modal-sub-label';
    lbl.textContent = labelText;
    wrap.appendChild(lbl);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap';
    btns.forEach(({ text, cls, onClick }) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = cls; b.textContent = text;
      b.addEventListener('click', onClick);
      row.appendChild(b);
    });
    wrap.appendChild(row);
    section.appendChild(wrap);
  };

  // ── Périmètre ──
  const perimBtns = [
    {
      text: site.perimeter ? '🗺 Redéfinir' : '🗺 Tracer le périmètre',
      cls: 'btn-secondary btn-sm',
      onClick: () => { hideModal('modal-site-form'); startPerimeterDraw(site.id); },
    },
  ];
  if (site.perimeter) {
    perimBtns.push({
      text: site.perimeterHidden ? '👁 Afficher' : '🚫 Masquer',
      cls: 'btn-secondary btn-sm',
      onClick: () => { toggleSitePerimeter(site); renderSfPerimeterSection(site); },
    });
    perimBtns.push({
      text: '🗑 Supprimer',
      cls: 'btn-danger btn-sm',
      onClick: () => { site.perimeter = null; renderSitePerimeter(site); renderSfPerimeterSection(site); },
    });
  }
  makeGroup('Périmètre du site', perimBtns);

  // ── Flèche d'accès ──
  const arrowBtns = [
    {
      text: site.accessArrow ? '↖ Repositionner' : '↖ Placer la flèche',
      cls: 'btn-secondary btn-sm',
      onClick: () => { hideModal('modal-site-form'); startAccessArrowPlacement(site.id); },
    },
  ];
  if (site.accessArrow) {
    arrowBtns.push({
      text: site.accessArrowHidden ? '👁 Afficher' : '🚫 Masquer',
      cls: 'btn-secondary btn-sm',
      onClick: () => { toggleSiteAccessArrow(site); renderSfPerimeterSection(site); },
    });
    arrowBtns.push({
      text: '🗑 Supprimer',
      cls: 'btn-danger btn-sm',
      onClick: () => { site.accessArrow = null; renderAccessArrow(site); renderSfPerimeterSection(site); },
    });
  }
  makeGroup('Flèche d\'accès principal', arrowBtns);
}

function openSiteForm(siteId, lat, lon, address) {
  sfEditingId = siteId;

  const site = siteId ? state.sites.find(s => s.id === siteId) : null;
  document.getElementById('modal-site-form-title').textContent = site ? 'Options du site' : 'Nouveau site';
  document.getElementById('btn-sf-confirm').textContent = site ? 'Sauvegarder' : 'Créer le site';
  document.getElementById('sf-perimeter-row').classList.toggle('hidden', !siteId);
  if (site) renderSfPerimeterSection(site);

  document.getElementById('sf-name').value    = site?.name    || '';
  document.getElementById('sf-address').value = site?.address || address || '';
  document.getElementById('sf-lat').value     = site?.lat ?? lat ?? '';
  document.getElementById('sf-lon').value     = site?.lon ?? lon ?? '';

  sfTempContacts     = JSON.parse(JSON.stringify(site?.contacts || []));
  sfTempIcon         = site?.icon || 'landmark';
  sfTempIllustration = undefined;

  renderSfIconBank();
  renderSfContacts();
  updateSfIllustrationPreview(site?.illustrationId || null);

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
      if (sfTempIllustration !== undefined) {
        if (site.illustrationId && site.illustrationId !== sfTempIllustration) {
          imageStore.deleteImage(site.illustrationId);
        }
        site.illustrationId = sfTempIllustration;
      }

      removeSiteMarker(site.id);
      addSiteMarker(site);
      updateMarkersVisibility();
      renderSidebar();
    }
    hideModal('modal-site-form');
    updateTopBarButtons();
    return;
  }

  if (isNaN(lat) || isNaN(lon)) { alert('Les coordonnées GPS sont requises.'); return; }
  const site = {
    id: uid(),
    name,
    address,
    lat,
    lon,
    icon: sfTempIcon,
    illustrationId: sfTempIllustration !== undefined ? sfTempIllustration : null,
    contacts: JSON.parse(JSON.stringify(sfTempContacts)),
    buildings: [],
    sitePlans: [],
    points: [],
    perimeter: null,
    accessArrow: null,
  };
  state.sites.push(site);
  addSiteMarker(site);
  selectSite(site.id);

  hideModal('modal-site-form');
  updateTopBarButtons();

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
    'Cliquez pour ajouter des points. Cliquez près du point de départ (⬤) pour fermer.',
    [
      { label: 'Fermer le périmètre', primary: true,  action: finishPerimeter },
      { label: 'Annuler',             primary: false, action: cancelPerimeter },
    ]
  );

  map.on('mousemove', onMapMousemove);
}

function addPerimeterPoint(latlng) {
  // Close the polygon when clicking near the first point (≥ 3 points already placed)
  if (perimeterPoints.length >= 3) {
    const px1 = map.latLngToContainerPoint(perimeterPoints[0]);
    const px2 = map.latLngToContainerPoint(latlng);
    if (Math.hypot(px1.x - px2.x, px1.y - px2.y) < 20) {
      finishPerimeter();
      return;
    }
  }

  perimeterPoints.push([latlng.lat, latlng.lng]);

  // Show the origin marker on first click
  if (perimeterPoints.length === 1) {
    perimeterFirstMarker = L.circleMarker([latlng.lat, latlng.lng], {
      radius: 7, color: 'white', weight: 2, fillColor: 'red', fillOpacity: 0.9,
    }).addTo(map);
  }

  if (perimeterPolyline) perimeterPolyline.remove();
  if (perimeterPoints.length >= 2) {
    perimeterPolyline = L.polyline(perimeterPoints, {
      color: 'red', dashArray: '8 6', weight: 2, opacity: 0.85,
    }).addTo(map);
  }
}

function finishPerimeter() {
  map.off('mousemove', onMapMousemove);
  clearStepBanner();
  document.getElementById('map').classList.remove('map-cursor-crosshair');

  if (perimeterRubberBand) { perimeterRubberBand.remove(); perimeterRubberBand = null; }
  if (perimeterFirstMarker) { perimeterFirstMarker.remove(); perimeterFirstMarker = null; }
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
  map.off('mousemove', onMapMousemove);
  clearStepBanner();
  document.getElementById('map').classList.remove('map-cursor-crosshair');
  if (perimeterRubberBand) { perimeterRubberBand.remove(); perimeterRubberBand = null; }
  if (perimeterFirstMarker) { perimeterFirstMarker.remove(); perimeterFirstMarker = null; }
  if (perimeterPolyline) { perimeterPolyline.remove(); perimeterPolyline = null; }
  interactionMode = null;
  perimeterPoints = [];
  runNextStep();
}

function renderSitePerimeter(site) {
  if (perimeterLayer) { perimeterLayer.remove(); perimeterLayer = null; }
  if (!site?.perimeter?.points?.length) return;
  if (site.perimeterHidden) return;
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

function toggleSitePerimeter(site) {
  site.perimeterHidden = !site.perimeterHidden;
  renderSitePerimeter(site);
}

function toggleSiteAccessArrow(site) {
  site.accessArrowHidden = !site.accessArrowHidden;
  renderAccessArrow(site);
}

function renderAccessArrow(site) {
  if (accessArrowMarker) { accessArrowMarker.remove(); accessArrowMarker = null; }
  if (!site?.accessArrow) return;
  if (site.accessArrowHidden) return;

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
async function loadSiteFromFile(file, handle = null) {
  try {
    const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const isZip  = header[0] === 0x50 && header[1] === 0x4B;

    let data;
    if (isZip) {
      data = await _loadSiteFromZip(file);
      if (!data) return;
      // Persiste le handle pour permettre le rechargement automatique au réveil
      if (handle && data.id) imageStore.putZipHandle(data.id, handle).catch(() => {});
    } else {
      let text;
      try { text = await file.text(); } catch (e) { throw new Error('Lecture impossible : ' + e.message); }
      try { data = JSON.parse(text); } catch (e) { throw new Error('JSON invalide : ' + e.message); }
      if (!Array.isArray(data.points)) {
        alert('Fichier .cado au format obsolète (avant le passage au modèle "points").\nCe fichier ne peut pas être ouvert avec cette version.');
        return;
      }
      const total = countSiteImages(data);
      progress.show(`Chargement de « ${data.name || 'le site'} »…`, total);
      try {
        await normalizeSite(data, cur => progress.update(cur));
      } finally {
        progress.hide();
      }
    }

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
    progress.hide();
    alert('Erreur de chargement : ' + err.message);
  }
}

// Lecture streaming via zip.js : pas de file.arrayBuffer(), donc pas de limite
// d'allocation ArrayBuffer (~2 GiB sous V8). zip.js lit le central dir en
// fin de fichier via Blob.slice() puis extrait chaque entrée à la demande.
// Le reader reste ouvert après la fonction tant que le site est en mémoire,
// car les photos sont en lazy load (extraites au premier viewing).
async function _loadSiteFromZip(file) {
  const reader = new ZipReader(new BlobReader(file));
  let success = false;
  let registeredSiteId = null;
  try {
    const entries = await reader.getEntries();
    const metaEntry = entries.find(e => e.filename === 'metadata.json');
    if (!metaEntry) throw new Error('metadata.json manquant dans le fichier .cado');
    const metaText = await metaEntry.getData(new TextWriter());
    const data = JSON.parse(metaText);

    if (!Array.isArray(data.points)) {
      alert('Fichier .cado ZIP au format obsolète.\nCe fichier ne peut pas être ouvert avec cette version.');
      return null;
    }

    const imageEntries = new Map();
    for (const e of entries) {
      if (e.filename.startsWith('images/')) imageEntries.set(e.filename.slice(7), e);
    }

    const total = countEagerImages(data);
    progress.show(`Chargement de « ${data.name || 'le site'} »…`, total);
    try {
      await _normalizeZipSite(data, imageEntries, cur => progress.update(cur));
    } finally {
      progress.hide();
    }

    // Si on recharge un site déjà ouvert, fermer son ancienne source ZIP.
    if (data.id && siteZipSources.has(data.id)) await _closeSiteZipSource(data.id);
    if (data.id) {
      siteZipSources.set(data.id, { reader, entries: imageEntries, filename: file.name });
      registeredSiteId = data.id;
    }
    success = true;
    return data;
  } catch (e) {
    throw new Error('Fichier .cado ZIP invalide : ' + e.message);
  } finally {
    // Ne fermer le reader que si on n'a pas réussi à l'enregistrer
    if (!success || !registeredSiteId) await reader.close();
  }
}

// Migre les références imageFile du format ZIP vers des Blobs IndexedDB.
// imageEntries: Map<filename, zip.js Entry> — chaque entry est lue à la demande
// via entry.getData(BlobWriter) → un seul Blob est en mémoire à la fois (par batch).
async function _normalizeZipSite(data, imageEntries, onProgress = () => {}) {
  data.address     = data.address     || '';
  data.contacts    = data.contacts    || [];
  data.icon        = data.icon        || 'landmark';
  data.buildings   = data.buildings   || [];
  data.sitePlans   = data.sitePlans   || [];
  data.points      = data.points      || [];
  data.perimeter        = data.perimeter        || null;
  data.accessArrow      = data.accessArrow      || null;
  data.mapDrawingLayers = data.mapDrawingLayers || [];

  let done = 0;
  const tick = () => { done++; onProgress(done); };

  // Buffer pour batcher les écritures IndexedDB. Chaque transaction IDB a un
  // overhead fixe (~2 ms open/commit) ; en groupant N puts dans une seule tx
  // on divise le coût total des I/O par ~N. Buffer flushé toutes les 32 entrées.
  const BATCH_SIZE = 32;
  const buffer = []; // { obj, idKey, blob }

  const flush = async () => {
    if (!buffer.length) return;
    const ids = await imageStore.putBlobs(buffer.map(b => b.blob));
    for (let i = 0; i < buffer.length; i++) {
      buffer[i].obj[buffer[i].idKey] = ids[i];
      tick();
    }
    buffer.length = 0;
  };

  const enqueue = async (obj, fileKey, mimeKey, idKey) => {
    const imageFile = obj[fileKey];
    if (!imageFile) return;
    const entry = imageEntries.get(imageFile);
    if (!entry) return;
    const mime = obj[mimeKey] || 'application/octet-stream';
    // zip.js extrait l'entrée directement en Blob (streaming) sans passer par
    // un Uint8Array intermédiaire en JS heap.
    const blob = await entry.getData(new BlobWriter(mime));
    imageEntries.delete(imageFile); // entry traitée, libère la référence
    const filenameKey = idKey.replace(/Id$/, 'Filename');
    obj[filenameKey] = imageFile;
    delete obj[fileKey]; delete obj[mimeKey];
    buffer.push({ obj, idKey, blob });
    if (buffer.length >= BATCH_SIZE) await flush();
  };

  // Eager : illustration, plans de site, plans d'étage. Petit nombre (~50 max)
  // et nécessaires à la navigation → extraits immédiatement vers IndexedDB.
  if (data.illustrationFile) await enqueue(data, 'illustrationFile', 'illustrationMime', 'illustrationId');
  for (const sp of data.sitePlans) await enqueue(sp, 'imageFile', 'imageMime', 'imageId');
  for (const bld of data.buildings) {
    bld.floors = bld.floors || [];
    for (const fl of bld.floors) await enqueue(fl, 'imageFile', 'imageMime', 'imageId');
  }
  await flush();

  // Lazy : photos des points. On laisse imageFile/imageMime sur l'objet ;
  // l'extraction se fera à la première ouverture dans le viewer ou à la save.
  for (const pt of data.points) {
    if (pt.bearing == null) pt.bearing = 0;
    pt.photos = pt.photos || [];
    for (const ph of pt.photos) {
      // imageFilename est utilisé par les boutons de download / le naming ZIP
      if (ph.imageFile && !ph.imageFilename) ph.imageFilename = ph.imageFile;
      delete ph.thumbnail;
    }
  }
}

// ===== ZIP EXPORT HELPERS =====

const _MIME_EXT = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp' };
function _mimeToExt(mime) { return _MIME_EXT[mime] || null; }

// ===== PHOTO COMPRESSION (Sprint 1) =====
// Recompresse les photos > 2 Mo en préservant l'aspect ratio.
// Une seule passe : resize + JPEG quality 0.85. Pas d'itération qualité — le
// gain marginal d'une 2e passe (2,001 Mo → 1,9 Mo) ne justifie pas la perte
// visuelle d'un step de qualité supplémentaire. Une photo peut donc dépasser
// 2 Mo en sortie, c'est ok.
// PNG sans alpha → converti en JPEG (gain massif). PNG avec alpha → reste PNG.
// 360° gardent une résolution plus haute (Pannellum dégrade sous ~4096 px).
const _COMP_SKIP_THRESHOLD = 2_000_000; // photos déjà sous ce seuil : laissées telles quelles
const _COMP_QUALITY        = 0.85;
const _COMP_MAX_EDGE_PHOTO = 2560;
const _COMP_MAX_EDGE_360   = 6144;

function _hasAlphaChannel(ctx, w, h) {
  // Scan strié (1 pixel sur 16) : suffisant pour détecter toute transparence
  // pratique (icônes, bordures antialias) sans la latence d'un scan complet.
  const data = ctx.getImageData(0, 0, w, h).data;
  for (let i = 3; i < data.length; i += 4 * 16) {
    if (data[i] < 255) return true;
  }
  return false;
}

function _changeFilenameExt(filename, newExt) {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  return stem + '.' + newExt;
}

// Renvoie { bytes, mime } si la photo a été recompressée, sinon null (à garder telle quelle).
async function _compressPhoto(arr, sourceMime, is360) {
  if (arr.byteLength <= _COMP_SKIP_THRESHOLD) return null;

  const sourceBlob = new Blob([arr], { type: sourceMime || 'application/octet-stream' });
  let bitmap;
  try { bitmap = await createImageBitmap(sourceBlob); }
  catch { return null; } // format non décodable → on garde l'original

  const maxEdge = is360 ? _COMP_MAX_EDGE_360 : _COMP_MAX_EDGE_PHOTO;
  let w = bitmap.width, h = bitmap.height;
  if (Math.max(w, h) > maxEdge) {
    const scale = maxEdge / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  // Détermine le format de sortie
  let targetMime = 'image/jpeg';
  if (sourceMime === 'image/png' && _hasAlphaChannel(ctx, w, h)) {
    targetMime = 'image/png'; // préserve la transparence
  } else if (sourceMime === 'image/webp') {
    targetMime = 'image/webp';
  }

  // Une seule passe d'encodage. La taille de sortie peut dépasser 2 Mo,
  // c'est accepté : redescendre plus bas demanderait un step de qualité
  // supplémentaire avec une perte visuelle disproportionnée vs le gain.
  const outBlob = targetMime === 'image/png'
    ? await canvas.convertToBlob({ type: 'image/png' })  // pas de quality pour PNG
    : await canvas.convertToBlob({ type: targetMime, quality: _COMP_QUALITY });

  const outBytes = new Uint8Array(await outBlob.arrayBuffer());
  return { bytes: outBytes, mime: targetMime };
}

function _sanitizeFilename(str) {
  return (str || '').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'fichier';
}

// nameFn peut être une chaîne ou une fonction (ext) => string.
async function _downloadImage(imageId, nameFn) {
  const blob = await imageStore.getBlob(imageId);
  if (!blob) return;
  const ext  = _mimeToExt(blob.type);
  const name = typeof nameFn === 'function' ? nameFn(ext) : (nameFn || (imageId + (ext ? '.' + ext : '')));
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// Collecte toutes les références d'images du site → Map<imageId, {filename, mime, blob}>.
// getBlob() renvoie un Blob sans charger les octets dans le heap V8 (juste un handle natif).
// Le nom de fichier dans le ZIP est le nom original (imageFilename) ou l'imageId en fallback.
// Les doublons de noms sont disambigués avec un suffixe (2), (3)…
async function _collectImageMap(site) {
  const map       = new Map();
  const usedNames = new Set();

  const uniqueName = preferred => {
    if (!usedNames.has(preferred)) { usedNames.add(preferred); return preferred; }
    const dot  = preferred.lastIndexOf('.');
    const stem = dot > 0 ? preferred.slice(0, dot) : preferred;
    const ext  = dot > 0 ? preferred.slice(dot)  : '';
    let n = 2;
    while (usedNames.has(`${stem} (${n})${ext}`)) n++;
    const name = `${stem} (${n})${ext}`;
    usedNames.add(name); return name;
  };

  const register = async (id, preferredName, isPhoto = false, is360 = false) => {
    if (!id || map.has(id)) return;
    const blob = await imageStore.getBlob(id);
    if (!blob) return;
    const mime     = blob.type || 'application/octet-stream';
    const ext      = _mimeToExt(mime);
    const fallback = id + (ext ? '.' + ext : '');
    const filename = uniqueName(preferredName || fallback);
    map.set(id, { filename, mime, blob, isPhoto, is360 });
  };

  // Photos en lazy load : pas d'imageId, on lit l'entry zip.js directement
  // à l'écriture du nouveau ZIP. Évite l'extraction → IDB → relecture en
  // mémoire pour les photos jamais ouvertes (pass-through).
  const registerLazy = (ph, is360) => {
    if (!ph.imageFile) return;
    const bundle = siteZipSources.get(site.id);
    if (!bundle) return;
    const entry = bundle.entries.get(ph.imageFile);
    if (!entry) return;
    const key  = `lazy:${site.id}:${ph.imageFile}`;
    if (map.has(key)) return;
    const mime = ph.imageMime || 'application/octet-stream';
    const filename = uniqueName(ph.imageFilename || ph.imageFile);
    map.set(key, { filename, mime, entry, isPhoto: true, is360 });
  };

  if (site.illustrationId) await register(site.illustrationId, site.illustrationFilename);
  for (const sp of site.sitePlans || []) if (sp.imageId) await register(sp.imageId, sp.imageFilename);
  for (const bld of site.buildings || []) for (const fl of bld.floors || []) if (fl.imageId) await register(fl.imageId, fl.imageFilename);
  for (const pt of site.points || []) {
    const is360 = pt.type === '360';
    for (const ph of pt.photos || []) {
      if (ph.imageId) await register(ph.imageId, ph.imageFilename, true, is360);
      else registerLazy(ph, is360);
    }
  }
  return map;
}

// Construit le metadata.json : même structure que le site mais imageId → {imageFile, imageMime}.
function _buildMetaFromSite(site, imageMap) {
  const SITE_SKIP = new Set(['illustrationId', 'illustration', 'sitePlans', 'buildings', 'points']);
  const meta = {};
  for (const [k, v] of Object.entries(site)) { if (!SITE_SKIP.has(k) && v !== undefined) meta[k] = v; }

  if (site.illustrationId && imageMap.has(site.illustrationId)) {
    const { filename, mime } = imageMap.get(site.illustrationId);
    meta.illustrationFile = filename; meta.illustrationMime = mime;
  }
  const IMG_BLOB_SKIP = new Set(['imageId', 'imageDataURL', 'dataURL', 'thumbnail']);
  meta.sitePlans = (site.sitePlans || []).map(sp => {
    const out = {};
    for (const [k, v] of Object.entries(sp)) { if (!IMG_BLOB_SKIP.has(k) && v !== undefined) out[k] = v; }
    if (sp.imageId && imageMap.has(sp.imageId)) { const { filename, mime } = imageMap.get(sp.imageId); out.imageFile = filename; out.imageMime = mime; }
    return out;
  });
  meta.buildings = (site.buildings || []).map(bld => {
    const out = {};
    for (const [k, v] of Object.entries(bld)) { if (k !== 'floors' && v !== undefined) out[k] = v; }
    out.floors = (bld.floors || []).map(fl => {
      const fOut = {};
      for (const [k, v] of Object.entries(fl)) { if (!IMG_BLOB_SKIP.has(k) && v !== undefined) fOut[k] = v; }
      if (fl.imageId && imageMap.has(fl.imageId)) { const { filename, mime } = imageMap.get(fl.imageId); fOut.imageFile = filename; fOut.imageMime = mime; }
      return fOut;
    });
    return out;
  });
  meta.points = (site.points || []).map(pt => {
    const out = {};
    for (const [k, v] of Object.entries(pt)) { if (k !== 'photos' && v !== undefined) out[k] = v; }
    out.photos = (pt.photos || []).map(ph => {
      const pOut = {};
      for (const [k, v] of Object.entries(ph)) { if (!IMG_BLOB_SKIP.has(k) && v !== undefined) pOut[k] = v; }
      if (ph.imageId && imageMap.has(ph.imageId)) {
        const { filename, mime } = imageMap.get(ph.imageId);
        pOut.imageFile = filename; pOut.imageMime = mime;
      } else if (ph.imageFile) {
        // Photo lazy : récupère le filename dédupé depuis la map de save
        const lazyKey = `lazy:${site.id}:${ph.imageFile}`;
        if (imageMap.has(lazyKey)) {
          const { filename, mime } = imageMap.get(lazyKey);
          pOut.imageFile = filename; pOut.imageMime = mime;
        }
      }
      return pOut;
    });
    return out;
  });
  return meta;
}

// Streaming ZIP → FileSystemWritableFileStream (FSAA).
// Pic mémoire : ~une image à la fois (blob.arrayBuffer() charge ~2 Mo, puis libéré).
// L'ordre d'écriture est : (1) toutes les images (avec compression éventuelle qui
// peut changer mime/extension), puis (2) metadata.json — pour que la metadata
// référence les filenames/mimes finalisés. zip.js gère l'ordre arbitraire à la lecture.
async function _saveSiteAsZip(site, writable, onProgress, options = {}) {
  const enc = new TextEncoder();
  const compress = options.compress !== false;
  let done = 0;
  const tick = () => { done++; onProgress(done); };

  const imageMap = await _collectImageMap(site);

  let pendingWrite = Promise.resolve();
  let _zipErr = null;
  const zip = new fflate.Zip((err, chunk) => {
    if (err) { _zipErr = err; return; }
    pendingWrite = pendingWrite.then(() => writable.write(chunk));
  });

  // Phase 1 : écriture de chaque image, compressée si demandé
  for (const [, mapEntry] of imageMap) {
    let arr;
    if (mapEntry.blob) {
      arr = new Uint8Array(await mapEntry.blob.arrayBuffer());
    } else if (mapEntry.entry) {
      const b = await mapEntry.entry.getData(new BlobWriter(mapEntry.mime));
      arr = new Uint8Array(await b.arrayBuffer());
    } else continue;

    if (compress && mapEntry.isPhoto) {
      const r = await _compressPhoto(arr, mapEntry.mime, mapEntry.is360);
      if (r) {
        arr = r.bytes;
        if (r.mime !== mapEntry.mime) {
          mapEntry.mime = r.mime;
          const newExt = _mimeToExt(r.mime);
          if (newExt) mapEntry.filename = _changeFilenameExt(mapEntry.filename, newExt);
        }
      }
    }

    const fflateEntry = new fflate.ZipPassThrough(`images/${mapEntry.filename}`);
    zip.add(fflateEntry);
    fflateEntry.push(arr, true);
    await pendingWrite;
    if (_zipErr) throw _zipErr;
    tick();
  }

  // Phase 2 : metadata.json après que tous les filenames/mimes soient finalisés
  const meta = _buildMetaFromSite(site, imageMap);
  const metaEntry = new fflate.ZipPassThrough('metadata.json');
  zip.add(metaEntry);
  metaEntry.push(enc.encode(JSON.stringify(meta)), true);
  await pendingWrite;
  if (_zipErr) throw _zipErr;

  zip.end();
  await pendingWrite;
  if (_zipErr) throw _zipErr;
}

// Chemin legacy (Safari / navigateurs sans FSAA) : ZIP en mémoire + a.download.
// Pic mémoire : ~taille ZIP (pas d'allocation intermédiaire grâce à new Blob(chunks)).
async function _saveSiteAsZipLegacy(site, fname, onProgress, options = {}) {
  const enc = new TextEncoder();
  const compress = options.compress !== false;
  let done = 0;
  const tick = () => { done++; onProgress(done); };

  const imageMap = await _collectImageMap(site);

  const chunks = [];
  let _zipErr2 = null;
  const zip = new fflate.Zip((err, chunk) => {
    if (err) { _zipErr2 = err; return; }
    chunks.push(chunk);
  });

  // Phase 1 : images (compressées si activé) — voir _saveSiteAsZip pour le rationnel.
  for (const [, mapEntry] of imageMap) {
    let arr;
    if (mapEntry.blob) {
      arr = new Uint8Array(await mapEntry.blob.arrayBuffer());
    } else if (mapEntry.entry) {
      const b = await mapEntry.entry.getData(new BlobWriter(mapEntry.mime));
      arr = new Uint8Array(await b.arrayBuffer());
    } else continue;

    if (compress && mapEntry.isPhoto) {
      const r = await _compressPhoto(arr, mapEntry.mime, mapEntry.is360);
      if (r) {
        arr = r.bytes;
        if (r.mime !== mapEntry.mime) {
          mapEntry.mime = r.mime;
          const newExt = _mimeToExt(r.mime);
          if (newExt) mapEntry.filename = _changeFilenameExt(mapEntry.filename, newExt);
        }
      }
    }

    const fflateEntry = new fflate.ZipPassThrough(`images/${mapEntry.filename}`);
    zip.add(fflateEntry); fflateEntry.push(arr, true);
    if (_zipErr2) throw _zipErr2;
    tick();
  }

  // Phase 2 : metadata.json après finalisation des filenames/mimes
  const meta = _buildMetaFromSite(site, imageMap);
  const metaEntry = new fflate.ZipPassThrough('metadata.json');
  zip.add(metaEntry);
  metaEntry.push(enc.encode(JSON.stringify(meta)), true);
  if (_zipErr2) throw _zipErr2;

  zip.end();
  if (_zipErr2) throw _zipErr2;
  progress.setLabel('Génération du fichier…');

  const dlBlob = new Blob(chunks, { type: 'application/zip' });
  const url = URL.createObjectURL(dlBlob);
  const a   = document.createElement('a');
  a.href = url; a.download = fname; a.click();
  URL.revokeObjectURL(url);
}


// Saves the site to disk as a ZIP .cado file, showing progress. Two paths:
//   - FSAA (Chrome/Edge/Firefox ≥ 111): streams ZIP directly to disk, one image at a time.
//   - Legacy (Safari / old browsers): builds full ZIP in memory, downloads via a.download.
// Shows the file picker BEFORE the progress overlay in FSAA mode (better UX).
async function _saveSiteCore(site, options = {}) {
  const compress = options.compress !== false;
  const baseName = (site.name || 'site') + (compress ? '_opti' : '');
  const fname = baseName + '.cado';
  const total = countSiteImages(site);

  if (window.showSaveFilePicker) {
    const handle = await window.showSaveFilePicker({
      suggestedName: fname,
      types: [{ description: 'Site CadoTour', accept: { 'application/octet-stream': ['.cado'] } }],
    });
    progress.show(`Sauvegarde de « ${site.name || 'le site'} »…`, total);
    const writable = await handle.createWritable();
    try {
      await _saveSiteAsZip(site, writable, cur => progress.update(cur), { compress });
      await writable.close();
    } catch (err) {
      if (writable.abort) await writable.abort().catch(() => {});
      throw err;
    } finally {
      progress.hide();
    }
  } else {
    progress.show(`Sauvegarde de « ${site.name || 'le site'} »…`, total);
    try {
      await _saveSiteAsZipLegacy(site, fname, cur => progress.update(cur), { compress });
    } finally {
      progress.hide();
    }
  }
}

// Modal "Sauvegarder" : checkbox compression + aperçu du nom de fichier.
// Renvoie { compress } si l'utilisateur confirme, null s'il annule.
function _askSaveOptions(site) {
  return new Promise(resolve => {
    const nameEl  = document.getElementById('save-site-name');
    const checkbox = document.getElementById('save-compress-toggle');
    const preview = document.getElementById('save-filename-preview');
    const btnOk   = document.getElementById('btn-save-confirm');
    const btnNo   = document.getElementById('btn-save-cancel');

    nameEl.textContent = site.name || 'ce site';
    checkbox.checked   = true;

    const refreshPreview = () => {
      const base = site.name || 'site';
      preview.textContent = base + (checkbox.checked ? '_opti' : '') + '.cado';
    };
    refreshPreview();

    const onChange  = () => refreshPreview();
    const onConfirm = () => { cleanup(); resolve({ compress: checkbox.checked }); };
    const onCancel  = () => { cleanup(); resolve(null); };
    const cleanup = () => {
      checkbox.removeEventListener('change', onChange);
      btnOk.removeEventListener('click', onConfirm);
      btnNo.removeEventListener('click', onCancel);
      hideModal('modal-save-site');
    };

    checkbox.addEventListener('change', onChange);
    btnOk.addEventListener('click', onConfirm);
    btnNo.addEventListener('click', onCancel);
    showModal('modal-save-site');
  });
}

async function saveSite() {
  const site = getActiveSite();
  if (!site) return;
  const opts = await _askSaveOptions(site);
  if (!opts) return; // annulé
  try {
    await _saveSiteCore(site, opts);
    clearCacheState();
  } catch (err) {
    if (err.name !== 'AbortError') alert(`Échec de la sauvegarde :\n${err.message}`);
  }
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

  if (withSave) {
    const opts = await _askSaveOptions(site);
    if (!opts) return; // annulé → on ne ferme pas
    let ok = false;
    try {
      await _saveSiteCore(site, opts);
      ok = true;
    } catch (err) {
      if (err.name !== 'AbortError') alert(`Échec de la sauvegarde :\n${err.message}`);
    }
    if (!ok) return;
  }

  // Libère tous les Blobs du site (illustration, plans, photos)
  if (site.illustrationId) imageStore.deleteImage(site.illustrationId);
  for (const sp of site.sitePlans || []) if (sp.imageId) imageStore.deleteImage(sp.imageId);
  for (const bld of site.buildings || []) {
    for (const fl of bld.floors || []) if (fl.imageId) imageStore.deleteImage(fl.imageId);
  }
  for (const pt of site.points || []) {
    for (const ph of pt.photos || []) if (ph.imageId) imageStore.deleteImage(ph.imageId);
  }
  // Libère la source ZIP du site (si en lazy load)
  await _closeSiteZipSource(site.id);

  const siteId = site.id;

  state.activeSiteId     = null;
  state.activeBuildingId = null;
  state.activeFloorId    = null;
  state.activeSitePlanId = null;
  state.activePointId    = null;
  state.activePhotoId    = null;

  clearBuildingMarkers();
  clearPointMarkers();
  removeSiteMarker(siteId);
  if (perimeterLayer)    { perimeterLayer.remove();    perimeterLayer    = null; }
  if (accessArrowMarker) { accessArrowMarker.remove(); accessArrowMarker = null; }

  state.sites = state.sites.filter(s => s.id !== siteId);

  clearTimeout(_saveTimer);
  if (state.sites.length) {
    await saveCacheNow();
  } else {
    await clearCacheState();
  }

  closeViewer();
  renderSidebar();
  renderSiteHeader();
  updateTopBarButtons();
  if (state.viewMode !== 'map') switchViewMode('map');

  const fileToLoad   = pendingLoadFile;    pendingLoadFile    = null;
  const handleToLoad = pendingLoadHandle;  pendingLoadHandle  = null;
  const urlToGo      = pendingNavigateUrl; pendingNavigateUrl = null;
  if (fileToLoad) { loadSiteFromFile(fileToLoad, handleToLoad); return; }
  if (urlToGo)    { window.location.href = urlToGo; }
}

// ===== SITE SELECTION =====
function selectSite(siteId) {
  const prev = state.activeSiteId;
  state.activeSiteId    = siteId;
  state.activeBuildingId = null;
  state.activeFloorId   = null;
  state.activeSitePlanId = null;
  state.activePointId   = null;
  state.activePhotoId   = null;

  if (prev && siteMarkers[prev]) {
    const prevSite = state.sites.find(s => s.id === prev);
    if (prevSite) updateSiteMarkerIcon(prev, false);
  }
  updateSiteMarkerIcon(siteId, true);

  clearBuildingMarkers();
  clearPointMarkers();

  const site = getActiveSite();
  if (site) {
    (site.buildings || []).forEach(b => addBuildingMarker(b));
    (site.points || [])
      .filter(pt => pt.lat != null && !pt.buildingId && !pt.sitePlanId)
      .forEach(pt => addPointMarker(pt));
    if (site.perimeter)   renderSitePerimeter(site);
    if (site.accessArrow) renderAccessArrow(site);
    drawing.renderMapLayers();
  }

  updateMarkersVisibility();

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
  state.activePointId    = null;
  state.activePhotoId    = null;

  updateSiteMarkerIcon(prev, false);
  clearBuildingMarkers();
  clearPointMarkers();
  drawing.clearMapLayers();
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
      if (state.activeSiteId !== site.id) selectSite(site.id);
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

// ===== BUILDING EDIT MODAL =====
function openEditBuildingModal(buildingId) {
  editBuildingId = buildingId;
  const site = getActiveSite();
  const building = site?.buildings.find(b => b.id === buildingId);
  if (!building) return;
  document.getElementById('edit-bld-name').value = building.name;
  renderEditBuildingFloors(building);
  showModal('modal-edit-building');
}

function renderEditBuildingFloors(building) {
  const list = document.getElementById('edit-bld-floors-list');
  list.innerHTML = '';
  if (!building.floors.length) {
    const empty = document.createElement('p');
    empty.className = 'text-muted';
    empty.style.padding = '6px 0';
    empty.textContent = 'Aucun niveau';
    list.appendChild(empty);
    return;
  }
  building.floors.forEach((floor, i) => {
    const row = document.createElement('div');
    row.className = 'edit-bld-floor-row';
    row.innerHTML = `
      <input type="text" class="input-field" value="${escapeHtml(floor.name)}" data-floor-id="${floor.id}" />
      <button class="btn-icon btn-sm" ${i === 0 ? 'disabled' : ''} data-move="up" data-idx="${i}" title="Monter">↑</button>
      <button class="btn-icon btn-sm" ${i === building.floors.length - 1 ? 'disabled' : ''} data-move="down" data-idx="${i}" title="Descendre">↓</button>`;
    list.appendChild(row);
  });
  list.querySelectorAll('[data-move]').forEach(btn => {
    btn.addEventListener('click', () => {
      const site = getActiveSite();
      const bld = site?.buildings.find(b => b.id === editBuildingId);
      if (!bld) return;
      const idx = parseInt(btn.dataset.idx);
      const newIdx = idx + (btn.dataset.move === 'up' ? -1 : 1);
      if (newIdx < 0 || newIdx >= bld.floors.length) return;
      [bld.floors[idx], bld.floors[newIdx]] = [bld.floors[newIdx], bld.floors[idx]];
      renderEditBuildingFloors(bld);
    });
  });
}

function confirmEditBuilding() {
  const site = getActiveSite();
  const building = site?.buildings.find(b => b.id === editBuildingId);
  if (!building) return;
  const newName = document.getElementById('edit-bld-name').value.trim();
  if (newName) building.name = newName;
  document.querySelectorAll('#edit-bld-floors-list [data-floor-id]').forEach(input => {
    const floor = building.floors.find(f => f.id === input.dataset.floorId);
    if (floor && input.value.trim()) floor.name = input.value.trim();
  });
  hideModal('modal-edit-building');
  renderSidebar();
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
  bfTempIcon = 'building';

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

  site.points    = site.points.filter(p => p.buildingId !== buildingId);
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

// ===== POINT MARKERS =====
function makePointIcon(type, bearing, isActive, count = 1) {
  const rot = ((bearing || 0) + 360) % 360;
  const sw  = isActive ? 3 : 1.5;
  let svgInner, size, anchor, color;

  if (type === 'normal') {
    size = 52; anchor = 26; color = '#e94560';
    svgInner = `
      <path d="M0,0 L-8.28,-19.92 A21.6,21.6,0,0,1,8.28,-19.92 Z" fill="${color}" opacity="0.8"/>
      <circle r="6" fill="${color}" stroke="white" stroke-width="${sw}"/>`;
  } else if (type === 'panoramic') {
    size = 56; anchor = 28; color = '#e07b20';
    svgInner = `
      <path d="M0,0 L-18.72,-10.8 A21.6,21.6,0,0,1,18.72,-10.8 Z" fill="${color}" opacity="0.75"/>
      <circle r="6" fill="${color}" stroke="white" stroke-width="${sw}"/>`;
  } else if (type === 'drone') {
    size = 60; anchor = 30; color = '#8e44ad';
    svgInner = `
      <path d="M0,0 L-18.72,-10.8 A21.6,21.6,0,0,1,18.72,-10.8 Z" fill="${color}" opacity="0.75"/>
      <line x1="0" y1="0" x2="-7" y2="-7" stroke="white" stroke-width="1.5"/>
      <line x1="0" y1="0" x2="7" y2="-7" stroke="white" stroke-width="1.5"/>
      <line x1="0" y1="0" x2="-7" y2="7" stroke="white" stroke-width="1.5"/>
      <line x1="0" y1="0" x2="7" y2="7" stroke="white" stroke-width="1.5"/>
      <circle cx="-7" cy="-7" r="3.5" fill="none" stroke="white" stroke-width="1.3"/>
      <circle cx="7" cy="-7" r="3.5" fill="none" stroke="white" stroke-width="1.3"/>
      <circle cx="-7" cy="7" r="3.5" fill="none" stroke="white" stroke-width="1.3"/>
      <circle cx="7" cy="7" r="3.5" fill="none" stroke="white" stroke-width="1.3"/>
      <rect x="-3" y="-3" width="6" height="6" rx="1" fill="${color}" stroke="white" stroke-width="${sw}"/>`;
  } else { // 360
    size = 52; anchor = 26; color = '#2980b9';
    svgInner = `
      <polygon points="0,-19 5,-9 0,-11 -5,-9" fill="${color}" stroke="white" stroke-width="1.5" stroke-linejoin="round" transform="rotate(${rot})"/>
      <circle r="10" fill="${color}" stroke="white" stroke-width="${sw}"/>
      <text x="0" y="0.5" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="700" fill="white">360</text>`;
  }

  const glow  = isActive
    ? `drop-shadow(0 0 8px ${color}) drop-shadow(0 0 14px rgba(255,255,255,0.95))`
    : 'drop-shadow(0 1px 4px rgba(0,0,0,0.6))';
  const scale = isActive ? 'scale(1.15)' : '';
  const badge = count > 1 ? `<span class="photo-count-badge">${count}</span>` : '';
  // Le 360 n'a pas de cône orienté : on rotate localement la kite, pas tout le wrapper.
  const wrapperRot = type === '360' ? 0 : rot;
  const html = `<div style="position:relative;width:${size}px;height:${size}px;filter:${glow};transform:${scale};transform-origin:${anchor}px ${anchor}px">
    <div style="width:${size}px;height:${size}px;transform:rotate(${wrapperRot}deg);transform-origin:${anchor}px ${anchor}px">
      <svg width="${size}" height="${size}" viewBox="-${anchor} -${anchor} ${size} ${size}" style="overflow:visible">${svgInner}</svg>
    </div>
    ${badge}
  </div>`;

  return L.divIcon({
    className: 'photo-icon-wrapper',
    html,
    iconSize: [size, size],
    iconAnchor: [anchor, anchor],
  });
}

function addPointMarker(point) {
  if (!map) return;
  const isActive = point.id === state.activePointId;
  const icon = makePointIcon(point.type, point.bearing, isActive, point.photos.length);

  const m = L.marker([point.lat, point.lon], { icon })
    .addTo(map)
    .on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (interactionMode) return;
      openViewer(point.id);
    })
    .on('contextmenu', e => {
      L.DomEvent.stopPropagation(e);
      if (interactionMode) return;
      hideMapContextMenu();
      const n = point.photos.length;
      const delLabel = n > 1
        ? `🗑 Supprimer le point (${n} photos)`
        : '🗑 Supprimer le point';
      showMapContextMenu(e.containerPoint, [
        { label: '⬡ Déplacer le point',  action: () => startMovePoint(point.id) },
        { label: '↻ Orienter le point',  action: () => startOrientPoint(point.id) },
        { label: null },
        { label: photoAddLabel(point.type), action: () => addPhotoToExistingPoint(point) },
        { label: null },
        { label: delLabel, action: () => deletePoint(point.id) },
      ]);
    })
    .on('mouseover', function () { this.getElement()?.classList.add('hovered'); })
    .on('mouseout',  function () { this.getElement()?.classList.remove('hovered'); });

  pointMarkers[point.id] = m;
}

function removePointMarker(pointId) {
  if (pointMarkers[pointId]) { pointMarkers[pointId].remove(); delete pointMarkers[pointId]; }
}

function clearPointMarkers() {
  Object.values(pointMarkers).forEach(m => m.remove());
  pointMarkers = {};
}

function refreshPointMarker(pointId) {
  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === pointId);
  if (!point) return;
  removePointMarker(pointId);
  if (point.lat != null) addPointMarker(point);
}

function refreshMarkerActive() {
  const site = getActiveSite();
  if (!site) return;
  Object.entries(pointMarkers).forEach(([id, m]) => {
    const point = site.points.find(p => p.id === id);
    if (!point) return;
    m.setIcon(makePointIcon(point.type, point.bearing, id === state.activePointId, point.photos.length));
  });
}

// ===== CLUSTER VISIBILITY =====
function updateMarkersVisibility() {
  if (!map || !state.activeSiteId) return;
  const clustered = map.getZoom() < CLUSTER_ZOOM_THRESHOLD;
  Object.values(pointMarkers).forEach(m => clustered ? m.remove() : m.addTo(map));
  Object.values(buildingMarkers).forEach(m => clustered ? m.remove() : m.addTo(map));
  Object.values(siteMarkers).forEach(m => clustered ? m.addTo(map) : m.remove());
  if (perimeterLayer)    clustered ? perimeterLayer.remove()    : perimeterLayer.addTo(map);
  if (accessArrowMarker) clustered ? accessArrowMarker.remove() : accessArrowMarker.addTo(map);
}

// ===== MOVE POINT =====
function startMovePoint(pointId) {
  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === pointId);
  if (!point) return;

  pointMarkers[pointId]?.getElement()?.classList.add('ghost');

  interactionMode = 'move-point';
  movePointId     = pointId;
  setStepBanner(
    'Cliquez sur la nouvelle position du point (toutes ses photos seront déplacées).',
    [{ label: 'Annuler', primary: false, action: cancelMovePoint }]
  );
}

function commitMovePoint(latlng) {
  clearStepBanner();
  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === movePointId);
  if (point) {
    point.lat = latlng.lat;
    point.lon = latlng.lng;
    refreshPointMarker(point.id);
  }
  interactionMode = null;
  movePointId     = null;
  scheduleCacheSave();
}

function cancelMovePoint() {
  clearStepBanner();
  pointMarkers[movePointId]?.getElement()?.classList.remove('ghost');
  interactionMode = null;
  movePointId     = null;
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

// ===== ORIENT POINT =====
function startOrientPoint(pointId) {
  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === pointId);
  if (!point) return;

  interactionMode = 'orient-point';
  orientPointId   = pointId;

  map.on('mousemove', onMapMousemove);
  setStepBanner(
    'Cliquez sur la carte pour définir la direction du point.',
    [{ label: 'Annuler', primary: false, action: cancelOrientPoint }]
  );
}

function commitOrientPoint(latlng) {
  clearStepBanner();
  map.off('mousemove', onMapMousemove);
  if (orientLine) { orientLine.remove(); orientLine = null; }

  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === orientPointId);
  if (point && point.lat != null) {
    const dx = latlng.lng - point.lon;
    const dy = latlng.lat - point.lat;
    const bearing = ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
    point.bearing = bearing;
    refreshPointMarker(point.id);
    if (state.activePointId === point.id) {
      document.getElementById('edit-photo-bearing').value = Math.round(bearing);
    }
    scheduleCacheSave();
  }

  interactionMode = null;
  orientPointId   = null;
}

function cancelOrientPoint() {
  clearStepBanner();
  map.off('mousemove', onMapMousemove);
  if (orientLine) { orientLine.remove(); orientLine = null; }
  interactionMode = null;
  orientPointId   = null;
}

// ===== SIDEBAR =====
function renderSiteHeader() {
  const site = getActiveSite();
  document.getElementById('site-header-icon').innerHTML = site ? renderIcon(site.icon || 'landmark') : '';
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

  appendNavItem(nav, {
    icon: '🗺', label: 'Carte extérieure',
    active: state.viewMode === 'map',
    onClick: () => switchViewMode('map'),
  });

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

  const bldDiv = document.createElement('div');
  bldDiv.className = 'nav-divider';
  bldDiv.textContent = 'Bâtiments';
  nav.appendChild(bldDiv);

  (site.buildings || []).forEach(building => {
    const bh = document.createElement('div');
    bh.className = 'nav-building-header';
    bh.innerHTML = `<span class="nav-bld-icon">${renderIcon(building.icon || 'building')}</span>
                    <span style="flex:1">${escapeHtml(building.name)}</span>
                    <button class="nav-bld-edit" title="Modifier">⚙</button>
                    <button class="nav-bld-del" title="Supprimer">🗑</button>`;
    bh.querySelector('.nav-bld-edit').addEventListener('click', e => {
      e.stopPropagation();
      openEditBuildingModal(building.id);
    });
    bh.querySelector('.nav-bld-del').addEventListener('click', e => {
      e.stopPropagation();
      deleteBuilding(building.id);
    });
    nav.appendChild(bh);

    building.floors.forEach(floor => {
      appendNavItem(nav, {
        icon: '📐', label: floor.name,
        active: state.activeFloorId === floor.id && state.activeBuildingId === building.id,
        sub: true,
        onDelete: () => deleteFloor(building.id, floor.id),
        onClick: () => selectFloor(building.id, floor.id),
      });
    });

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

  // Cancel any in-progress drawing when switching views
  if (drawing.isPlanDrawing) drawing.cancelPlanDrawing();
  if (interactionMode === 'map-drawing') drawing.cancelMapDrawing();

  document.getElementById('map-container').classList.toggle('hidden', mode !== 'map');
  document.getElementById('plan-container').classList.toggle('hidden', mode !== 'plan');
  document.getElementById('map-search').classList.toggle('hidden', mode !== 'map');

  if (mode === 'map') {
    setTimeout(() => { if (map) map.invalidateSize(); }, 50);
    drawing.renderMapLayers();
  } else {
    renderPlan();
  }
  drawing.renderPanel();
  renderSidebar();
}

// ===== FLOOR MANAGEMENT =====
function selectFloor(buildingId, floorId) {
  state.activeBuildingId = buildingId;
  state.activeFloorId    = floorId;
  state.activeSitePlanId = null;
  state.activePointId    = null;
  state.activePhotoId    = null;

  // Cancel any in-progress drawing when switching floor
  if (drawing.isPlanDrawing) drawing.cancelPlanDrawing();
  drawing.setTool(null);

  Object.entries(buildingMarkers).forEach(([id, m]) => {
    const site = getActiveSite();
    const bld  = site?.buildings.find(b => b.id === id);
    if (bld) m.setIcon(makeBuildingMarkerIcon(bld));
  });

  switchViewMode('plan');
  closeViewer();
  drawing.renderPanel();
  renderSidebar();
}

function selectSitePlan(planId) {
  state.activeSitePlanId = planId;
  state.activeBuildingId = null;
  state.activeFloorId    = null;
  state.activePointId    = null;
  state.activePhotoId    = null;

  // Cancel any in-progress drawing when switching site plan
  if (drawing.isPlanDrawing) drawing.cancelPlanDrawing();
  drawing.setTool(null);

  switchViewMode('plan');
  closeViewer();
  drawing.renderPanel();
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
  const imageId = file ? await imageStore.putBlob(file) : null;

  const floor = { id: uid(), name, imageId, imageFilename: file?.name || null };
  building.floors.push(floor);
  hideModal('modal-add-floor');
  selectFloor(building.id, floor.id);
}

function deleteFloor(buildingId, floorId) {
  const site     = getActiveSite();
  const building = site?.buildings.find(b => b.id === buildingId);
  if (!building || !confirm('Supprimer ce niveau et toutes ses photos ?')) return;

  // Libère les Blobs (plan d'étage + photos rattachées à ce floor)
  const floor = building.floors.find(f => f.id === floorId);
  if (floor?.imageId) imageStore.deleteImage(floor.imageId);
  for (const p of site.points) {
    if (p.buildingId === buildingId && p.floorId === floorId) {
      for (const ph of p.photos) if (ph.imageId) imageStore.deleteImage(ph.imageId);
    }
  }

  site.points = site.points.filter(p => !(p.buildingId === buildingId && p.floorId === floorId));
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
  const imageId = file ? await imageStore.putBlob(file) : null;

  const sp = { id: uid(), name, imageId, imageFilename: file?.name || null };
  site.sitePlans.push(sp);
  hideModal('modal-add-siteplan');
  selectSitePlan(sp.id);
}

function deleteSitePlan(planId) {
  const site = getActiveSite();
  if (!site || !confirm('Supprimer ce plan de site ?')) return;

  // Libère les Blobs (plan + photos rattachées)
  const sp = site.sitePlans.find(s => s.id === planId);
  if (sp?.imageId) imageStore.deleteImage(sp.imageId);
  for (const p of site.points) {
    if (p.sitePlanId === planId) {
      for (const ph of p.photos) if (ph.imageId) imageStore.deleteImage(ph.imageId);
    }
  }

  site.points    = site.points.filter(p => p.sitePlanId !== planId);
  site.sitePlans = site.sitePlans.filter(sp => sp.id !== planId);

  if (state.activeSitePlanId === planId) {
    state.activeSitePlanId = null;
    switchViewMode('map');
  }
  renderSidebar();
}

// ===== FLOOR PLAN RENDERING =====
function getActivePlan() { return _getActivePlan(state, getActiveSite()); }

async function renderPlan() {
  const active = getActivePlan();
  if (!active) return;

  document.getElementById('plan-floor-name').textContent = active.label;

  const btnDl = document.getElementById('btn-download-plan');
  const btnDlA = document.getElementById('btn-download-plan-annotated');
  if (btnDl) {
    if (active.imageId) {
      btnDl.classList.remove('hidden');
      btnDl.onclick = () => {
        const site = getActiveSite();
        _downloadImage(active.imageId, ext =>
          _sanitizeFilename(`${site?.name || 'site'}_${active.label}`) + (ext ? '.' + ext : '')
        );
      };
      if (btnDlA) btnDlA.classList.remove('hidden');
    } else {
      btnDl.classList.add('hidden');
      btnDl.onclick = null;
      if (btnDlA) btnDlA.classList.add('hidden');
    }
  }

  const canvas   = document.getElementById('plan-canvas');
  const viewport = document.getElementById('plan-viewport');

  const url = active.imageId ? await imageStore.getURL(active.imageId) : null;
  if (!url) {
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
  img.src = url;
}

function updateActivePlanImage(imageId, filename) {
  const site = getActiveSite();
  if (!site) return;

  if (state.activeSitePlanId) {
    const sp = site.sitePlans?.find(sp => sp.id === state.activeSitePlanId);
    if (sp) {
      if (sp.imageId) imageStore.deleteImage(sp.imageId);
      sp.imageId = imageId;
      sp.imageFilename = filename || null;
      renderPlan();
    }
  } else if (state.activeBuildingId && state.activeFloorId) {
    const bld   = site.buildings?.find(b => b.id === state.activeBuildingId);
    const floor = bld?.floors?.find(f => f.id === state.activeFloorId);
    if (floor) {
      if (floor.imageId) imageStore.deleteImage(floor.imageId);
      floor.imageId = imageId;
      floor.imageFilename = filename || null;
      renderPlan();
    }
  }
}

function drawPlanCanvas() { _drawPlanCanvas(plan); }

function renderPlanMarkers() {
  const svg  = document.getElementById('plan-overlay');
  svg.innerHTML = '';
  const site = getActiveSite();
  if (!site) return;

  let points = [];
  if (state.activeSitePlanId) {
    points = site.points.filter(p => p.sitePlanId === state.activeSitePlanId && p.planX != null);
  } else if (state.activeBuildingId && state.activeFloorId) {
    points = site.points.filter(
      p => p.buildingId === state.activeBuildingId && p.floorId === state.activeFloorId && p.planX != null
    );
  }

  points.forEach(point => {
    const sx = point.planX * plan.scale + plan.offsetX;
    const sy = point.planY * plan.scale + plan.offsetY;
    const isActive = point.id === state.activePointId;
    const color = point.type === '360' ? '#2980b9' : point.type === 'panoramic' ? '#e07b20' : point.type === 'drone' ? '#8e44ad' : '#e94560';

    const isGhost = planMovePointId === point.id;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'plan-pin' + (isActive ? ' plan-pin-active' : ''));
    g.setAttribute('transform', `translate(${sx},${sy})${isActive ? ' scale(1.15)' : ''}`);
    if (isActive) g.setAttribute('style', `filter: drop-shadow(0 0 6px ${color}) drop-shadow(0 0 10px rgba(255,255,255,0.9))`);
    if (isGhost) { g.setAttribute('opacity', '0.3'); g.setAttribute('pointer-events', 'none'); }

    const rot = point.bearing || 0;
    if (point.type === '360') {
      const tri = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      tri.setAttribute('points', '0,-19 5,-9 0,-11 -5,-9');
      tri.setAttribute('fill', color);
      tri.setAttribute('stroke', 'white');
      tri.setAttribute('stroke-width', '1.5');
      tri.setAttribute('stroke-linejoin', 'round');
      tri.setAttribute('transform', `rotate(${rot})`);
      g.appendChild(tri);
    } else {
      const wedge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      if (point.type === 'normal') {
        wedge.setAttribute('d', 'M0,0 L-6,-14.4 A15.6,15.6,0,0,1,6,-14.4 Z');
      } else { // panoramic | drone
        wedge.setAttribute('d', 'M0,0 L-13.2,-7.8 A15.6,15.6,0,0,1,13.2,-7.8 Z');
      }
      wedge.setAttribute('fill', color);
      wedge.setAttribute('opacity', '0.6');
      wedge.setAttribute('transform', `rotate(${rot})`);
      g.appendChild(wedge);
    }

    const bodyR = point.type === '360' ? 10 : 6;
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', bodyR);
    circle.setAttribute('fill', color);
    circle.setAttribute('stroke', 'white');
    circle.setAttribute('stroke-width', isActive ? 3 : 1.5);
    circle.setAttribute('class', 'plan-pin-circle');
    g.appendChild(circle);

    if (point.type === '360') {
      const txt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      txt.setAttribute('x', '0');
      txt.setAttribute('y', '0.5');
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('dominant-baseline', 'central');
      txt.setAttribute('font-size', '9');
      txt.setAttribute('font-weight', '700');
      txt.setAttribute('fill', 'white');
      txt.style.pointerEvents = 'none';
      txt.textContent = '360';
      g.appendChild(txt);
    }

    if (point.photos.length > 1) {
      const br = 6;
      const bx = bodyR + br - 1, by = -(bodyR + br - 1);
      const badgeBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      badgeBg.setAttribute('cx', bx); badgeBg.setAttribute('cy', by);
      badgeBg.setAttribute('r', br);
      badgeBg.setAttribute('fill', 'white');
      badgeBg.setAttribute('stroke', 'rgba(0,0,0,0.4)'); badgeBg.setAttribute('stroke-width', '1');
      const badgeTxt = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      badgeTxt.setAttribute('x', bx); badgeTxt.setAttribute('y', by);
      badgeTxt.setAttribute('text-anchor', 'middle'); badgeTxt.setAttribute('dominant-baseline', 'central');
      badgeTxt.setAttribute('font-size', '8'); badgeTxt.setAttribute('font-weight', 'bold');
      badgeTxt.setAttribute('fill', '#222');
      badgeTxt.textContent = point.photos.length;
      g.appendChild(badgeBg); g.appendChild(badgeTxt);
    }

    g.addEventListener('click', () => { if (!planMovePointId) openViewer(point.id); });
    g.addEventListener('contextmenu', e => {
      e.preventDefault();
      e.stopPropagation();
      if (!planMovePointId) showPlanPointContextMenu(e, point);
    });
    svg.appendChild(g);
  });

  drawing.renderPlanLayers(svg);
}

function showPlanPointContextMenu(e, point) {
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

  const n = point.photos.length;
  const delLabel = n > 1 ? `🗑 Supprimer le point (${n} photos)` : '🗑 Supprimer le point';

  const items = [
    { label: '⬡ Déplacer le point',  action: () => startMovePlanPoint(point) },
    { label: '↻ Orienter le point',  action: () => startOrientPlanPoint(point) },
    { label: null },
    { label: photoAddLabel(point.type), action: () => addPhotoToExistingPoint(point) },
    { label: null },
    { label: delLabel, action: () => deletePoint(point.id) },
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

function startOrientPlanPoint(point) {
  const viewport    = document.getElementById('plan-viewport');
  let   orientLineEl = null;

  const cleanup = () => {
    viewport.style.cursor = '';
    viewport.removeEventListener('mousemove', onMove);
    viewport.removeEventListener('click',     onClick, true);
    if (orientLineEl) { orientLineEl.remove(); orientLineEl = null; }
    clearStepBanner();
  };

  const onMove = e => {
    const rect = viewport.getBoundingClientRect();
    const cx   = e.clientX - rect.left;
    const cy   = e.clientY - rect.top;
    const sx   = point.planX * plan.scale + plan.offsetX;
    const sy   = point.planY * plan.scale + plan.offsetY;
    const svg  = document.getElementById('plan-overlay');
    if (orientLineEl) orientLineEl.remove();
    orientLineEl = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    orientLineEl.setAttribute('x1', sx); orientLineEl.setAttribute('y1', sy);
    orientLineEl.setAttribute('x2', cx); orientLineEl.setAttribute('y2', cy);
    orientLineEl.setAttribute('stroke', '#ffd700');
    orientLineEl.setAttribute('stroke-width', '2');
    orientLineEl.setAttribute('stroke-dasharray', '5,4');
    orientLineEl.setAttribute('opacity', '0.9');
    orientLineEl.setAttribute('pointer-events', 'none');
    svg.appendChild(orientLineEl);
  };

  const onClick = e => {
    e.stopPropagation();
    const rect    = viewport.getBoundingClientRect();
    const mx      = e.clientX - rect.left;
    const my      = e.clientY - rect.top;
    const planX   = (mx - plan.offsetX) / plan.scale;
    const planY   = (my - plan.offsetY) / plan.scale;
    const dx      = planX - point.planX;
    const dy      = planY - point.planY;
    const bearing = ((Math.atan2(dx, -dy) * 180 / Math.PI) + 360) % 360;
    point.bearing = bearing;
    cleanup();
    renderPlanMarkers();
    if (state.activePointId === point.id)
      document.getElementById('edit-photo-bearing').value = Math.round(bearing);
    scheduleCacheSave();
  };

  viewport.style.cursor = 'crosshair';
  viewport.addEventListener('mousemove', onMove);
  viewport.addEventListener('click', onClick, true);
  setStepBanner(
    'Cliquez sur le plan pour définir la direction du point.',
    [{ label: 'Annuler', primary: false, action: cleanup }]
  );
}

function startMovePlanPoint(point) {
  const site = getActiveSite();
  if (!site) return;

  planMovePointId = point.id;
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
    planMovePointId = null;
    planMoveCleanup = null;
    clearStepBanner();
    renderPlanMarkers();
  };

  const onClick = e => {
    if (lastDragMoved) return;
    e.stopPropagation();
    const rect     = viewport.getBoundingClientRect();
    const mx       = e.clientX - rect.left;
    const my       = e.clientY - rect.top;
    const newPlanX = (mx - plan.offsetX) / plan.scale;
    const newPlanY = (my - plan.offsetY) / plan.scale;
    point.planX = newPlanX;
    point.planY = newPlanY;
    cleanup();
    scheduleCacheSave();
  };

  planMoveCleanup = cleanup;
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
  if (type === 'drone')     return '🚁 Ajouter une vue aérienne/drône';
  return '📷 Ajouter une photo normale';
}

function addPhotoToExistingPoint(point) {
  pendingPhotoTarget = { kind: 'existing', pointId: point.id };
  pendingPhotoFiles  = [];
  openAddPhotoModal(point.type);
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
    // Block panning when a drawing tool is active (SVG overlay handles clicks)
    if (drawing?.isBlockingPan) return;
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

// ===== PHOTO / POINT ADDITION =====
function startAddPhotoAt(lat, lon, type) {
  pendingPhotoTarget = { kind: 'new', type, position: { lat, lon } };
  pendingPhotoFiles  = [];
  openAddPhotoModal(type);
}

function startAddPhotoOnPlan(planX, planY, type) {
  const buildingId = state.activeBuildingId || null;
  const floorId    = state.activeFloorId || null;
  const sitePlanId = state.activeSitePlanId || null;
  pendingPhotoTarget = {
    kind: 'new',
    type,
    position: { planX, planY, buildingId, floorId, sitePlanId },
  };
  pendingPhotoFiles  = [];
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
  const titles = { normal: 'Photo normale', panoramic: 'Photo panoramique (120°)', '360': 'Photo 360°', drone: 'Vue aérienne/drône' };
  document.getElementById('modal-add-photo-title').textContent = 'Ajouter : ' + (titles[type] || type);
  document.getElementById('input-new-photo-file').value = '';
  document.getElementById('new-photo-title').value = '';
  document.getElementById('new-photo-desc').value  = '';
  updatePhotoFileList();
  showModal('modal-add-photo');
}

async function confirmAddPhoto() {
  const site = getActiveSite();
  if (!site || !pendingPhotoTarget) return;
  if (!pendingPhotoFiles.length) {
    alert('Sélectionnez au moins une image. Un point doit contenir au moins une photo.');
    return;
  }

  const baseTitle = document.getElementById('new-photo-title').value.trim();
  const desc      = document.getElementById('new-photo-desc').value.trim();
  const target    = pendingPhotoTarget;
  const multi     = pendingPhotoFiles.length > 1;
  const files     = pendingPhotoFiles.slice();

  hideModal('modal-add-photo');
  pendingPhotoTarget = null;
  pendingPhotoFiles  = [];

  const newPhotos = [];
  for (let i = 0; i < files.length; i++) {
    const file    = files[i];
    const imageId = await imageStore.putBlob(file);
    const title   = baseTitle
      ? (multi ? `${baseTitle} ${i + 1}` : baseTitle)
      : file.name.replace(/\.[^.]+$/, '');
    newPhotos.push({ id: uid(), title, description: desc, imageId, imageFilename: file.name });
  }

  let point;
  if (target.kind === 'existing') {
    point = site.points.find(p => p.id === target.pointId);
    if (!point) return;
    point.photos.push(...newPhotos);
    if (point.lat != null) refreshPointMarker(point.id);
    else renderPlanMarkers();
  } else {
    point = {
      id: uid(),
      type: target.type,
      bearing: 0,
      lat:        target.position.lat        ?? null,
      lon:        target.position.lon        ?? null,
      planX:      target.position.planX      ?? null,
      planY:      target.position.planY      ?? null,
      buildingId: target.position.buildingId ?? null,
      floorId:    target.position.floorId    ?? null,
      sitePlanId: target.position.sitePlanId ?? null,
      photos: newPhotos,
    };
    site.points.push(point);
    if (point.lat != null) addPointMarker(point);
    else renderPlanMarkers();
  }

  openViewer(point.id, newPhotos[0].id);
  scheduleCacheSave();
}

// ===== POINT / PHOTO DELETION =====
function deletePoint(pointId) {
  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === pointId);
  if (!point) return;
  const msg = point.photos.length > 1
    ? `Supprimer ce point et ses ${point.photos.length} photos ?`
    : 'Supprimer ce point ?';
  if (!confirm(msg)) return;

  // Libère les Blobs des photos supprimées
  for (const ph of point.photos) if (ph.imageId) imageStore.deleteImage(ph.imageId);

  site.points = site.points.filter(p => p.id !== pointId);
  removePointMarker(pointId);
  renderPlanMarkers();
  if (state.activePointId === pointId) closeViewer();
  scheduleCacheSave();
}

function deletePhotoFromActivePoint(photoId) {
  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === state.activePointId);
  if (!point) return;
  const idx = point.photos.findIndex(ph => ph.id === photoId);
  if (idx < 0) return;

  // Si c'est la dernière photo, on supprime le point entier
  if (point.photos.length === 1) {
    if (!confirm('C\'est la dernière photo de ce point. Supprimer le point ?')) return;
    if (point.photos[0].imageId) imageStore.deleteImage(point.photos[0].imageId);
    site.points = site.points.filter(p => p.id !== point.id);
    removePointMarker(point.id);
    renderPlanMarkers();
    closeViewer();
    scheduleCacheSave();
    return;
  }

  if (!confirm('Supprimer cette photo ?')) return;
  const removed = point.photos.splice(idx, 1)[0];
  if (removed?.imageId) imageStore.deleteImage(removed.imageId);

  // Mémorise la suppression d'une photo originale du .cado pour le delta de restauration
  if (removed?.imageFile && siteZipSources.has(site.id)) {
    if (!_zipSiteDeletedPhotos.has(site.id)) _zipSiteDeletedPhotos.set(site.id, new Set());
    _zipSiteDeletedPhotos.get(site.id).add(removed.id);
  }

  if (point.lat != null) refreshPointMarker(point.id);
  else renderPlanMarkers();

  viewerGalleryIdx = Math.min(viewerGalleryIdx, point.photos.length - 1);
  const next = point.photos[viewerGalleryIdx];
  state.activePhotoId = next.id;
  _renderViewerPhoto(point, next);
  updateGalleryNav();
  scheduleCacheSave();
}

// ===== VIEWER =====
function openViewer(pointId, photoId = null) {
  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === pointId);
  if (!point || !point.photos.length) return;

  state.activePointId = point.id;
  if (photoId && point.photos.some(p => p.id === photoId)) {
    state.activePhotoId = photoId;
    viewerGalleryIdx    = point.photos.findIndex(p => p.id === photoId);
  } else {
    state.activePhotoId = point.photos[0].id;
    viewerGalleryIdx    = 0;
  }

  refreshMarkerActive();
  renderPlanMarkers();
  _renderViewerPhoto(point, point.photos[viewerGalleryIdx]);
  updateGalleryNav();
}

async function _renderViewerPhoto(point, photo) {
  document.getElementById('viewer-panel').classList.remove('hidden');
  showResizer();
  document.getElementById('viewer-title').textContent = photo.title || 'Photo';

  document.getElementById('classic-viewer').classList.add('hidden');
  document.getElementById('panorama-viewer').classList.add('hidden');
  if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }

  // Lazy : extrait la photo de la source ZIP si pas encore en IDB.
  await _ensurePhotoImageId(photo, state.activeSiteId);
  const url = photo.imageId ? await imageStore.getURL(photo.imageId) : '';

  if (point.type === '360') {
    document.getElementById('panorama-viewer').classList.remove('hidden');
    if (url) {
      pannellumViewer = pannellum.viewer('pannellum-container', {
        type: 'equirectangular', panorama: url, autoLoad: true, showControls: true,
        northOffset: point.bearing || 0,
      });
    }
  } else {
    document.getElementById('classic-viewer').classList.remove('hidden');
    document.getElementById('classic-photo-img').src = url;
    document.getElementById('classic-photo-caption').textContent = photo.description || '';
  }

  document.getElementById('edit-photo-title').value = photo.title || '';
  document.getElementById('edit-photo-desc').value  = photo.description || '';

  document.getElementById('bearing-row').classList.remove('hidden');
  document.getElementById('edit-photo-bearing').value = Math.round(point.bearing ?? 0);

  const btnDlPhoto = document.getElementById('btn-download-photo');
  if (btnDlPhoto) {
    if (photo.imageId) {
      btnDlPhoto.classList.remove('hidden');
      btnDlPhoto.onclick = () => _downloadImage(photo.imageId, ext =>
        _sanitizeFilename(photo.title || 'photo') + (ext ? '.' + ext : '')
      );
    } else {
      btnDlPhoto.classList.add('hidden');
      btnDlPhoto.onclick = null;
    }
  }
}

function closeViewer() {
  state.activePointId = null;
  state.activePhotoId = null;
  viewerGalleryIdx    = 0;
  document.getElementById('viewer-panel').classList.add('hidden');
  hideResizer();
  if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }
  refreshMarkerActive();
  renderPlanMarkers();
}

function updateGalleryNav() {
  const point = getActivePoint();
  const ids   = point ? point.photos.map(p => p.id) : [];
  _updateGalleryNav(ids, viewerGalleryIdx);
}

function navigateGallery(delta) {
  const point = getActivePoint();
  if (!point || !point.photos.length) return;
  viewerGalleryIdx = ((viewerGalleryIdx + delta) + point.photos.length) % point.photos.length;
  const photo = point.photos[viewerGalleryIdx];
  state.activePhotoId = photo.id;
  refreshMarkerActive();
  renderPlanMarkers();
  _renderViewerPhoto(point, photo);
  updateGalleryNav();
}

// ===== PHOTO EDITOR =====
function applyEditorChanges() {
  const photo = getActivePhoto();
  if (!photo) return;
  photo.title       = document.getElementById('edit-photo-title').value;
  photo.description = document.getElementById('edit-photo-desc').value;
  document.getElementById('viewer-title').textContent = photo.title || 'Photo';
  scheduleCacheSave();
}

function applyBearingChange() {
  const point = getActivePoint();
  if (!point) return;

  const raw = document.getElementById('edit-photo-bearing').value;
  point.bearing = raw === '' ? 0 : ((parseFloat(raw) % 360) + 360) % 360;
  document.getElementById('edit-photo-bearing').value = Math.round(point.bearing);

  if (point.lat != null) refreshPointMarker(point.id);
  else renderPlanMarkers();
  scheduleCacheSave();
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
    btn.innerHTML = renderIcon(icon);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      onSelect(icon);
      bank.querySelectorAll('.icon-bank-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
    });
    bank.appendChild(btn);
  });
}

async function updateSfIllustrationPreview(imageId) {
  const p = document.getElementById('sf-illustration-preview');
  if (!imageId) {
    p.innerHTML = '<div class="illus-empty">Aucune illustration</div>';
    return;
  }
  const url = await imageStore.getURL(imageId);
  p.innerHTML = url
    ? `<img class="illus-img" src="${url}" alt="Illustration" />`
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

// (drawing functions moved to drawing.js)
// ===== INIT =====
function init() {
  drawing = initDrawing({
    getViewMode:          () => state.viewMode,
    getActiveSite,
    getActiveSitePlanId:  () => state.activeSitePlanId,
    getActiveBuildingId:  () => state.activeBuildingId,
    getActiveFloorId:     () => state.activeFloorId,
    getPlan:              () => plan,
    getMap:               () => map,
    getInteractionMode:   () => interactionMode,
    setInteractionMode:   m  => { interactionMode = m; },
    uid,
    sanitizeFilename:     _sanitizeFilename,
    getActivePlanInfo:    () => _getActivePlan(state, getActiveSite()),
    onSave:               scheduleCacheSave,
    onRefreshPlan:        renderPlanMarkers,
    setStepBanner,
    clearStepBanner,
  });

  initViewerSplitter();
  initMap();
  initSearch();
  initPlanEvents();
  drawing.initEvents();

  // ---- Top bar ----
  document.getElementById('btn-load-site').addEventListener('click', async () => {
    const picked = await _pickCadoFile();
    if (!picked) return;
    const { file, handle } = picked;
    if (state.activeSiteId) {
      pendingLoadFile   = file;
      pendingLoadHandle = handle;
      document.getElementById('close-site-name').textContent = getActiveSite()?.name || 'ce site';
      showModal('modal-close-site');
    } else {
      loadSiteFromFile(file, handle);
    }
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
    pendingLoadHandle  = null;
    pendingNavigateUrl = null;
    hideModal('modal-close-site');
  });

  // ---- Restore session modal ----
  document.getElementById('btn-restore-confirm').addEventListener('click', async () => {
    if (!_pendingRestore) return;
    const { zipEntries, pureSites } = _pendingRestore;
    _pendingRestore = null;
    hideModal('modal-restore-session');

    let firstSiteId = null;

    // requestPermission() doit être appelé immédiatement dans le handler de clic
    // (geste utilisateur). On demande toutes les permissions en parallèle.
    const perms = await Promise.all(
      zipEntries.map(({ handle }) =>
        handle ? handle.requestPermission({ mode: 'read' }) : Promise.resolve('denied')
      )
    );

    for (let i = 0; i < zipEntries.length; i++) {
      const { cachedSite, handle } = zipEntries[i];
      if (state.sites.find(s => s.id === cachedSite.id)) continue;
      let restored = false;

      if (handle && perms[i] === 'granted') {
        try {
          const freshData = await _loadSiteFromZip(await handle.getFile());
          if (freshData) {
            _applyZipDelta(freshData, cachedSite);
            imageStore.putZipHandle(freshData.id, handle).catch(() => {});
            state.sites.push(freshData);
            addSiteMarker(freshData);
            if (freshData.perimeter)   renderSitePerimeter(freshData);
            if (freshData.accessArrow) renderAccessArrow(freshData);
            if (!firstSiteId) firstSiteId = freshData.id;
            restored = true;
          }
        } catch (e) { console.warn('Reload from handle failed:', e); }
      }

      if (!restored) {
        // Fallback : restauration partielle depuis le snapshot
        delete cachedSite._deletedPhotoIds;
        delete cachedSite._cadoFilename;
        await normalizeSite(cachedSite);
        state.sites.push(cachedSite);
        addSiteMarker(cachedSite);
        if (cachedSite.perimeter)   renderSitePerimeter(cachedSite);
        if (cachedSite.accessArrow) renderAccessArrow(cachedSite);
        if (!firstSiteId) firstSiteId = cachedSite.id;
      }
    }

    for (const data of pureSites) {
      if (state.sites.find(s => s.id === data.id)) continue;
      await normalizeSite(data);
      state.sites.push(data);
      addSiteMarker(data);
      if (data.perimeter)   renderSitePerimeter(data);
      if (data.accessArrow) renderAccessArrow(data);
      if (!firstSiteId) firstSiteId = data.id;
    }

    if (firstSiteId) selectSite(firstSiteId);
    updateTopBarButtons();
  });

  document.getElementById('btn-restore-discard').addEventListener('click', () => {
    _pendingRestore = null;
    clearCacheState();
    hideModal('modal-restore-session');
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
    // Si une illustration fraîche (pas encore confirmée) existe, on libère son Blob.
    const site = sfEditingId ? state.sites.find(s => s.id === sfEditingId) : null;
    const original = site?.illustrationId || null;
    if (sfTempIllustration && sfTempIllustration !== original) {
      imageStore.deleteImage(sfTempIllustration);
    }
    sfTempIllustration = await imageStore.putBlob(file);
    updateSfIllustrationPreview(sfTempIllustration);
  });
  document.getElementById('btn-sf-clear-illustration').addEventListener('click', () => {
    sfTempIllustration = null;
    updateSfIllustrationPreview(null);
  });

  // ---- Building form ----
  document.getElementById('btn-bf-confirm').addEventListener('click', confirmBuildingForm);
  document.getElementById('btn-bf-cancel').addEventListener('click', () => hideModal('modal-add-building'));

  // ---- Edit building modal ----
  document.getElementById('btn-edit-bld-confirm').addEventListener('click', confirmEditBuilding);
  document.getElementById('btn-edit-bld-cancel').addEventListener('click', () => hideModal('modal-edit-building'));

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
    pendingPhotoTarget = null;
    pendingPhotoFiles  = [];
  });

  // ---- Plan image upload ----
  document.getElementById('btn-upload-plan').addEventListener('click', () => {
    document.getElementById('input-upload-plan').click();
  });
  document.getElementById('input-upload-plan').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const imageId = await imageStore.putBlob(file);
    updateActivePlanImage(imageId, file.name);
  });

  // ---- Viewer / editor ----
  document.getElementById('btn-close-viewer').addEventListener('click', closeViewer);
  document.getElementById('edit-photo-title').addEventListener('blur', applyEditorChanges);
  document.getElementById('edit-photo-desc').addEventListener('blur', applyEditorChanges);
  document.querySelectorAll('.dir-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('edit-photo-bearing').value = btn.dataset.bearing;
      applyBearingChange();
    });
  });

  document.getElementById('btn-edit-photo-file').addEventListener('click', () => {
    document.getElementById('input-edit-photo-file').click();
  });
  document.getElementById('input-edit-photo-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const photo = getActivePhoto();
    const point = getActivePoint();
    if (!photo || !point) return;
    if (photo.imageId) imageStore.deleteImage(photo.imageId);
    photo.imageId = await imageStore.putBlob(file);
    photo.imageFilename = file.name;
    // Photo n'est plus liée à la source ZIP (lazy obsolète après remplacement)
    delete photo.imageFile;
    delete photo.imageMime;
    await _renderViewerPhoto(point, photo);
    scheduleCacheSave();
  });

  document.getElementById('btn-delete-photo').addEventListener('click', () => {
    if (state.activePhotoId) deletePhotoFromActivePoint(state.activePhotoId);
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
      else if (interactionMode === 'move-point')           cancelMovePoint();
      else if (interactionMode === 'orient-point')         cancelOrientPoint();
      else if (interactionMode === 'move-building')        cancelMoveBuilding();
      else if (interactionMode === 'move-site')            cancelMoveSite();
      else if (interactionMode === 'orient-access-arrow') { clearStepBanner(); interactionMode = null; }
      else if (drawing.isPlanDrawing)                        drawing.cancelPlanDrawing();
      else if (interactionMode === 'map-drawing')          drawing.cancelMapDrawing();
      else if (drawing.tool) drawing.setTool(null);
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.target.matches('input,textarea,[contenteditable]')) {
      drawing.deleteSelectedShape();
    }
  });

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

  // ---- Menu mobile ----
  const btnMobileMenu = document.getElementById('btn-mobile-menu');
  const topbarActions = document.getElementById('topbar-actions');
  btnMobileMenu.addEventListener('click', () => {
    topbarActions.classList.toggle('mobile-open');
  });
  document.addEventListener('click', e => {
    if (!e.target.closest('#topbar-actions') && !e.target.closest('#btn-mobile-menu')) {
      topbarActions.classList.remove('mobile-open');
    }
  });
  topbarActions.addEventListener('click', () => {
    topbarActions.classList.remove('mobile-open');
  });
}

document.addEventListener('DOMContentLoaded', init);
