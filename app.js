// app.js — Virtual Tour application
// Architecture: pure client-side, data saved as JSON (no backend)

// ===== STATE =====
let state = {
  site: null,         // { name, lat, lon, floors: [], photos: [] }
  activeFloorId: null,
  activePhotoId: null,
  viewMode: 'map',    // 'map' | 'plan'
  pendingAdd: null,   // { type: 'classic'|'360'|'group', photoData: {...} } — waiting for placement click
};

// ===== LEAFLET MAP =====
let map = null;
let markers = {};   // photoId -> L.Marker

// ===== FLOOR PLAN PAN/ZOOM =====
let plan = {
  img: null,        // HTMLImageElement
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  dragging: false,
  dragStart: null,
};

// ===== PANNELLUM =====
let pannellumViewer = null;

// ===== HELPERS =====
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.getElementById('modal-backdrop').classList.remove('hidden');
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.getElementById('modal-backdrop').classList.add('hidden');
}

function setSidebarVisible(show) {
  ['site-info', 'floor-manager', 'photo-list-panel', 'view-mode-toggle'].forEach(id => {
    document.getElementById(id).classList.toggle('hidden', !show);
  });
}

// ===== SITE MANAGEMENT =====
function createSite(name, lat, lon) {
  state.site = {
    id: uid(),
    name: name || 'Nouveau site',
    lat: parseFloat(lat) || 48.85,
    lon: parseFloat(lon) || 2.35,
    floors: [],
    photos: [],
  };
  state.activeFloorId = null;
  state.activePhotoId = null;
  state.viewMode = 'map';

  document.getElementById('welcome-screen').classList.add('hidden');
  document.getElementById('site-name-input').value = state.site.name;
  document.getElementById('btn-save-site').disabled = false;
  document.getElementById('btn-export-site').disabled = false;

  setSidebarVisible(true);
  switchViewMode('map');
  renderFloorList();
  renderPhotoList();
  initMap();
}

function saveSite() {
  if (!state.site) return;
  const json = JSON.stringify(state.site, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (state.site.name || 'site') + '.vt.json';
  a.click();
  URL.revokeObjectURL(url);
}

function loadSiteFromFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const data = JSON.parse(e.target.result);
      state.site = data;
      state.activeFloorId = null;
      state.activePhotoId = null;
      state.viewMode = 'map';

      document.getElementById('welcome-screen').classList.add('hidden');
      document.getElementById('site-name-input').value = state.site.name || '';
      document.getElementById('btn-save-site').disabled = false;
      document.getElementById('btn-export-site').disabled = false;

      setSidebarVisible(true);
      switchViewMode('map');
      renderFloorList();
      renderPhotoList();
      initMap();
    } catch (err) {
      alert('Fichier JSON invalide : ' + err.message);
    }
  };
  reader.readAsText(file);
}

// ===== MAP =====
function initMap() {
  if (map) {
    map.remove();
    map = null;
    markers = {};
  }

  document.getElementById('map-container').classList.remove('hidden');

  map = L.map('map').setView(
    [state.site.lat || 48.85, state.site.lon || 2.35],
    state.site.lat ? 16 : 5
  );

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 20,
  }).addTo(map);

  // Click on map to place a photo if pending
  map.on('click', onMapClick);

  // Add existing markers
  (state.site.photos || []).forEach(p => {
    if (p.lat != null && p.lon != null) addMapMarker(p);
  });
}

function onMapClick(e) {
  if (!state.pendingAdd) return;
  const { type, photoData } = state.pendingAdd;
  state.pendingAdd = null;
  document.getElementById('map').style.cursor = '';

  const photo = {
    ...photoData,
    id: uid(),
    type,
    lat: e.latlng.lat,
    lon: e.latlng.lng,
    floorId: null,   // exterior
  };

  state.site.photos.push(photo);
  addMapMarker(photo);
  renderPhotoList();
  openViewer(photo.id);
}

