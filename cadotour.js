'use strict';
import {
  escapeHtml, escapeAttr,
  findPhotoSiblings as _findPhotoSiblings,
  makeSiteMarkerIcon,
  makeBuildingMarkerIcon as _makeBuildingMarkerIcon,
  drawPlanCanvas as _drawPlanCanvas,
  getActivePlan as _getActivePlan,
  updateGalleryNav as _updateGalleryNav,
} from './shared.js';

// ===== STATE =====
const state = {
  sites: [],
  activeSiteId: null,
  activeBuildingId: null,
  activeFloorId: null,
  activeSitePlanId: null,
  activePhotoId: null,
  viewMode: 'map',
};

// ===== MAP & MARKERS =====
let map;
let baseLayers       = {};
let mbtilesLayer     = null;
let siteMarkers      = {};
let buildingMarkers  = {};
let photoMarkers     = {};
let perimeterLayer   = null;
let accessArrowMarker = null;
let pannellumViewer  = null;
const plan = { img: null, scale: 1, offsetX: 0, offsetY: 0, dragging: false };

// ===== VIEWER GALLERY =====
let viewerGallery    = [];
let viewerGalleryIdx = 0;

// ===== PENDING LOAD =====
let pendingLoadFile = null;

// ===== UTILITIES =====
function getActiveSite() { return state.sites.find(s => s.id === state.activeSiteId) || null; }
function findPhotoSiblings(photo) { return _findPhotoSiblings(photo, getActiveSite()?.photos ?? []); }

// ===== MAP INIT =====
function initMap() {
  map = L.map('map', { center: [46.6, 2.3], zoom: 6 });
  const osm    = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 22,
  });
  const hybrid = L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
    attribution: '© Google', maxZoom: 22,
  });
  hybrid.addTo(map);
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
}

// ===== SITE LOADING =====
function loadSiteFromFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      // Ensure fields exist (compatibility with creator)
      data.address      = data.address      || '';
      data.contacts     = data.contacts     || [];
      data.icon         = data.icon         || '🏛';
      data.illustration = data.illustration || null;
      data.buildings    = data.buildings    || [];
      data.sitePlans    = data.sitePlans    || [];
      data.photos       = data.photos       || [];
      data.perimeter    = data.perimeter    || null;
      data.accessArrow  = data.accessArrow  || null;
      // Migrate old format
      if (data.floors?.length && !data.buildings.length) {
        data.buildings.push({ id: 'b0', name: 'Bâtiment principal', lat: data.lat, lon: data.lon, icon: '🏢', floors: data.floors });
      }
      delete data.floors;
      data.photos.forEach(p => {
        if (p.type === 'classic') p.type = 'normal';
        if (p.bearing == null) p.bearing = 0;
        p.buildingId = p.buildingId ?? null;
        p.sitePlanId = p.sitePlanId ?? null;
      });
      // Replace if already loaded
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
  };
  reader.readAsText(file);
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

