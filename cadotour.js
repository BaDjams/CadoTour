'use strict';
import {
  escapeHtml,
  makeSiteMarkerIcon,
  makeBuildingMarkerIcon as _makeBuildingMarkerIcon,
  drawPlanCanvas as _drawPlanCanvas,
  getActivePlan as _getActivePlan,
  updateGalleryNav as _updateGalleryNav,
} from './shared.js';
import * as imageStore from './imageStore.js';
import { renderIcon } from './icons.js';
import * as progress from './progress.js';
import { initViewerSplitter, showResizer, hideResizer } from './splitter.js';
import * as fflate from 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/esm/browser.js';

// ===== STATE =====
const state = {
  sites: [],
  activeSiteId: null,
  activeBuildingId: null,
  activeFloorId: null,
  activeSitePlanId: null,
  activePointId: null,
  activePhotoId: null,
  viewMode: 'map',
};

// ===== MAP & MARKERS =====
let map;
let baseLayers       = {};
let mbtilesLayer     = null;
let siteMarkers      = {};
let buildingMarkers  = {};
let pointMarkers     = {};
let pointCluster     = null;  // L.MarkerClusterGroup (lazy init)
let perimeterLayer   = null;
let accessArrowMarker = null;
let pannellumViewer  = null;
const plan = { img: null, scale: 1, offsetX: 0, offsetY: 0, dragging: false };

// ===== VIEWER GALLERY =====
let viewerGalleryIdx = 0;

// ===== PENDING LOAD =====
let pendingLoadFile = null;

// ===== CONSTANTS =====
const CLUSTER_ZOOM_THRESHOLD = 17;

// ===== UTILITIES =====
function getActiveSite() { return state.sites.find(s => s.id === state.activeSiteId) || null; }
function getActivePoint() {
  const site = getActiveSite();
  return site?.points.find(p => p.id === state.activePointId) || null;
}

// ===== MAP INIT =====
function initMap() {
  map = L.map('map', { center: [46.6, 2.3], zoom: 6 });
  const osm    = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 19,
  });
  const hybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    attribution: '© Google', maxZoom: 21,
  });
  osm.addTo(map);
  baseLayers = { 'OpenStreetMap': osm, 'Hybride': hybrid };
  L.control.layers(baseLayers).addTo(map);

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
      const def = baseLayers['Hybride'] || Object.values(baseLayers)[0];
      if (def && !map.hasLayer(def)) def.addTo(map);
    }
  };

  map.on('zoomend', updateMarkersVisibility);
}

// ===== SITE LOADING =====
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