function addMapMarker(photo) {
  const icon = L.divIcon({
    className: '',
    html: `<div class="vt-marker type-${photo.type}" title="${photo.title || ''}">${
      photo.type === '360' ? '⬡' : photo.type === 'group' ? '⊞' : '📷'
    }</div>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });

  const marker = L.marker([photo.lat, photo.lon], { icon })
    .addTo(map)
    .on('click', () => openViewer(photo.id));

  markers[photo.id] = marker;
}

function removeMapMarker(photoId) {
  if (markers[photoId]) {
    markers[photoId].remove();
    delete markers[photoId];
  }
}

function refreshMarkerActive() {
  Object.entries(markers).forEach(([id, m]) => {
    const el = m.getElement()?.querySelector('.vt-marker');
    if (el) el.classList.toggle('active', id === state.activePhotoId);
  });
}

// ===== FLOOR MANAGEMENT =====
function renderFloorList() {
  const list = document.getElementById('floor-list');
  list.innerHTML = '';
  (state.site.floors || []).forEach(floor => {
    const div = document.createElement('div');
    div.className = 'floor-item' + (floor.id === state.activeFloorId ? ' active' : '');
    div.innerHTML = `
      <span class="floor-item-name">${floor.name}</span>
      <button class="floor-item-del btn-icon" data-id="${floor.id}" title="Supprimer">✕</button>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('floor-item-del')) {
        deleteFloor(floor.id);
      } else {
        selectFloor(floor.id);
      }
    });
    list.appendChild(div);
  });
}

function selectFloor(floorId) {
  state.activeFloorId = floorId;
  renderFloorList();
  renderPhotoList();
  switchViewMode('plan');
  renderPlan();
}

function addFloor(name, imageDataURL) {
  const floor = {
    id: uid(),
    name: name || 'Étage',
    imageDataURL: imageDataURL || null,
  };
  state.site.floors.push(floor);
  renderFloorList();
  selectFloor(floor.id);
}

function deleteFloor(floorId) {
  if (!confirm('Supprimer cet étage et toutes ses photos ?')) return;
  state.site.floors = state.site.floors.filter(f => f.id !== floorId);
  state.site.photos = state.site.photos.filter(p => p.floorId !== floorId);
  if (state.activeFloorId === floorId) {
    state.activeFloorId = null;
    switchViewMode('map');
  }
  renderFloorList();
  renderPhotoList();
}

// ===== FLOOR PLAN RENDERING =====
function renderPlan() {
  const floor = state.site.floors.find(f => f.id === state.activeFloorId);
  if (!floor) return;

  document.getElementById('plan-floor-name').textContent = floor.name;

  const canvas = document.getElementById('plan-canvas');
  const viewport = document.getElementById('plan-viewport');

  if (!floor.imageDataURL) {
    // No plan image yet: show upload prompt
    canvas.width = 0; canvas.height = 0;
    renderPlanMarkers();
    return;
  }

  const img = new Image();
  img.onload = () => {
    plan.img = img;
    // Fit to viewport
    const vw = viewport.clientWidth;
    const vh = viewport.clientHeight;
    plan.scale = Math.min(vw / img.width, vh / img.height, 1);
    plan.offsetX = (vw - img.width * plan.scale) / 2;
    plan.offsetY = (vh - img.height * plan.scale) / 2;
    drawPlanCanvas();
    renderPlanMarkers();
  };
  img.src = floor.imageDataURL;
}

function drawPlanCanvas() {
  if (!plan.img) return;
  const canvas = document.getElementById('plan-canvas');
  const ctx = canvas.getContext('2d');
  canvas.width = plan.img.width;
  canvas.height = plan.img.height;
  canvas.style.transform = `translate(${plan.offsetX}px, ${plan.offsetY}px) scale(${plan.scale})`;
  ctx.drawImage(plan.img, 0, 0);
}

