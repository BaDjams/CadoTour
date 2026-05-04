// app.js — Virtual Tour application
// Multi-site architecture: state.sites[] + state.activeSiteId

// ===== STATE =====
let state = {
  sites: [],           // all loaded/created sites
  activeSiteId: null,  // currently selected site id
  activeFloorId: null,
  activePhotoId: null,
  viewMode: 'map',     // 'map' | 'plan'
};

// ===== MAP =====
let map = null;
let siteMarkers  = {};   // siteId  -> L.Marker
let photoMarkers = {};   // photoId -> L.Marker
let searchResultMarker = null;

// ===== FLOOR PLAN =====
let plan = { img: null, scale: 1, offsetX: 0, offsetY: 0, dragging: false, dragStart: null };

// ===== PANNELLUM =====
let pannellumViewer = null;
let galleryPannellumViewer = null;

// ===== GALLERY =====
let galleryGroupId = null;  // id of the group photo being shown
let galleryIndex = 0;

// ===== PHOTO ADDITION =====
let pendingPhotoType = null;
let pendingPhotoPos  = null;   // { lat, lon } or { planX, planY, floorId }

// ===== SITE FORM TEMP =====
let sfEditingId = null;        // null=creating, string=editing
let sfTempContacts = [];
let sfTempIcon = '🏛';
let sfTempIllustration = undefined;  // undefined=unchanged, null=cleared, str=new

// ===== SEARCH =====
let searchTimer = null;

// ===== CONSTANTS =====
const SITE_ICONS = [
  '🏛','🏰','🏯','🏟','🏗','🏠','🏡','🏢','🏣','🏤','🏥','🏦','🏨','🏪','🏫','🏭',
  '🗺','🗼','🗽','🌁','🌃','🌆','🌇','🌉','🎡','🎢','🎪','⛩','🕌','🕍','⛪','🛕',
  '🏔','🌋','⛰','🗻','🏕','🏖','🏝','🌊','🏜','🌄','🌅','🌌','🏁','🔭','🎭','🏺',
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

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
  const anyOpen = ['modal-site-form','modal-add-photo','modal-add-floor'].some(
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

  map = L.map('map').setView([46.6, 2.3], 6);   // France

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 20,
  }).addTo(map);

  map.on('click', onMapClick);
}

// ===== MAP CLICK =====
function onMapClick(e) {
  const lat = e.latlng.lat;
  const lon = e.latlng.lng;

  if (!state.activeSiteId) {
    // No site selected: offer to create one
    showMapPopup(e.latlng, [
      { label: '📍 Créer un site ici', action: () => openSiteForm(null, lat, lon, '') },
    ]);
  } else {
    // Site selected (map mode): offer to add a photo
    showMapPopup(e.latlng, [
      { label: '📷 Photo classique', action: () => startAddPhotoAt(lat, lon, 'classic') },
      { label: '⬡ Photo 360°',       action: () => startAddPhotoAt(lat, lon, '360') },
      { label: '⊞ Groupe de photos', action: () => startAddPhotoAt(lat, lon, 'group') },
    ]);
  }
}

function showMapPopup(latlng, items) {
  let html = '<div class="map-popup">';
  items.forEach((item, i) => {
    html += `<button class="map-popup-btn" data-idx="${i}">${escapeHtml(item.label)}</button>`;
  });
  html += '</div>';

  const popup = L.popup({ closeButton: false, className: 'vt-leaflet-popup' })
    .setLatLng(latlng)
    .setContent(html);

  popup.on('add', function () {
    const el = this.getElement();
    el.querySelectorAll('[data-idx]').forEach(btn => {
      btn.addEventListener('click', () => {
        map.closePopup();
        items[parseInt(btn.dataset.idx, 10)].action();
      });
    });
  });

  popup.openOn(map);
}

