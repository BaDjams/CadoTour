// shared.js — fonctions communes à CadoCreator (app.js) et CadoTour (cadotour.js)

import { renderIcon } from './icons.js';

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escapeAttr(s) {
  return String(s ?? '').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Trouve le point qui contient la photo (id) dans un site
export function findPointByPhotoId(site, photoId) {
  if (!site || !photoId) return null;
  for (const point of site.points || []) {
    if ((point.photos || []).some(ph => ph.id === photoId)) return point;
  }
  return null;
}

export function makeSiteMarkerIcon(site, isActive) {
  return L.divIcon({
    className: '',
    html: `<div class="site-marker ${isActive ? 'active' : ''}">
             <div class="site-marker-bubble" title="${escapeAttr(site.name)}">${renderIcon(site.icon) || renderIcon('landmark')}</div>
             <div class="site-marker-name">${escapeHtml(site.name)}</div>
           </div>`,
    iconSize: [140, 66],
    iconAnchor: [70, 33],
  });
}

export function makeBuildingMarkerIcon(building, isActive) {
  return L.divIcon({
    className: '',
    html: `<div class="building-marker ${isActive ? 'active' : ''}">
             <div class="building-marker-bubble" title="${escapeAttr(building.name)}">${renderIcon(building.icon) || renderIcon('building')}</div>
             <div class="building-marker-name">${escapeHtml(building.name)}</div>
           </div>`,
    iconSize: [120, 58],
    iconAnchor: [60, 29],
  });
}

export function drawPlanCanvas(plan) {
  if (!plan.img) return;
  const canvas = document.getElementById('plan-canvas');
  canvas.width  = plan.img.width;
  canvas.height = plan.img.height;
  canvas.style.transform = `translate(${plan.offsetX}px,${plan.offsetY}px) scale(${plan.scale})`;
  canvas.getContext('2d').drawImage(plan.img, 0, 0);
}

// Retourne le plan actif (floor ou site plan) depuis l'état et le site courant
export function getActivePlan(state, site) {
  if (!site) return null;
  if (state.activeSitePlanId) {
    const sp = site.sitePlans?.find(s => s.id === state.activeSitePlanId);
    return sp ? { label: sp.name, imageId: sp.imageId } : null;
  }
  if (state.activeBuildingId && state.activeFloorId) {
    const bld   = site.buildings?.find(b => b.id === state.activeBuildingId);
    const floor = bld?.floors?.find(f => f.id === state.activeFloorId);
    return floor ? { label: `${bld.name} — ${floor.name}`, imageId: floor.imageId } : null;
  }
  return null;
}

export function updateGalleryNav(gallery, idx) {
  const multi = gallery.length > 1;
  document.getElementById('btn-viewer-prev').classList.toggle('hidden', !multi);
  document.getElementById('btn-viewer-next').classList.toggle('hidden', !multi);
  const count = document.getElementById('viewer-gallery-count');
  count.classList.toggle('hidden', !multi);
  if (multi) count.textContent = `${idx + 1} / ${gallery.length}`;
}