function renderPlanMarkers() {
  const svg = document.getElementById('plan-overlay');
  svg.innerHTML = '';

  if (!state.activeFloorId) return;

  const photosOnFloor = (state.site.photos || []).filter(p => p.floorId === state.activeFloorId);
  photosOnFloor.forEach(photo => {
    if (photo.planX == null || photo.planY == null) return;

    const screenX = photo.planX * plan.scale + plan.offsetX;
    const screenY = photo.planY * plan.scale + plan.offsetY;

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('class', 'photo-marker');
    g.setAttribute('transform', `translate(${screenX},${screenY})`);

    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('r', 11);
    circle.setAttribute('class', `plan-pin type-${photo.type}${photo.id === state.activePhotoId ? ' active' : ''}`);

    const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    text.setAttribute('text-anchor', 'middle');
    text.setAttribute('dominant-baseline', 'central');
    text.setAttribute('fill', 'white');
    text.setAttribute('font-size', '11');
    text.setAttribute('pointer-events', 'none');
    text.textContent = photo.type === '360' ? '⬡' : photo.type === 'group' ? '⊞' : '●';

    g.appendChild(circle);
    g.appendChild(text);
    g.addEventListener('click', () => openViewer(photo.id));
    svg.appendChild(g);
  });
}

// Plan pan/zoom
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
    plan.scale *= factor;
    drawPlanCanvas();
    renderPlanMarkers();
  }, { passive: false });

  viewport.addEventListener('mousedown', e => {
    if (state.pendingAdd) return;
    plan.dragging = true;
    plan.dragStart = { x: e.clientX - plan.offsetX, y: e.clientY - plan.offsetY };
  });

  window.addEventListener('mousemove', e => {
    if (!plan.dragging) return;
    plan.offsetX = e.clientX - plan.dragStart.x;
    plan.offsetY = e.clientY - plan.dragStart.y;
    drawPlanCanvas();
    renderPlanMarkers();
  });

  window.addEventListener('mouseup', () => { plan.dragging = false; });

  viewport.addEventListener('click', e => {
    if (!state.pendingAdd) return;
    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const planX = (mx - plan.offsetX) / plan.scale;
    const planY = (my - plan.offsetY) / plan.scale;

    const { type, photoData } = state.pendingAdd;
    state.pendingAdd = null;
    viewport.style.cursor = 'default';

    const photo = {
      ...photoData,
      id: uid(),
      type,
      planX,
      planY,
      floorId: state.activeFloorId,
      lat: null,
      lon: null,
    };

    state.site.photos.push(photo);
    renderPlanMarkers();
    renderPhotoList();
    openViewer(photo.id);
  });
}

// ===== PHOTO MANAGEMENT =====
function renderPhotoList() {
  const list = document.getElementById('photo-list');
  list.innerHTML = '';

  if (!state.site) return;

  const photos = state.viewMode === 'plan'
    ? state.site.photos.filter(p => p.floorId === state.activeFloorId)
    : state.site.photos.filter(p => !p.floorId);

  photos.forEach(photo => {
    const div = document.createElement('div');
    div.className = 'photo-item' + (photo.id === state.activePhotoId ? ' active' : '');

    const thumbEl = photo.thumbnail
      ? `<img class="photo-item-thumb" src="${photo.thumbnail}" alt="" />`
      : `<div class="photo-item-icon">${photo.type === '360' ? '⬡' : photo.type === 'group' ? '⊞' : '📷'}</div>`;

    div.innerHTML = `
      ${thumbEl}
      <div class="photo-item-info">
        <div class="photo-item-title">${photo.title || 'Sans titre'}</div>
        <div class="photo-item-type">${photo.type === '360' ? '360°' : photo.type === 'group' ? 'Groupe' : 'Classique'}</div>
      </div>
      <button class="photo-item-del btn-icon" data-id="${photo.id}" title="Supprimer">✕</button>
    `;

    div.addEventListener('click', e => {
      if (e.target.classList.contains('photo-item-del')) {
        deletePhoto(photo.id);
      } else {
        openViewer(photo.id);
      }
    });

    list.appendChild(div);
  });
}