// ===== ADDRESS SEARCH (api-adresse.data.gouv.fr) =====
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

  searchResultMarker = L.marker([lat, lon], { icon })
    .addTo(map)
    .on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      showMapPopup(L.latLng(lat, lon), [
        {
          label: !state.activeSiteId
            ? '📍 Créer un site ici'
            : '📷 Ajouter une photo ici',
          action: () => !state.activeSiteId
            ? openSiteForm(null, lat, lon, label)
            : showPhotoTypePopup(lat, lon),
        },
      ]);
    });

  map.setView([lat, lon], 16);
}

function showPhotoTypePopup(lat, lon) {
  showMapPopup(L.latLng(lat, lon), [
    { label: '📷 Photo classique', action: () => startAddPhotoAt(lat, lon, 'classic') },
    { label: '⬡ Photo 360°',       action: () => startAddPhotoAt(lat, lon, '360') },
    { label: '⊞ Groupe de photos', action: () => startAddPhotoAt(lat, lon, 'group') },
  ]);
}

// ===== SITE MANAGEMENT =====
function openSiteForm(siteId, lat, lon, address) {
  sfEditingId = siteId;

  const site = siteId ? state.sites.find(s => s.id === siteId) : null;
  document.getElementById('modal-site-form-title').textContent = site ? 'Options du site' : 'Nouveau site';
  document.getElementById('btn-sf-confirm').textContent = site ? 'Sauvegarder' : 'Créer le site';

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
    // Edit existing
    const site = state.sites.find(s => s.id === sfEditingId);
    if (site) {
      site.name    = name;
      site.address = address;
      if (!isNaN(lat)) site.lat = lat;
      if (!isNaN(lon)) site.lon = lon;
      site.icon     = sfTempIcon;
      site.contacts = JSON.parse(JSON.stringify(sfTempContacts));
      if (sfTempIllustration !== undefined) site.illustration = sfTempIllustration;

      // Rebuild site marker
      removeSiteMarker(site.id);
      addSiteMarker(site);
      renderSidebar();
    }
  } else {
    // Create new
    if (isNaN(lat) || isNaN(lon)) { alert('Les coordonnées GPS sont requises. Cliquez sur la carte.'); return; }
    const site = {
      id: uid(),
      name,
      address,
      lat,
      lon,
      icon: sfTempIcon,
      illustration: sfTempIllustration !== undefined ? sfTempIllustration : null,
      contacts: JSON.parse(JSON.stringify(sfTempContacts)),
      floors: [],
      photos: [],
    };
    state.sites.push(site);
    addSiteMarker(site);
    selectSite(site.id);
  }

  hideModal('modal-site-form');
  updateTopBarButtons();
}

function loadSiteFromFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      // Migration: ensure new fields
      data.address     = data.address     || '';
      data.contacts    = data.contacts    || [];
      data.icon        = data.icon        || '🏛';
      data.illustration = data.illustration || null;
      // Ensure classic and 360° photos on map have bearing
      (data.photos || []).forEach(p => {
        if ((p.type === 'classic' || p.type === '360') && !p.floorId && p.bearing == null) p.bearing = 0;
      });

      // Avoid duplicates by id
      if (state.sites.find(s => s.id === data.id)) {
        if (!confirm(`Un site "${data.name}" est déjà chargé. Remplacer ?`)) return;
        removeSiteMarker(data.id);
        state.sites = state.sites.filter(s => s.id !== data.id);
      }

      state.sites.push(data);
      addSiteMarker(data);

      if (state.sites.length === 1) selectSite(data.id);
      updateTopBarButtons();
    } catch (err) {
      alert('Fichier JSON invalide : ' + err.message);
    }
  };
  reader.readAsText(file);
}