async function _migrateLoadedSite(data, onProgress = () => {}) {
  data.address      = data.address      || '';
  data.contacts     = data.contacts     || [];
  data.icon         = data.icon         || 'landmark';
  data.buildings    = data.buildings    || [];
  data.sitePlans    = data.sitePlans    || [];
  data.points       = data.points       || [];
  data.perimeter    = data.perimeter    || null;
  data.accessArrow  = data.accessArrow  || null;

  let done = 0;
  const tick = () => { done++; onProgress(done); };

  if (typeof data.illustration === 'string' && data.illustration.startsWith('data:')) {
    data.illustrationId = await imageStore.migrateDataURL(data.illustration);
    delete data.illustration;
    tick();
  }

  for (const sp of data.sitePlans) {
    if (sp.imageDataURL) {
      sp.imageId = await imageStore.migrateDataURL(sp.imageDataURL);
      delete sp.imageDataURL;
      tick();
    }
  }

  for (const bld of data.buildings) {
    bld.floors = bld.floors || [];
    for (const fl of bld.floors) {
      if (fl.imageDataURL) {
        fl.imageId = await imageStore.migrateDataURL(fl.imageDataURL);
        delete fl.imageDataURL;
        tick();
      }
    }
  }

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

async function loadSiteFromFile(file) {
  try {
    const header = new Uint8Array(await file.slice(0, 2).arrayBuffer());
    const isZip  = header[0] === 0x50 && header[1] === 0x4B;
    let data;
    if (isZip) {
      data = await _loadSiteFromZip(file);
      if (!data) return;
    } else {
      const text = await file.text();
      data = JSON.parse(text);
      if (!Array.isArray(data.points)) {
        alert('Fichier .cado au format obsolète. Recréez-le avec la nouvelle version de CadoCreator.');
        return;
      }
      const total = countSiteImages(data);
      progress.show(`Chargement de « ${data.name || 'le site'} »…`, total);
      try {
        await _migrateLoadedSite(data, cur => progress.update(cur));
      } finally {
        progress.hide();
      }
    }

    if (state.sites.find(s => s.id === data.id)) {
      if (siteMarkers[data.id]) { siteMarkers[data.id].remove(); delete siteMarkers[data.id]; }
      state.sites = state.sites.filter(s => s.id !== data.id);
    }
    state.sites.push(data);
    addSiteMarker(data);
    if (data.perimeter)   renderSitePerimeter(data);
    if (data.accessArrow) renderAccessArrow(data);
    selectSite(data.id);
  } catch (err) {
    alert('Fichier invalide : ' + err.message);
  }
}

async function _loadSiteFromZip(file) {
  let zipFiles;
  try {
    const uint8 = new Uint8Array(await file.arrayBuffer());
    zipFiles = fflate.unzipSync(uint8);
  } catch (e) {
    throw new Error('Fichier .cado ZIP invalide : ' + e.message);
  }
  if (!zipFiles['metadata.json']) throw new Error('metadata.json manquant dans le fichier .cado');
  const data = JSON.parse(new TextDecoder().decode(zipFiles['metadata.json']));
  delete zipFiles['metadata.json'];
  if (!Array.isArray(data.points)) {
    alert('Fichier .cado au format obsolète. Recréez-le avec la nouvelle version de CadoCreator.');
    return null;
  }
  const total = countSiteImages(data);
  progress.show(`Chargement de « ${data.name || 'le site'} »…`, total);
  try {
    await _normalizeZipSite(data, zipFiles, cur => progress.update(cur));
  } finally {
    progress.hide();
  }
  return data;
}

async function _normalizeZipSite(data, zipFiles, onProgress = () => {}) {
  data.address     = data.address     || '';
  data.contacts    = data.contacts    || [];
  data.icon        = data.icon        || 'landmark';
  data.buildings   = data.buildings   || [];
  data.sitePlans   = data.sitePlans   || [];
  data.points      = data.points      || [];
  data.perimeter   = data.perimeter   || null;
  data.accessArrow = data.accessArrow || null;

  let done = 0;
  const tick = () => { done++; onProgress(done); };

  // Buffer pour batcher les écritures IndexedDB. Voir app.js _normalizeZipSite
  // pour les détails — divise les transactions IDB par ~32.
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
    const zipKey = `images/${imageFile}`;
    const arr = zipFiles[zipKey];
    if (!arr) return;
    const blob = new Blob([arr], { type: obj[mimeKey] || 'application/octet-stream' });
    delete zipFiles[zipKey];
    const filenameKey = idKey.replace(/Id$/, 'Filename');
    obj[filenameKey] = imageFile;
    delete obj[fileKey]; delete obj[mimeKey];
    buffer.push({ obj, idKey, blob });
    if (buffer.length >= BATCH_SIZE) await flush();
  };

  if (data.illustrationFile) await enqueue(data, 'illustrationFile', 'illustrationMime', 'illustrationId');
  for (const sp of data.sitePlans) await enqueue(sp, 'imageFile', 'imageMime', 'imageId');
  for (const bld of data.buildings) {
    bld.floors = bld.floors || [];
    for (const fl of bld.floors) await enqueue(fl, 'imageFile', 'imageMime', 'imageId');
  }
  for (const pt of data.points) {
    if (pt.bearing == null) pt.bearing = 0;
    pt.photos = pt.photos || [];
    for (const ph of pt.photos) await enqueue(ph, 'imageFile', 'imageMime', 'imageId');
  }
  await flush();
}

const _CT_MIME_EXT = { 'image/jpeg':'jpg','image/jpg':'jpg','image/png':'png','image/webp':'webp','image/gif':'gif','image/bmp':'bmp' };