function deletePhoto(photoId) {
  if (!confirm('Supprimer cette photo ?')) return;
  state.site.photos = state.site.photos.filter(p => p.id !== photoId);
  removeMapMarker(photoId);
  if (state.activePhotoId === photoId) closeViewer();
  renderPhotoList();
  renderPlanMarkers();
}

// ===== VIEWER =====
function openViewer(photoId) {
  const photo = state.site.photos.find(p => p.id === photoId);
  if (!photo) return;

  state.activePhotoId = photoId;
  renderPhotoList();
  refreshMarkerActive();
  renderPlanMarkers();

  const panel = document.getElementById('viewer-panel');
  panel.classList.remove('hidden');

  document.getElementById('viewer-title').textContent = photo.title || 'Photo';

  // Hide all viewers first
  ['classic-viewer', 'panorama-viewer', 'group-viewer'].forEach(id =>
    document.getElementById(id).classList.add('hidden')
  );

  if (photo.type === '360') {
    document.getElementById('panorama-viewer').classList.remove('hidden');
    if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }
    if (photo.dataURL) {
      pannellumViewer = pannellum.viewer('pannellum-container', {
        type: 'equirectangular',
        panorama: photo.dataURL,
        autoLoad: true,
        showControls: true,
      });
    }
  } else if (photo.type === 'group') {
    document.getElementById('group-viewer').classList.remove('hidden');
    renderGroupGrid(photo);
  } else {
    document.getElementById('classic-viewer').classList.remove('hidden');
    document.getElementById('classic-photo-img').src = photo.dataURL || '';
    document.getElementById('classic-photo-caption').textContent = photo.description || '';
  }

  // Populate editor
  document.getElementById('edit-photo-title').value = photo.title || '';
  document.getElementById('edit-photo-desc').value = photo.description || '';
}

function renderGroupGrid(group) {
  const grid = document.getElementById('group-grid');
  grid.innerHTML = '';
  (group.photos || []).forEach((p, i) => {
    const div = document.createElement('div');
    div.className = 'group-thumb-item';
    div.innerHTML = `
      <img src="${p.thumbnail || p.dataURL || ''}" alt="${p.title || ''}" />
      ${p.type === '360' ? '<span class="group-thumb-badge">360°</span>' : ''}
    `;
    div.addEventListener('click', () => {
      // Open sub-photo inline
      openSubPhoto(p);
    });
    grid.appendChild(div);
  });
}

function openSubPhoto(photo) {
  if (photo.type === '360') {
    document.getElementById('group-viewer').classList.add('hidden');
    document.getElementById('panorama-viewer').classList.remove('hidden');
    if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }
    if (photo.dataURL) {
      pannellumViewer = pannellum.viewer('pannellum-container', {
        type: 'equirectangular',
        panorama: photo.dataURL,
        autoLoad: true,
        showControls: true,
      });
    }
  } else {
    document.getElementById('group-viewer').classList.add('hidden');
    document.getElementById('classic-viewer').classList.remove('hidden');
    document.getElementById('classic-photo-img').src = photo.dataURL || '';
    document.getElementById('classic-photo-caption').textContent = photo.title || '';
  }
}

function closeViewer() {
  state.activePhotoId = null;
  document.getElementById('viewer-panel').classList.add('hidden');
  if (pannellumViewer) { pannellumViewer.destroy(); pannellumViewer = null; }
  renderPhotoList();
  refreshMarkerActive();
  renderPlanMarkers();
}

// ===== VIEW MODE SWITCH =====
function switchViewMode(mode) {
  state.viewMode = mode;

  document.getElementById('btn-mode-map').classList.toggle('active', mode === 'map');
  document.getElementById('btn-mode-plan').classList.toggle('active', mode === 'plan');

  document.getElementById('map-container').classList.toggle('hidden', mode !== 'map');
  document.getElementById('plan-container').classList.toggle('hidden', mode !== 'plan');

  if (mode === 'map') {
    setTimeout(() => { if (map) map.invalidateSize(); }, 50);
  } else {
    renderPlan();
  }

  renderPhotoList();
}