// ===== PHOTO MARKERS =====
function makePhotoIcon(type, bearing, isActive, count = 1) {
  const rot = ((bearing || 0) + 360) % 360;
  let svgInner, size, anchor;
  if (type === 'normal') {
    size = 44; anchor = 22;
    svgInner = `<path d="M0,0 L-6.9,-16.6 A18,18,0,0,1,6.9,-16.6 Z" fill="#e94560" opacity="0.8"/>
                <circle r="6" fill="#e94560" stroke="white" stroke-width="${isActive ? 2.5 : 1.5}"/>`;
  } else if (type === 'panoramic') {
    size = 48; anchor = 24;
    svgInner = `<path d="M0,0 L-20.8,-12 A24,24,0,0,1,20.8,-12 Z" fill="#e07b20" opacity="0.8"/>
                <circle r="6" fill="#e07b20" stroke="white" stroke-width="${isActive ? 2.5 : 1.5}"/>`;
  } else {
    size = 40; anchor = 20;
    svgInner = `<circle r="17" fill="#2980b9" opacity="0.35" stroke="#2980b9" stroke-width="1.5"/>
                <circle r="6" fill="#2980b9" stroke="white" stroke-width="${isActive ? 2.5 : 1.5}"/>`;
  }
  const rotateSvg = type !== '360' ? `style="transform:rotate(${rot}deg)"` : '';
  const badge = count > 1 ? `<span class="photo-count-badge">${count}</span>` : '';
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:${size}px;height:${size}px">
             <svg width="${size}" height="${size}" viewBox="-${anchor} -${anchor} ${size} ${size}" ${rotateSvg}>${svgInner}</svg>
             ${badge}
           </div>`,
    iconSize: [size, size], iconAnchor: [anchor, anchor],
  });
}

function addPhotoMarker(photo) {
  if (photo.lat == null) return;
  const count = findPhotoSiblings(photo).length;
  const m = L.marker([photo.lat, photo.lon], { icon: makePhotoIcon(photo.type, photo.bearing, false, count) })
    .addTo(map)
    .on('click', e => { L.DomEvent.stopPropagation(e); openViewer(photo.id); });
  photoMarkers[photo.id] = m;
}

function clearPhotoMarkers() {
  Object.values(photoMarkers).forEach(m => m.remove());
  photoMarkers = {};
}

function refreshMarkerActive() {
  const site = getActiveSite();
  if (!site) return;
  Object.keys(photoMarkers).forEach(id => {
    const p = site.photos.find(ph => ph.id === id);
    if (!p) return;
    const siblings = findPhotoSiblings(p);
    photoMarkers[id].setIcon(makePhotoIcon(p.type, p.bearing, siblings.includes(state.activePhotoId), siblings.length));
  });
}

// ===== PERIMETER & ACCESS ARROW =====
function renderSitePerimeter(site) {
  if (perimeterLayer) { perimeterLayer.remove(); perimeterLayer = null; }
  if (!site.perimeter?.points?.length) return;
  perimeterLayer = L.polygon(site.perimeter.points.map(p => [p.lat, p.lon]), {
    color: '#e94560', weight: 2, dashArray: '6,5', fillOpacity: 0.04,
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
  state.activePhotoId    = null;

  if (prev) updateSiteMarkerIcon(prev, false);
  updateSiteMarkerIcon(siteId, true);

  clearBuildingMarkers();
  clearPhotoMarkers();

  const site = getActiveSite();
  if (site) {
    (site.buildings || []).forEach(b => addBuildingMarker(b));
    // Un seul marker par position unique (point pouvant contenir plusieurs photos)
    const mapPhotos = (site.photos || []).filter(p => !p.floorId && !p.sitePlanId && p.lat != null);
    const seenPos = new Set();
    mapPhotos.forEach(p => {
      const key = `${p.lat},${p.lon}`;
      if (!seenPos.has(key)) { seenPos.add(key); addPhotoMarker(p); }
    });
    if (site.perimeter)   renderSitePerimeter(site);
    if (site.accessArrow) renderAccessArrow(site);
    map.flyTo([site.lat, site.lon], Math.max(map.getZoom(), 17));
  }

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
  state.activePhotoId    = null;
  switchViewMode('plan');
  closeViewer();
  renderSidebar();
}

// ===== SIDEBAR =====
function renderSiteHeader() {
  const site = getActiveSite();
  document.getElementById('site-header-icon').textContent = site ? (site.icon || '🏛') : '';
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

  // Multi-site selector
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
      bh.innerHTML = `<span>${escapeHtml(building.icon || '🏢')}</span>
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

function renderPlan() {
  const active = getActivePlan();
  document.getElementById('plan-floor-name').textContent = active?.label || 'Plan';
  const canvas   = document.getElementById('plan-canvas');
  const viewport = document.getElementById('plan-viewport');
  if (!active?.imageDataURL) { canvas.width = 0; canvas.height = 0; renderPlanMarkers(); return; }
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
  img.src = active.imageDataURL;
}

function drawPlanCanvas() { _drawPlanCanvas(plan); }

function renderPlanMarkers() {
  const svg = document.getElementById('plan-overlay');
  svg.innerHTML = '';
  const site = getActiveSite();
  if (!site) return;

  let photos = [];
  if (state.activeSitePlanId) {
    photos = site.photos.filter(p => p.sitePlanId === state.activeSitePlanId && p.planX != null);
  } else if (state.activeBuildingId && state.activeFloorId) {
    photos = site.photos.filter(p =>
      p.buildingId === state.activeBuildingId && p.floorId === state.activeFloorId && p.planX != null
    );
  }

  const seenPlanPos = new Set();
  photos.forEach(photo => {
    const posKey = `${photo.planX},${photo.planY}`;
    if (seenPlanPos.has(posKey)) return;
    seenPlanPos.add(posKey);

    const sx = photo.planX * plan.scale + plan.offsetX;
    const sy = photo.planY * plan.scale + plan.offsetY;
    const isActive = findPhotoSiblings(photo).includes(state.activePhotoId);
    const color = photo.type === '360' ? '#2980b9' : photo.type === 'panoramic' ? '#e07b20' : '#e94560';

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'plan-pin');
    g.setAttribute('transform', `translate(${sx},${sy})`);

    const wedge = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    if (photo.type === 'normal')       wedge.setAttribute('d', 'M0,0 L-5,-12 A13,13,0,0,1,5,-12 Z');
    else if (photo.type === 'panoramic') wedge.setAttribute('d', 'M0,0 L-11,-6.5 A13,13,0,0,1,11,-6.5 Z');
    else                                wedge.setAttribute('d', 'M0,-11 A11,11,0,1,1,-0.01,-11 Z');
    wedge.setAttribute('fill', color);
    wedge.setAttribute('opacity', '0.6');
    wedge.setAttribute('transform', `rotate(${photo.bearing || 0})`);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', isActive ? 7 : 5.5);
    circle.setAttribute('fill', color);
    circle.setAttribute('stroke', 'white');
    circle.setAttribute('stroke-width', isActive ? 2 : 1.5);
    circle.setAttribute('class', 'plan-pin-circle');

    g.appendChild(wedge);
    g.appendChild(circle);

    const siblings = findPhotoSiblings(photo);
    if (siblings.length > 1) {
      const br = 6;
      const r = isActive ? 7 : 5.5;
      const bx = r + br - 1, by = -(r + br - 1);
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
      badgeTxt.textContent = siblings.length;
      g.appendChild(badgeBg); g.appendChild(badgeTxt);
    }

    g.addEventListener('click', () => openViewer(photo.id));
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
function openViewer(photoId) {
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === photoId);
  if (!photo) return;

  viewerGallery    = findPhotoSiblings(photo);
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
        type: 'equirectangular', panorama: photo.dataURL,
        autoLoad: true, showControls: true,
        northOffset: photo.bearing || 0,
      });
    }
  } else {
    document.getElementById('classic-viewer').classList.remove('hidden');
    document.getElementById('classic-photo-img').src = photo.dataURL || '';
    document.getElementById('classic-photo-caption').textContent = photo.description || '';
  }

  const descRow  = document.getElementById('viewer-desc-row');
  const descText = document.getElementById('viewer-desc-text');
  if (photo.description) {
    descRow.style.display = '';
    descText.textContent  = photo.description;
  } else {
    descRow.style.display = 'none';
  }
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
  state.activePhotoId = null;
  viewerGallery       = [];
  viewerGalleryIdx    = 0;
  document.getElementById('viewer-panel').classList.add('hidden');
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
  state.activePhotoId    = null;

  clearBuildingMarkers();
  clearPhotoMarkers();
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
}

document.addEventListener('DOMContentLoaded', init);