function _sanitizeFilename(str) {
  return (str || '').replace(/[/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim() || 'fichier';
}

// nameFn peut être une chaîne ou une fonction (ext) => string.
async function _downloadImage(imageId, nameFn) {
  const blob = await imageStore.getBlob(imageId);
  if (!blob) return;
  const ext  = _CT_MIME_EXT[blob.type] || null;
  const name = typeof nameFn === 'function' ? nameFn(ext) : (nameFn || (imageId + (ext ? '.' + ext : '')));
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

// ===== SITE MARKERS =====
function addSiteMarker(site) {
  const isActive = site.id === state.activeSiteId;
  const m = L.marker([site.lat, site.lon], { icon: makeSiteMarkerIcon(site, isActive) })
    .addTo(map)
    .on('click', e => { L.DomEvent.stopPropagation(e); selectSite(site.id); });
  siteMarkers[site.id] = m;
}

function updateSiteMarkerIcon(siteId, isActive) {
  const site = state.sites.find(s => s.id === siteId);
  if (site && siteMarkers[siteId]) siteMarkers[siteId].setIcon(makeSiteMarkerIcon(site, isActive));
}

// ===== BUILDING MARKERS =====
function makeBuildingMarkerIcon(building) {
  return _makeBuildingMarkerIcon(building, building.id === state.activeBuildingId);
}

function addBuildingMarker(building) {
  const m = L.marker([building.lat, building.lon], { icon: makeBuildingMarkerIcon(building) })
    .addTo(map)
    .on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (building.floors?.length) selectFloor(building.id, building.floors[0].id);
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
    svgInner = `<path d="M0,0 L-8.28,-19.92 A21.6,21.6,0,0,1,8.28,-19.92 Z" fill="${color}" opacity="0.8"/>
                <circle r="6" fill="${color}" stroke="white" stroke-width="${sw}"/>`;
  } else if (type === 'panoramic') {
    size = 52; anchor = 26; color = '#e07b20';
    svgInner = `<path d="M0,0 L-18.72,-10.8 A21.6,21.6,0,0,1,18.72,-10.8 Z" fill="${color}" opacity="0.8"/>
                <circle r="6" fill="${color}" stroke="white" stroke-width="${sw}"/>`;
  } else if (type === 'drone') {
    size = 60; anchor = 30; color = '#8e44ad';
    svgInner = `<path d="M0,0 L-18.72,-10.8 A21.6,21.6,0,0,1,18.72,-10.8 Z" fill="${color}" opacity="0.75"/>
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
    svgInner = `<polygon points="0,-19 5,-9 0,-11 -5,-9" fill="${color}" stroke="white" stroke-width="1.5" stroke-linejoin="round" transform="rotate(${rot})"/>
                <circle r="10" fill="${color}" stroke="white" stroke-width="${sw}"/>
                <text x="0" y="0.5" text-anchor="middle" dominant-baseline="central" font-size="9" font-weight="700" fill="white">360</text>`;
  }
  // Le 360 rotate sa kite localement ; les autres font tourner toute l'icône.
  const rotateSvg = type !== '360' ? `style="transform:rotate(${rot}deg)"` : '';
  const badge = count > 1 ? `<span class="photo-count-badge">${count}</span>` : '';
  const glow  = isActive
    ? `drop-shadow(0 0 8px ${color}) drop-shadow(0 0 14px rgba(255,255,255,0.95))`
    : 'drop-shadow(0 1px 4px rgba(0,0,0,0.6))';
  const scale = isActive ? 'scale(1.15)' : '';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${size}px;height:${size}px;filter:${glow};transform:${scale};transform-origin:${anchor}px ${anchor}px">
             <svg width="${size}" height="${size}" viewBox="-${anchor} -${anchor} ${size} ${size}" ${rotateSvg} style="overflow:visible">${svgInner}</svg>
             ${badge}
           </div>`,
    iconSize: [size, size], iconAnchor: [anchor, anchor],
  });
}

function _ensurePointCluster() {
  if (pointCluster) return pointCluster;
  pointCluster = L.markerClusterGroup({
    maxClusterRadius: 60,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    chunkedLoading: true,  // ajoute les markers par paquets → plus de freeze à 4000+ points
  });
  return pointCluster;
}

function addPointMarker(point) {
  if (point.lat == null) return;
  const isActive = point.id === state.activePointId;
  const m = L.marker([point.lat, point.lon], {
    icon: makePointIcon(point.type, point.bearing, isActive, point.photos.length),
  }).on('click', e => { L.DomEvent.stopPropagation(e); openViewer(point.id); });
  pointMarkers[point.id] = m;
  _ensurePointCluster().addLayer(m);
}

function clearPointMarkers() {
  if (pointCluster) pointCluster.clearLayers();
  pointMarkers = {};
}

// ===== CLUSTER VISIBILITY =====
// À bas zoom on n'affiche que les sites ; au-delà du seuil on bascule sur
// les bâtiments + le cluster group qui regroupe les points automatiquement.
function updateMarkersVisibility() {
  if (!map || !state.activeSiteId) return;
  const clustered = map.getZoom() < CLUSTER_ZOOM_THRESHOLD;
  if (pointCluster) {
    if (clustered) map.removeLayer(pointCluster);
    else if (!map.hasLayer(pointCluster)) pointCluster.addTo(map);
  }
  Object.values(buildingMarkers).forEach(m => clustered ? m.remove() : m.addTo(map));
  Object.values(siteMarkers).forEach(m => clustered ? m.addTo(map) : m.remove());
  if (perimeterLayer)    clustered ? perimeterLayer.remove()    : perimeterLayer.addTo(map);
  if (accessArrowMarker) clustered ? accessArrowMarker.remove() : accessArrowMarker.addTo(map);
}

function refreshMarkerActive() {
  const site = getActiveSite();
  if (!site) return;
  Object.entries(pointMarkers).forEach(([id, m]) => {
    const pt = site.points.find(p => p.id === id);
    if (!pt) return;
    m.setIcon(makePointIcon(pt.type, pt.bearing, id === state.activePointId, pt.photos.length));
  });
}

// ===== PERIMETER & ACCESS ARROW =====
function renderSitePerimeter(site) {
  if (perimeterLayer) { perimeterLayer.remove(); perimeterLayer = null; }
  if (!site.perimeter?.points?.length) return;
  const pts = site.perimeter.points.map(p => [p.lat, p.lon]);
  if (pts.length > 1) pts.push(pts[0]); // ferme visuellement le tracé
  perimeterLayer = L.polyline(pts, {
    color: '#e94560', weight: 2, dashArray: '6,5',
    interactive: false, // pas de hover, pas de clic
  }).addTo(map);
}

function renderAccessArrow(site) {
  if (accessArrowMarker) { accessArrowMarker.remove(); accessArrowMarker = null; }
  if (!site.accessArrow) return;
  const rot = ((site.accessArrow.bearing || 0) + 360) % 360;
  const svg = `<svg width="32" height="32" viewBox="-16 -16 32 32" style="transform:rotate(${rot}deg)">
    <polygon points="0,-14 8,6 0,0 -8,6" fill="#e07b20" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
  </svg>`;
  accessArrowMarker = L.marker([site.accessArrow.lat, site.accessArrow.lon], {
    icon: L.divIcon({ className: '', html: svg, iconSize: [32, 32], iconAnchor: [16, 16] }),
  }).addTo(map);
}

// ===== SITE SELECTION =====
function selectSite(siteId) {
  const prev = state.activeSiteId;
  state.activeSiteId     = siteId;
  state.activeBuildingId = null;
  state.activeFloorId    = null;
  state.activeSitePlanId = null;
  state.activePointId    = null;
  state.activePhotoId    = null;

  if (prev) updateSiteMarkerIcon(prev, false);
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
    map.flyTo([site.lat, site.lon], Math.max(map.getZoom(), 17));
  }

  updateMarkersVisibility();

  renderSidebar();
  switchViewMode('map');
  closeViewer();
  renderSiteHeader();
  updateTopBarButton();
}