// ===== PHOTO ADDING FLOW =====
let pendingPhotoData = null;   // temp storage during modal -> placement flow

function startAddPhoto(type) {
  pendingPhotoData = { type };
  document.getElementById('modal-add-photo-title').textContent =
    type === '360' ? 'Ajouter une photo 360°' :
    type === 'group' ? 'Ajouter un groupe' : 'Ajouter une photo classique';
  document.getElementById('add-photo-hint').textContent =
    state.viewMode === 'plan'
      ? 'Cliquez ensuite sur le plan pour placer la photo.'
      : 'Cliquez ensuite sur la carte pour placer la photo.';
  document.getElementById('input-new-photo-file').value = '';
  document.getElementById('new-photo-title').value = '';
  document.getElementById('new-photo-desc').value = '';
  showModal('modal-add-photo');
}

async function confirmAddPhoto() {
  const file = document.getElementById('input-new-photo-file').files[0];
  const title = document.getElementById('new-photo-title').value.trim();
  const desc = document.getElementById('new-photo-desc').value.trim();

  let dataURL = null;
  let thumbnail = null;

  if (file) {
    dataURL = await fileToDataURL(file);
    thumbnail = await makeThumbnail(dataURL);
  }

  const photoData = {
    title: title || (file ? file.name : 'Sans titre'),
    description: desc,
    dataURL,
    thumbnail,
  };

  hideModal('modal-add-photo');

  state.pendingAdd = { type: pendingPhotoData.type, photoData };

  if (state.viewMode === 'plan') {
    document.getElementById('plan-viewport').style.cursor = 'crosshair';
  } else {
    document.getElementById('map').style.cursor = 'crosshair';
  }

  pendingPhotoData = null;
}

async function makeThumbnail(dataURL, size = 64) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size; canvas.height = size;
      const ctx = canvas.getContext('2d');
      const scale = size / Math.min(img.width, img.height);
      const sw = img.width * scale;
      const sh = img.height * scale;
      ctx.drawImage(img, (size - sw) / 2, (size - sh) / 2, sw, sh);
      resolve(canvas.toDataURL('image/jpeg', 0.7));
    };
    img.onerror = () => resolve(null);
    img.src = dataURL;
  });
}

// ===== PHOTO EDITOR CHANGES =====
function applyEditorChanges() {
  if (!state.activePhotoId) return;
  const photo = state.site.photos.find(p => p.id === state.activePhotoId);
  if (!photo) return;
  photo.title = document.getElementById('edit-photo-title').value;
  photo.description = document.getElementById('edit-photo-desc').value;
  document.getElementById('viewer-title').textContent = photo.title || 'Photo';
  renderPhotoList();
}