function saveSite() {
  const site = getActiveSite();
  if (!site) return;
  const json = JSON.stringify(site, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = (site.name || 'site') + '.vt.json';
  a.click();
  URL.revokeObjectURL(url);
}

function selectSite(siteId) {
  const prev = state.activeSiteId;
  state.activeSiteId = siteId;
  state.activeFloorId = null;
  state.activePhotoId = null;

  // Update site marker visuals
  if (prev && siteMarkers[prev]) {
    const prevSite = state.sites.find(s => s.id === prev);
    if (prevSite) updateSiteMarkerIcon(prev, false);
  }
  updateSiteMarkerIcon(siteId, true);

  // Clear old photo markers, show new ones
  clearPhotoMarkers();
  const site = getActiveSite();
  if (site) {
    (site.photos || []).filter(p => !p.floorId && p.lat != null).forEach(p => addPhotoMarker(p));
  }

  renderSidebar();
  switchViewMode('map');
  updateTopBarButtons();
  closeViewer();

  // Update sidebar header
  renderSiteHeader();
}

function deselectSite() {
  if (!state.activeSiteId) return;
  const prev = state.activeSiteId;
  state.activeSiteId = null;
  state.activeFloorId = null;
  state.activePhotoId = null;

  updateSiteMarkerIcon(prev, false);
  clearPhotoMarkers();
  renderSidebar();
  renderSiteHeader();
  updateTopBarButtons();
  closeViewer();

  // Go back to map if in plan mode
  if (state.viewMode !== 'map') switchViewMode('map');
}

function updateTopBarButtons() {
  const hasSite = !!state.activeSiteId;
  document.getElementById('btn-save-site').disabled   = !hasSite;
  document.getElementById('btn-export-site').disabled = !hasSite;
}

// ===== SITE MARKERS =====
function makeSiteMarkerIcon(site, isActive) {
  return L.divIcon({
    className: '',
    html: `<div class="site-marker ${isActive ? 'active' : ''}">
             <div class="site-marker-bubble" title="${escapeAttr(site.name)}">${site.icon || '🏛'}</div>
             <div class="site-marker-name">${escapeHtml(site.name)}</div>
           </div>`,
    iconSize: [120, 54],
    iconAnchor: [60, 54],
  });
}

function addSiteMarker(site) {
  if (!map) return;
  const isActive = site.id === state.activeSiteId;
  const m = L.marker([site.lat, site.lon], { icon: makeSiteMarkerIcon(site, isActive) })
    .addTo(map)
    .on('click', e => {
      L.DomEvent.stopPropagation(e);
      if (state.activeSiteId === site.id) {
        // Already selected: show site options popup
        showMapPopup(L.latLng(site.lat, site.lon), [
          { label: '⚙ Options du site',   action: () => openSiteForm(site.id) },
          { label: '✕ Désélectionner',     action: () => deselectSite() },
        ]);
      } else {
        selectSite(site.id);
      }
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

function renderAllSiteMarkers() {
  state.sites.forEach(site => {
    if (!siteMarkers[site.id]) addSiteMarker(site);
  });
}

// ===== PHOTO MARKERS =====
function addPhotoMarker(photo) {
  if (!map) return;

  const hasBearing = photo.type === 'classic' && photo.bearing != null;
  const emoji = photo.type === '360' ? '⬡' : photo.type === 'group' ? '⊞' : '📷';

  let html, iconSize, iconAnchor;

  if (hasBearing) {
    html = `<div class="vt-marker-wrap">
      <div class="vt-fov-container" style="transform:rotate(${photo.bearing}deg)">
        <div class="vt-fov-arrow"></div>
        <div class="vt-fov-handle"></div>
      </div>
      <div class="vt-marker type-${photo.type}" title="${escapeAttr(photo.title || '')}">${emoji}</div>
    </div>`;
    iconSize   = [54, 54];
    iconAnchor = [27, 27];
  } else {
    html = `<div class="vt-marker type-${photo.type}" title="${escapeAttr(photo.title || '')}">${emoji}</div>`;
    iconSize   = [26, 26];
    iconAnchor = [13, 13];
  }

  const icon = L.divIcon({ className: '', html, iconSize, iconAnchor });

  const m = L.marker([photo.lat, photo.lon], { icon })
    .addTo(map)
    .on('click', e => { L.DomEvent.stopPropagation(e); openViewer(photo.id); })
    .on('mouseover', function () {
      this.getElement()?.querySelector('.vt-marker')?.classList.add('hovered');
    })
    .on('mouseout', function () {
      this.getElement()?.querySelector('.vt-marker')?.classList.remove('hovered');
    });

  photoMarkers[photo.id] = m;

  if (hasBearing) setTimeout(() => initBearingDrag(m, photo.id), 0);
}

function removePhotoMarker(photoId) {
  if (photoMarkers[photoId]) { photoMarkers[photoId].remove(); delete photoMarkers[photoId]; }
}

function clearPhotoMarkers() {
  Object.keys(photoMarkers).forEach(id => { photoMarkers[id].remove(); });
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
  Object.entries(photoMarkers).forEach(([id, m]) => {
    m.getElement()?.querySelector('.vt-marker')?.classList.toggle('active', id === state.activePhotoId);
  });
}

// ===== BEARING DRAG =====
function initBearingDrag(marker, photoId) {
  const markerEl = marker.getElement();
  if (!markerEl) return;
  const handle = markerEl.querySelector('.vt-fov-handle');
  if (!handle) return;

  handle.addEventListener('mousedown', e => {
    e.stopPropagation();
    if (map) map.dragging.disable();

    const onMove = ev => {
      const rect = markerEl.getBoundingClientRect();
      const dx = ev.clientX - (rect.left + rect.width / 2);
      const dy = ev.clientY - (rect.top  + rect.height / 2);
      const bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;

      const photo = getActiveSite()?.photos.find(p => p.id === photoId);
      if (!photo) return;
      photo.bearing = Math.round(bearing);

      markerEl.querySelector('.vt-fov-container').style.transform = `rotate(${photo.bearing}deg)`;

      if (state.activePhotoId === photoId) {
        document.getElementById('edit-photo-bearing').value = photo.bearing;
      }
    };

    const onUp = () => {
      if (map) map.dragging.enable();
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
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
    hint.textContent = 'Cliquez sur la carte pour créer un site, ou chargez un fichier .vt.json.';
    nav.appendChild(hint);
    return;
  }

  // Carte extérieure
  const mapItem = document.createElement('div');
  mapItem.className = 'nav-item' + (state.viewMode === 'map' ? ' active' : '');
  mapItem.innerHTML = '<span class="nav-item-icon">🗺</span><span class="nav-item-label">Carte extérieure</span>';
  mapItem.addEventListener('click', () => switchViewMode('map'));
  nav.appendChild(mapItem);

  // Floors
  if (site.floors.length > 0) {
    const div = document.createElement('div');
    div.className = 'nav-divider';
    div.textContent = 'Étages';
    nav.appendChild(div);

    site.floors.forEach(floor => {
      const item = document.createElement('div');
      item.className = 'nav-item' + (floor.id === state.activeFloorId ? ' active' : '');
      item.innerHTML = `
        <span class="nav-item-icon">📐</span>
        <span class="nav-item-label">${escapeHtml(floor.name)}</span>
        <button class="nav-item-del" title="Supprimer">✕</button>`;
      item.addEventListener('click', e => {
        if (e.target.classList.contains('nav-item-del')) {
          deleteFloor(floor.id);
        } else {
          selectFloor(floor.id);
        }
      });
      nav.appendChild(item);
    });
  }

  // Add floor button
  const addFloorBtn = document.createElement('button');
  addFloorBtn.className = 'nav-add-btn';
  addFloorBtn.textContent = '+ Ajouter un étage';
  addFloorBtn.addEventListener('click', () => {
    document.getElementById('new-floor-name').value = '';
    document.getElementById('input-floor-plan').value = '';
    showModal('modal-add-floor');
  });
  nav.appendChild(addFloorBtn);
}

// ===== VIEW MODE =====
function switchViewMode(mode) {
  state.viewMode = mode;

  document.getElementById('map-container').classList.toggle('hidden', mode !== 'map');
  document.getElementById('plan-container').classList.toggle('hidden', mode !== 'plan');
  document.getElementById('map-search').classList.toggle('hidden', mode !== 'map');

  if (mode === 'map') {
    setTimeout(() => { if (map) map.invalidateSize(); }, 50);
  } else if (mode === 'plan') {
    renderPlan();
  }

  renderSidebar();
}

// ===== FLOOR MANAGEMENT =====
function selectFloor(floorId) {
  state.activeFloorId = floorId;
  state.activePhotoId = null;
  switchViewMode('plan');
  renderSidebar();
  closeViewer();
}

function addFloor(name, imageDataURL) {
  const site = getActiveSite();
  if (!site) return;
  const floor = { id: uid(), name: name || 'Étage', imageDataURL: imageDataURL || null };
  site.floors.push(floor);
  selectFloor(floor.id);
}

function deleteFloor(floorId) {
  const site = getActiveSite();
  if (!site || !confirm('Supprimer cet étage et toutes ses photos ?')) return;
  site.floors  = site.floors.filter(f => f.id !== floorId);
  site.photos  = site.photos.filter(p => p.floorId !== floorId);
  if (state.activeFloorId === floorId) {
    state.activeFloorId = null;
    switchViewMode('map');
  }
  renderSidebar();
}

// ===== FLOOR PLAN RENDERING =====
function renderPlan() {
  const site  = getActiveSite();
  const floor = site?.floors.find(f => f.id === state.activeFloorId);
  if (!floor) return;

  document.getElementById('plan-floor-name').textContent = floor.name;

  const canvas   = document.getElementById('plan-canvas');
  const viewport = document.getElementById('plan-viewport');

  if (!floor.imageDataURL) {
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
  img.src = floor.imageDataURL;
}

function drawPlanCanvas() {
  if (!plan.img) return;
  const canvas = document.getElementById('plan-canvas');
  const ctx    = canvas.getContext('2d');
  canvas.width  = plan.img.width;
  canvas.height = plan.img.height;
  canvas.style.transform = `translate(${plan.offsetX}px,${plan.offsetY}px) scale(${plan.scale})`;
  ctx.drawImage(plan.img, 0, 0);
}

function renderPlanMarkers() {
  const svg  = document.getElementById('plan-overlay');
  svg.innerHTML = '';
  const site = getActiveSite();
  if (!site || !state.activeFloorId) return;

  site.photos.filter(p => p.floorId === state.activeFloorId && p.planX != null).forEach(photo => {
    const sx = photo.planX * plan.scale + plan.offsetX;
    const sy = photo.planY * plan.scale + plan.offsetY;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'photo-marker');
    g.setAttribute('transform', `translate(${sx},${sy})`);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', 11);
    circle.setAttribute('class',
      `plan-pin type-${photo.type}${photo.id === state.activePhotoId ? ' active' : ''}`);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('fill', 'white');
    text.setAttribute('font-size', '11');
    text.setAttribute('pointer-events', 'none');
    text.textContent = photo.type === '360' ? '⬡' : photo.type === 'group' ? '⊞' : '●';

    g.appendChild(circle);
    g.appendChild(text);
    g.addEventListener('click', () => {
      if (photo.type === 'group') { openGallery(photo.id); return; }
      openViewer(photo.id);
    });
    svg.appendChild(g);
  });
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

  viewport.addEventListener('click', e => {
    if (dragMoved) return; // ignore drag-clicks
    const site = getActiveSite();
    if (!site || !state.activeFloorId) return;

    // Close existing plan menu
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
      <div class="map-popup-title">Ajouter une photo</div>
      <button class="map-popup-btn" data-type="classic">📷 Photo classique</button>
      <button class="map-popup-btn" data-type="360">⬡ Photo 360°</button>
      <button class="map-popup-btn" data-type="group">⊞ Groupe de photos</button>`;

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
        if (!menu.contains(ev.target)) {
          menu.remove();
          document.removeEventListener('click', closeMenu);
        }
      });
    }, 10);
  });
}

// ===== PHOTO ADDITION =====
function startAddPhotoAt(lat, lon, type) {
  pendingPhotoPos  = { lat, lon, floorId: null, planX: null, planY: null };
  pendingPhotoType = type;
  openAddPhotoModal(type);
}

function startAddPhotoOnPlan(planX, planY, type) {
  pendingPhotoPos  = { lat: null, lon: null, floorId: state.activeFloorId, planX, planY };
  pendingPhotoType = type;
  openAddPhotoModal(type);
}

function openAddPhotoModal(type) {
  document.getElementById('modal-add-photo-title').textContent =
    type === '360' ? 'Ajouter une photo 360°' :
    type === 'group' ? 'Ajouter un groupe de photos' : 'Ajouter une photo classique';

  document.getElementById('add-photo-file-row').classList.toggle('hidden', type === 'group');
  document.getElementById('input-new-photo-file').value = '';
  document.getElementById('new-photo-title').value = '';
  document.getElementById('new-photo-desc').value  = '';
  showModal('modal-add-photo');
}

async function confirmAddPhoto() {
  const site = getActiveSite();
  if (!site || !pendingPhotoPos) return;

  const file  = document.getElementById('input-new-photo-file').files[0];
  const title = document.getElementById('new-photo-title').value.trim();
  const desc  = document.getElementById('new-photo-desc').value.trim();
  const type  = pendingPhotoType;

  let dataURL = null, thumbnail = null;
  if (file && type !== 'group') {
    dataURL   = await fileToDataURL(file);
    thumbnail = await makeThumbnail(dataURL);
  }

  const photo = {
    id: uid(),
    type,
    title: title || (file ? file.name.replace(/\.[^.]+$/, '') : type === 'group' ? 'Groupe' : 'Sans titre'),
    description: desc,
    dataURL,
    thumbnail,
    ...pendingPhotoPos,
    ...(type === 'group'   ? { photos: [] }  : {}),
    ...((type === 'classic' || type === '360') && !pendingPhotoPos.floorId ? { bearing: 0 } : {}),
  };

  site.photos.push(photo);
  hideModal('modal-add-photo');
  pendingPhotoPos  = null;
  pendingPhotoType = null;

  if (photo.lat != null) {
    addPhotoMarker(photo);
    openViewer(photo.id);
  } else {
    renderPlanMarkers();
    if (type === 'group') openGallery(photo.id);
    else openViewer(photo.id);
  }
}

function deletePhoto(photoId) {
  const site = getActiveSite();
  if (!site || !confirm('Supprimer cette photo ?')) return;
  site.photos = site.photos.filter(p => p.id !== photoId);
  removePhotoMarker(photoId);
  if (state.activePhotoId === photoId) closeViewer();
  renderPlanMarkers();
}

// ===== VIEWER =====
function openViewer(photoId) {
  const site  = getActiveSite();
  const photo = site?.photos.find(p => p.id === photoId);
  if (!photo) return;

  state.activePhotoId = photoId;
  refreshMarkerActive();
  renderPlanMarkers();

  // Groups use the gallery overlay, not the side viewer
  if (photo.type === 'group') {
    openGallery(photo.id);
    return;
  }

  document.getElementById('viewer-panel').classList.remove('hidden');
  document.getElementById('viewer-title').textContent = photo.title || 'Photo';

  ['classic-viewer', 'panorama-viewer'].forEach(id => document.getElementById(id).classList.add('hidden'));

  if (photo.type === '360') {
    document.getElementById('panorama-viewer').classList.remove('hidden');
    if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }
    if (photo.dataURL) {
      pannellumViewer = pannellum.viewer('pannellum-container', {
        type: 'equirectangular', panorama: photo.dataURL, autoLoad: true, showControls: true,
      });
    }
  } else {
    document.getElementById('classic-viewer').classList.remove('hidden');
    document.getElementById('classic-photo-img').src = photo.dataURL || '';
    document.getElementById('classic-photo-caption').textContent = photo.description || '';
  }

  // Editor
  document.getElementById('edit-photo-title').value = photo.title || '';
  document.getElementById('edit-photo-desc').value  = photo.description || '';

  const bearingRow = document.getElementById('bearing-row');
  if ((photo.type === 'classic' || photo.type === '360') && !photo.floorId) {
    bearingRow.classList.remove('hidden');
    document.getElementById('edit-photo-bearing').value = photo.bearing ?? 0;
  } else {
    bearingRow.classList.add('hidden');
  }
}

function closeViewer() {
  state.activePhotoId = null;
  document.getElementById('viewer-panel').classList.add('hidden');
  if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }
  refreshMarkerActive();
  renderPlanMarkers();
}

// ===== GALLERY (groups) =====
function openGallery(groupPhotoId) {
  const site  = getActiveSite();
  const group = site?.photos.find(p => p.id === groupPhotoId);
  if (!group) return;

  galleryGroupId = groupPhotoId;
  galleryIndex   = 0;

  renderGalleryAt(0);

  // Wire add buttons
  document.getElementById('btn-gallery-add-classic').onclick = () => addToGalleryGroup('classic');
  document.getElementById('btn-gallery-add-360').onclick     = () => addToGalleryGroup('360');

  document.getElementById('gallery-modal').classList.remove('hidden');
}

function renderGalleryAt(index) {
  const site  = getActiveSite();
  const group = site?.photos.find(p => p.id === galleryGroupId);
  if (!group) return;

  const photos = group.photos || [];
  galleryIndex = Math.max(0, Math.min(index, photos.length - 1));

  const total = photos.length;
  document.getElementById('gallery-counter').textContent = total > 0 ? `${galleryIndex + 1} / ${total}` : '0 / 0';

  const img      = document.getElementById('gallery-img');
  const pannCont = document.getElementById('gallery-pannellum-container');

  if (total === 0) {
    img.classList.add('hidden');
    pannCont.classList.add('hidden');
    document.getElementById('gallery-caption').textContent = 'Aucune photo — utilisez les boutons ci-dessous pour en ajouter.';
    return;
  }

  const photo = photos[galleryIndex];
  document.getElementById('gallery-caption').textContent = photo.title || '';

  if (photo.type === '360') {
    img.classList.add('hidden');
    pannCont.classList.remove('hidden');
    if (galleryPannellumViewer) { galleryPannellumViewer.destroy(); galleryPannellumViewer = null; }
    if (photo.dataURL) {
      galleryPannellumViewer = pannellum.viewer('gallery-pannellum-container', {
        type: 'equirectangular', panorama: photo.dataURL, autoLoad: true, showControls: true,
      });
    }
  } else {
    pannCont.classList.add('hidden');
    if (galleryPannellumViewer) { galleryPannellumViewer.destroy(); galleryPannellumViewer = null; }
    img.classList.remove('hidden');
    img.src = photo.dataURL || '';
  }
}

function closeGallery() {
  document.getElementById('gallery-modal').classList.add('hidden');
  if (galleryPannellumViewer) { galleryPannellumViewer.destroy(); galleryPannellumViewer = null; }
  galleryGroupId = null;
}

async function addToGalleryGroup(type) {
  const site  = getActiveSite();
  const group = site?.photos.find(p => p.id === galleryGroupId);
  if (!group) return;

  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    const dataURL   = await fileToDataURL(file);
    const thumbnail = await makeThumbnail(dataURL);

    if (!group.photos) group.photos = [];
    group.photos.push({
      id: uid(), type,
      title: file.name.replace(/\.[^.]+$/, ''),
      description: '',
      dataURL, thumbnail,
    });
    if (!group.thumbnail) group.thumbnail = thumbnail;

    renderGalleryAt(group.photos.length - 1);
  };
  input.click();
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
  if (!photo || photo.type === 'group' || photo.floorId) return;

  const raw = document.getElementById('edit-photo-bearing').value;
  photo.bearing = raw === '' ? 0 : ((parseFloat(raw) % 360) + 360) % 360;
  document.getElementById('edit-photo-bearing').value = Math.round(photo.bearing);

  refreshPhotoMarker(photo.id);
  if (photo.type === 'classic') {
    setTimeout(() => {
      const m = photoMarkers[photo.id];
      if (m) initBearingDrag(m, photo.id);
    }, 0);
  }
}

// ===== SITE FORM HELPERS =====
function renderSfIconBank() {
  const bank = document.getElementById('sf-icon-bank');
  bank.innerHTML = '';
  SITE_ICONS.forEach(icon => {
    const btn = document.createElement('button');
    btn.className = 'icon-bank-btn' + (icon === sfTempIcon ? ' selected' : '');
    btn.textContent = icon;
    btn.type = 'button';
    btn.addEventListener('click', () => {
      sfTempIcon = icon;
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
    inp.type = 'file'; inp.accept = '.json,.vt.json';
    inp.onchange = e => { if (e.target.files[0]) loadSiteFromFile(e.target.files[0]); };
    inp.click();
  });
  document.getElementById('btn-save-site').addEventListener('click',   saveSite);
  document.getElementById('btn-export-site').addEventListener('click', saveSite);

  // ---- Sidebar ----
  document.getElementById('btn-deselect-site').addEventListener('click', deselectSite);
  document.getElementById('btn-site-options').addEventListener('click', () => {
    if (state.activeSiteId) openSiteForm(state.activeSiteId);
  });

  // ---- Site form modal ----
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

  // ---- Add photo modal ----
  document.getElementById('btn-confirm-add-photo').addEventListener('click', confirmAddPhoto);
  document.getElementById('btn-cancel-add-photo').addEventListener('click', () => {
    hideModal('modal-add-photo');
    pendingPhotoPos = null; pendingPhotoType = null;
  });

  // ---- Add floor modal ----
  document.getElementById('btn-create-floor').addEventListener('click', async () => {
    const name = document.getElementById('new-floor-name').value.trim();
    const file = document.getElementById('input-floor-plan').files[0];
    let dataURL = null;
    if (file) dataURL = await fileToDataURL(file);
    hideModal('modal-add-floor');
    addFloor(name || 'Étage', dataURL);
    renderSidebar();
  });
  document.getElementById('btn-cancel-add-floor').addEventListener('click', () => hideModal('modal-add-floor'));

  // ---- Floor plan upload ----
  document.getElementById('btn-upload-plan').addEventListener('click', () => {
    document.getElementById('input-upload-plan').click();
  });
  document.getElementById('input-upload-plan').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file || !state.activeFloorId) return;
    const site  = getActiveSite();
    const floor = site?.floors.find(f => f.id === state.activeFloorId);
    if (floor) { floor.imageDataURL = await fileToDataURL(file); renderPlan(); }
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

  // ---- Gallery ----
  document.getElementById('gallery-close').addEventListener('click', closeGallery);
  document.getElementById('gallery-overlay').addEventListener('click', closeGallery);
  document.getElementById('gallery-prev').addEventListener('click', () => {
    const group = getActiveSite()?.photos.find(p => p.id === galleryGroupId);
    if (group?.photos?.length) renderGalleryAt(galleryIndex - 1);
  });
  document.getElementById('gallery-next').addEventListener('click', () => {
    const group = getActiveSite()?.photos.find(p => p.id === galleryGroupId);
    if (group?.photos?.length) renderGalleryAt(galleryIndex + 1);
  });

  // ---- Modal backdrop ----
  document.getElementById('modal-backdrop').addEventListener('click', () => {
    ['modal-site-form', 'modal-add-photo', 'modal-add-floor'].forEach(id => {
      if (!document.getElementById(id).classList.contains('hidden')) hideModal(id);
    });
  });

  // Keyboard: close gallery with Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (!document.getElementById('gallery-modal').classList.contains('hidden')) closeGallery();
    }
    if (e.key === 'ArrowLeft')  document.getElementById('gallery-prev')?.click();
    if (e.key === 'ArrowRight') document.getElementById('gallery-next')?.click();
  });

  // Initial render
  renderSideHeader();
  renderSidebar();
}

function renderSideHeader() { renderSiteHeader(); }

document.addEventListener('DOMContentLoaded', init);