// ===== VIEW MODE =====
function switchViewMode(mode) {
  state.viewMode = mode;
  document.getElementById('map-container').classList.toggle('hidden', mode !== 'map');
  document.getElementById('plan-container').classList.toggle('hidden', mode !== 'plan');
  if (mode === 'map') setTimeout(() => map?.invalidateSize(), 50);
  else renderPlan();
  renderSidebar();
}

// ===== FLOOR & SITE PLAN SELECTION =====
function selectFloor(buildingId, floorId) {
  state.activeBuildingId = buildingId;
  state.activeFloorId    = floorId;
  state.activeSitePlanId = null;
  state.activePointId    = null;
  state.activePhotoId    = null;
  Object.entries(buildingMarkers).forEach(([id, m]) => {
    const bld = getActiveSite()?.buildings.find(b => b.id === id);
    if (bld) m.setIcon(makeBuildingMarkerIcon(bld));
  });
  switchViewMode('plan');
  closeViewer();
  renderSidebar();
}

function selectSitePlan(spId) {
  state.activeBuildingId = null;
  state.activeFloorId    = null;
  state.activeSitePlanId = spId;
  state.activePointId    = null;
  state.activePhotoId    = null;
  switchViewMode('plan');
  closeViewer();
  renderSidebar();
}