// ===== INIT =====
function init() {
  // Welcome screen buttons
  document.getElementById('btn-new-site').addEventListener('click', () => showModal('modal-new-site'));
  document.getElementById('btn-new-site-welcome').addEventListener('click', () => showModal('modal-new-site'));

  document.getElementById('btn-load-site').addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json,.vt.json';
    input.onchange = e => { if (e.target.files[0]) loadSiteFromFile(e.target.files[0]); };
    input.click();
  });

  document.getElementById('btn-load-site-welcome').addEventListener('click', () => {
    document.getElementById('btn-load-site').click();
  });

  document.getElementById('btn-save-site').addEventListener('click', saveSite);
  document.getElementById('btn-export-site').addEventListener('click', saveSite);

  // New site modal
  document.getElementById('btn-create-site').addEventListener('click', () => {
    const name = document.getElementById('new-site-name').value.trim();
    const lat = document.getElementById('new-site-lat').value;
    const lon = document.getElementById('new-site-lon').value;
    hideModal('modal-new-site');
    createSite(name, lat, lon);
  });

  document.getElementById('btn-cancel-new-site').addEventListener('click', () => hideModal('modal-new-site'));

  // Site name input
  document.getElementById('site-name-input').addEventListener('input', e => {
    if (state.site) state.site.name = e.target.value;
  });

  // Floor manager
  document.getElementById('btn-add-floor').addEventListener('click', () => {
    document.getElementById('new-floor-name').value = '';
    document.getElementById('input-floor-plan').value = '';
    showModal('modal-add-floor');
  });

  document.getElementById('btn-create-floor').addEventListener('click', async () => {
    const name = document.getElementById('new-floor-name').value.trim();
    const file = document.getElementById('input-floor-plan').files[0];
    let dataURL = null;
    if (file) dataURL = await fileToDataURL(file);
    hideModal('modal-add-floor');
    addFloor(name || 'Étage', dataURL);
  });

  document.getElementById('btn-cancel-add-floor').addEventListener('click', () => hideModal('modal-add-floor'));

  // Add photo buttons
  document.getElementById('btn-add-photo-classic').addEventListener('click', () => startAddPhoto('classic'));
  document.getElementById('btn-add-photo-360').addEventListener('click', () => startAddPhoto('360'));
  document.getElementById('btn-add-group').addEventListener('click', () => startAddPhoto('group'));

  // Add photo modal
  document.getElementById('btn-confirm-add-photo').addEventListener('click', confirmAddPhoto);
  document.getElementById('btn-cancel-add-photo').addEventListener('click', () => {
    hideModal('modal-add-photo');
    state.pendingAdd = null;
    pendingPhotoData = null;
  });

  // View mode buttons
  document.getElementById('btn-mode-map').addEventListener('click', () => switchViewMode('map'));
  document.getElementById('btn-mode-plan').addEventListener('click', () => {
    if (state.site?.floors?.length === 0) {
      alert('Ajoutez d\'abord un étage.');
      return;
    }
    if (!state.activeFloorId && state.site?.floors?.length > 0) {
      state.activeFloorId = state.site.floors[0].id;
    }
    switchViewMode('plan');
  });

  // Floor plan upload (change plan button)
  document.getElementById('btn-upload-plan').addEventListener('click', () => {
    document.getElementById('input-upload-plan').click();
  });

  document.getElementById('input-upload-plan').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file || !state.activeFloorId) return;
    const dataURL = await fileToDataURL(file);
    const floor = state.site.floors.find(f => f.id === state.activeFloorId);
    if (floor) { floor.imageDataURL = dataURL; renderPlan(); }
  });

  // Close viewer
  document.getElementById('btn-close-viewer').addEventListener('click', closeViewer);

  // Photo editor auto-save on blur
  document.getElementById('edit-photo-title').addEventListener('blur', applyEditorChanges);
  document.getElementById('edit-photo-desc').addEventListener('blur', applyEditorChanges);

  // Edit photo file
  document.getElementById('btn-edit-photo-file').addEventListener('click', () => {
    document.getElementById('input-edit-photo-file').click();
  });

  document.getElementById('input-edit-photo-file').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file || !state.activePhotoId) return;
    const dataURL = await fileToDataURL(file);
    const thumbnail = await makeThumbnail(dataURL);
    const photo = state.site.photos.find(p => p.id === state.activePhotoId);
    if (photo) {
      photo.dataURL = dataURL;
      photo.thumbnail = thumbnail;
      openViewer(photo.id);
      renderPhotoList();
    }
  });

  // Delete photo from viewer
  document.getElementById('btn-delete-photo').addEventListener('click', () => {
    if (state.activePhotoId) deletePhoto(state.activePhotoId);
  });

  // Modal backdrop closes active modal on click
  document.getElementById('modal-backdrop').addEventListener('click', () => {
    ['modal-new-site', 'modal-add-floor', 'modal-add-photo'].forEach(id => {
      if (!document.getElementById(id).classList.contains('hidden')) hideModal(id);
    });
  });

  // Plan events
  initPlanEvents();
}

document.addEventListener('DOMContentLoaded', init);