// ===== SIDEBAR =====
function renderSiteHeader() {
  const site = getActiveSite();
  document.getElementById('site-header-icon').innerHTML = site ? renderIcon(site.icon || 'landmark') : '';
  document.getElementById('site-header-name').textContent = site ? site.name : 'Aucun site chargé';
}

function renderSidebar() {
  const nav  = document.getElementById('sidebar-nav');
  const site = getActiveSite();
  nav.innerHTML = '';

  if (!site) {
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:16px 12px;color:var(--color-text-muted);font-size:12px;line-height:1.5';
    hint.textContent = 'Chargez un fichier .cado pour démarrer la visite.';
    nav.appendChild(hint);
    return;
  }

  if (state.sites.length > 1) {
    const sel = document.createElement('select');
    sel.className = 'input-field';
    sel.style.cssText = 'margin:8px;width:calc(100% - 16px)';
    state.sites.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = (s.icon || '🏛') + ' ' + s.name;
      opt.selected = s.id === state.activeSiteId;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => selectSite(sel.value));
    nav.appendChild(sel);
  }

  appendNavItem(nav, {
    icon: '🗺', label: 'Carte extérieure',
    active: state.viewMode === 'map',
    onClick: () => switchViewMode('map'),
  });

  if (site.sitePlans?.length) {
    appendDivider(nav, 'Plans du site');
    site.sitePlans.forEach(sp => appendNavItem(nav, {
      icon: '🗃', label: sp.name,
      active: state.activeSitePlanId === sp.id,
      onClick: () => selectSitePlan(sp.id),
    }));
  }

  if (site.buildings?.length) {
    appendDivider(nav, 'Bâtiments');
    site.buildings.forEach(building => {
      const bh = document.createElement('div');
      bh.className = 'nav-building-header';
      bh.innerHTML = `<span class="nav-bld-icon">${renderIcon(building.icon || 'building')}</span>
                      <span style="flex:1">${escapeHtml(building.name)}</span>`;
      nav.appendChild(bh);
      (building.floors || []).forEach(floor => appendNavItem(nav, {
        icon: '📐', label: floor.name,
        active: state.activeFloorId === floor.id && state.activeBuildingId === building.id,
        sub: true,
        onClick: () => selectFloor(building.id, floor.id),
      }));
    });
  }
}

function appendDivider(nav, text) {
  const d = document.createElement('div');
  d.className = 'nav-divider'; d.textContent = text;
  nav.appendChild(d);
}

function appendNavItem(nav, { icon, label, active, sub, onClick }) {
  const item = document.createElement('div');
  item.className = 'nav-item' + (active ? ' active' : '') + (sub ? ' nav-sub' : '');
  item.innerHTML = `<span class="nav-item-icon">${icon}</span>
                    <span class="nav-item-label">${escapeHtml(label)}</span>`;
  item.addEventListener('click', onClick);
  nav.appendChild(item);
}

// ===== PLAN RENDERING =====
function getActivePlan() { return _getActivePlan(state, getActiveSite()); }

async function renderPlan() {
  const active = getActivePlan();
  document.getElementById('plan-floor-name').textContent = active?.label || 'Plan';

  const btnDl = document.getElementById('btn-download-plan');
  if (btnDl) {
    if (active?.imageId) {
      btnDl.classList.remove('hidden');
      btnDl.onclick = () => {
        const site = getActiveSite();
        _downloadImage(active.imageId, ext =>
          _sanitizeFilename(`${site?.name || 'site'}_${active.label}`) + (ext ? '.' + ext : '')
        );
      };
    } else {
      btnDl.classList.add('hidden');
      btnDl.onclick = null;
    }
  }

  const canvas   = document.getElementById('plan-canvas');
  const viewport = document.getElementById('plan-viewport');
  const url = active?.imageId ? await imageStore.getURL(active.imageId) : null;
  if (!url) { canvas.width = 0; canvas.height = 0; renderPlanMarkers(); return; }
  const img = new Image();
  img.onload = () => {
    plan.img = img;
    const vw = viewport.clientWidth, vh = viewport.clientHeight;
    plan.scale   = Math.min(vw / img.width, vh / img.height, 1);
    plan.offsetX = (vw - img.width  * plan.scale) / 2;
    plan.offsetY = (vh - img.height * plan.scale) / 2;
    drawPlanCanvas();
    renderPlanMarkers();
  };
  img.src = url;
}

function drawPlanCanvas() { _drawPlanCanvas(plan); }

function renderPlanMarkers() {
  const svg = document.getElementById('plan-overlay');
  svg.innerHTML = '';
  const site = getActiveSite();
  if (!site) return;

  let points = [];
  if (state.activeSitePlanId) {
    points = site.points.filter(p => p.sitePlanId === state.activeSitePlanId && p.planX != null);
  } else if (state.activeBuildingId && state.activeFloorId) {
    points = site.points.filter(p =>
      p.buildingId === state.activeBuildingId && p.floorId === state.activeFloorId && p.planX != null
    );
  }

  points.forEach(point => {
    const sx = point.planX * plan.scale + plan.offsetX;
    const sy = point.planY * plan.scale + plan.offsetY;
    const isActive = point.id === state.activePointId;
    const color = point.type === '360' ? '#2980b9' : point.type === 'panoramic' ? '#e07b20' : point.type === 'drone' ? '#8e44ad' : '#e94560';

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'plan-pin' + (isActive ? ' plan-pin-active' : ''));
    g.setAttribute('transform', `translate(${sx},${sy})${isActive ? ' scale(1.15)' : ''}`);
    if (isActive) g.setAttribute('style', `filter: drop-shadow(0 0 6px ${color}) drop-shadow(0 0 10px rgba(255,255,255,0.9))`);

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
      if (point.type === 'normal') wedge.setAttribute('d', 'M0,0 L-6,-14.4 A15.6,15.6,0,0,1,6,-14.4 Z');
      else                         wedge.setAttribute('d', 'M0,0 L-13.2,-7.8 A15.6,15.6,0,0,1,13.2,-7.8 Z');
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

    g.addEventListener('click', () => openViewer(point.id));
    svg.appendChild(g);
  });
}

function initPlanEvents() {
  const viewport = document.getElementById('plan-viewport');

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    plan.offsetX = mx - (mx - plan.offsetX) * factor;
    plan.offsetY = my - (my - plan.offsetY) * factor;
    plan.scale  *= factor;
    drawPlanCanvas();
    renderPlanMarkers();
  }, { passive: false });

  let dragStart = { x: 0, y: 0 };
  viewport.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    plan.dragging = true;
    dragStart = { x: e.clientX - plan.offsetX, y: e.clientY - plan.offsetY };
  });
  window.addEventListener('mousemove', e => {
    if (!plan.dragging) return;
    plan.offsetX = e.clientX - dragStart.x;
    plan.offsetY = e.clientY - dragStart.y;
    drawPlanCanvas();
    renderPlanMarkers();
  });
  window.addEventListener('mouseup', () => { plan.dragging = false; });
}

// ===== PHOTO VIEWER =====
function openViewer(pointId) {
  const site  = getActiveSite();
  const point = site?.points.find(p => p.id === pointId);
  if (!point || !point.photos.length) return;

  state.activePointId = point.id;
  state.activePhotoId = point.photos[0].id;
  viewerGalleryIdx    = 0;

  refreshMarkerActive();
  renderPlanMarkers();
  _renderViewerPhoto(point, point.photos[0]);
  updateGalleryNav();
}

async function _renderViewerPhoto(point, photo) {
  document.getElementById('viewer-panel').classList.remove('hidden');
  showResizer();
  document.getElementById('viewer-title').textContent = photo.title || 'Photo';

  document.getElementById('classic-viewer').classList.add('hidden');
  document.getElementById('panorama-viewer').classList.add('hidden');
  if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }

  const url = photo.imageId ? await imageStore.getURL(photo.imageId) : '';

  if (point.type === '360') {
    document.getElementById('panorama-viewer').classList.remove('hidden');
    if (url) {
      pannellumViewer = pannellum.viewer('pannellum-container', {
        type: 'equirectangular', panorama: url,
        autoLoad: true, showControls: true,
        northOffset: point.bearing || 0,
      });
    }
  } else {
    document.getElementById('classic-viewer').classList.remove('hidden');
    document.getElementById('classic-photo-img').src = url;
    document.getElementById('classic-photo-caption').textContent = photo.description || '';
  }

  const descRow  = document.getElementById('viewer-desc-row');
  const descText = document.getElementById('viewer-desc-text');
  if (descRow && descText) {
    if (photo.description) {
      descRow.style.display = '';
      descText.textContent  = photo.description;
    } else {
      descRow.style.display = 'none';
    }
  }

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

// ===== CLOSE SITE =====
function updateTopBarButton() {
  document.getElementById('btn-close-site').disabled = !state.activeSiteId;
}

function showCloseSiteModal(name) {
  document.getElementById('close-site-name').textContent = name;
  document.getElementById('modal-close-site').classList.remove('hidden');
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function hideCloseSiteModal() {
  document.getElementById('modal-close-site').classList.add('hidden');
  document.getElementById('modal-backdrop').classList.add('hidden');
}

function closeSite() {
  const site = getActiveSite();
  if (!site) return;
  showCloseSiteModal(site.name || 'ce site');
}

function _doCloseSite() {
  hideCloseSiteModal();
  const siteId = state.activeSiteId;
  if (!siteId) return;

  state.activeSiteId     = null;
  state.activeBuildingId = null;
  state.activeFloorId    = null;
  state.activeSitePlanId = null;
  state.activePointId    = null;
  state.activePhotoId    = null;

  clearBuildingMarkers();
  clearPointMarkers();
  if (siteMarkers[siteId]) { siteMarkers[siteId].remove(); delete siteMarkers[siteId]; }
  if (perimeterLayer)    { perimeterLayer.remove();    perimeterLayer    = null; }
  if (accessArrowMarker) { accessArrowMarker.remove(); accessArrowMarker = null; }

  state.sites = state.sites.filter(s => s.id !== siteId);

  closeViewer();
  renderSidebar();
  renderSiteHeader();
  updateTopBarButton();
  if (state.viewMode !== 'map') switchViewMode('map');

  const fileToLoad = pendingLoadFile;
  pendingLoadFile = null;
  if (fileToLoad) loadSiteFromFile(fileToLoad);
}

// ===== INIT =====
function init() {
  initViewerSplitter();
  initMap();
  initPlanEvents();
  renderSiteHeader();
  renderSidebar();

  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.cado,.json';
  inp.addEventListener('change', e => {
    const file = e.target.files[0];
    inp.value = '';
    if (!file) return;
    if (state.activeSiteId) {
      pendingLoadFile = file;
      showCloseSiteModal(getActiveSite()?.name || 'ce site');
    } else {
      loadSiteFromFile(file);
    }
  });
  document.getElementById('btn-load-site').addEventListener('click', () => inp.click());
  document.getElementById('btn-close-site').addEventListener('click', closeSite);
  document.getElementById('btn-close-viewer').addEventListener('click', closeViewer);
  document.getElementById('btn-viewer-prev').addEventListener('click', () => navigateGallery(-1));
  document.getElementById('btn-viewer-next').addEventListener('click', () => navigateGallery(+1));
  document.getElementById('btn-viewer-fullscreen').addEventListener('click', () => {
    const wrap = document.getElementById('viewer-media-wrap');
    if (!document.fullscreenElement) wrap.requestFullscreen?.();
    else document.exitFullscreen?.();
  });
  const _onFsChange = () => {
    const btn = document.getElementById('btn-viewer-fullscreen');
    if (document.fullscreenElement) { btn.textContent = '✕'; btn.title = 'Quitter le plein écran'; }
    else                            { btn.textContent = '⛶'; btn.title = 'Plein écran'; }
  };
  document.addEventListener('fullscreenchange', _onFsChange);
  document.addEventListener('webkitfullscreenchange', _onFsChange);

  document.getElementById('btn-close-confirm').addEventListener('click', _doCloseSite);
  document.getElementById('btn-close-cancel').addEventListener('click', () => {
    pendingLoadFile = null;
    hideCloseSiteModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape')     closeViewer();
    if (e.key === 'ArrowLeft')  navigateGallery(-1);
    if (e.key === 'ArrowRight') navigateGallery(+1);
  });

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
