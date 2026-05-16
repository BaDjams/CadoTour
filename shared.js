// shared.js — fonctions communes à CadoCreator (app.js) et CadoTour (cadotour.js)

import { renderIcon } from './icons.js';
import { accessArrowSrc, accessArrowAspect } from './accessArrows.js';

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

// ===== DRAWING HELPERS =====

export function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16) || 0;
  const g = parseInt(hex.slice(3, 5), 16) || 0;
  const b = parseInt(hex.slice(5, 7), 16) || 0;
  return `rgba(${r},${g},${b},${alpha})`;
}

export function planShapeToSvgG(shape, plan) {
  if (!shape.points?.length) return null;
  const pts = shape.points.map(p => ({
    x: p.x * plan.scale + plan.offsetX,
    y: p.y * plan.scale + plan.offsetY,
  }));
  const sw = shape.strokeWidth || 2;
  const dash = shape.dashed ? `${sw * 4},${sw * 2}` : null;
  const S = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);
  const applyDash = el => { if (dash) el.setAttribute('stroke-dasharray', dash); };
  const g = S('g');

  if (shape.type === 'polygon' && pts.length >= 2) {
    const el = S('polygon');
    el.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
    el.setAttribute('fill', hexToRgba(shape.color || '#e63946', shape.fillOpacity ?? 0.15));
    el.setAttribute('stroke', shape.color || '#e63946');
    el.setAttribute('stroke-width', sw);
    el.setAttribute('stroke-linejoin', 'round');
    applyDash(el);
    g.appendChild(el);
  } else if (shape.type === 'polyline' && pts.length >= 2) {
    const el = S('polyline');
    el.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', shape.color || '#e63946');
    el.setAttribute('stroke-width', sw);
    el.setAttribute('stroke-linejoin', 'round');
    el.setAttribute('stroke-linecap', 'round');
    applyDash(el);
    g.appendChild(el);
  } else if (shape.type === 'arrow' && pts.length >= 2) {
    const p1 = pts[pts.length - 2], p2 = pts[pts.length - 1];
    const line = S('polyline');
    line.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', shape.color || '#e63946');
    line.setAttribute('stroke-width', sw);
    line.setAttribute('stroke-linecap', 'round');
    applyDash(line);
    g.appendChild(line);
    const len = 8 + sw * 2;
    const addHead = (tip, from) => {
      const a = Math.atan2(tip.y - from.y, tip.x - from.x);
      const head = S('polygon');
      head.setAttribute('points', `${tip.x},${tip.y} ${tip.x - len * Math.cos(a - Math.PI/6)},${tip.y - len * Math.sin(a - Math.PI/6)} ${tip.x - len * Math.cos(a + Math.PI/6)},${tip.y - len * Math.sin(a + Math.PI/6)}`);
      head.setAttribute('fill', shape.color || '#e63946');
      head.setAttribute('stroke', shape.color || '#e63946');
      head.setAttribute('stroke-linejoin', 'round');
      g.appendChild(head);
    };
    addHead(p2, p1);
    if (shape.doubleArrow) addHead(pts[0], pts[1]);
  } else if (shape.type === 'circle' && pts.length >= 2) {
    const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const el = S('circle');
    el.setAttribute('cx', pts[0].x); el.setAttribute('cy', pts[0].y);
    el.setAttribute('r', r);
    el.setAttribute('fill', hexToRgba(shape.color || '#e63946', shape.fillOpacity ?? 0.15));
    el.setAttribute('stroke', shape.color || '#e63946');
    el.setAttribute('stroke-width', sw);
    applyDash(el);
    g.appendChild(el);
  } else if (shape.type === 'text' && pts.length >= 1) {
    const fontPx = Math.max(8, (shape.fontSize || 14) * plan.scale);
    const outlinePx = (shape.strokeWidth ?? 2) * plan.scale;
    const outlineCol = shape.outlineColor || 'rgba(0,0,0,0.65)';
    const text = S('text');
    text.setAttribute('x', pts[0].x);
    text.setAttribute('y', pts[0].y);
    text.setAttribute('fill', shape.color || '#e63946');
    text.setAttribute('font-size', fontPx);
    text.setAttribute('font-family', 'Segoe UI, system-ui, sans-serif');
    text.setAttribute('font-weight', '600');
    text.setAttribute('paint-order', 'stroke fill');
    text.setAttribute('stroke', outlineCol);
    text.setAttribute('stroke-width', outlinePx);
    text.setAttribute('stroke-linejoin', 'round');
    text.textContent = shape.text || '';
    g.appendChild(text);
  } else if (shape.type === 'access' && pts.length >= 1) {
    const anchor = pts[0];
    const dir = pts[1] || { x: anchor.x, y: anchor.y - 1 };
    const angle = Math.atan2(dir.y - anchor.y, dir.x - anchor.x) * 180 / Math.PI;
    const w = (shape.size || 48) * plan.scale;
    const h = w / accessArrowAspect(shape.iconKey);
    const img = S('image');
    img.setAttribute('href', accessArrowSrc(shape.iconKey));
    img.setAttribute('x', anchor.x - w / 2);
    img.setAttribute('y', anchor.y - h / 2);
    img.setAttribute('width', w);
    img.setAttribute('height', h);
    img.setAttribute('transform', `rotate(${angle} ${anchor.x} ${anchor.y})`);
    g.appendChild(img);
  } else {
    return null;
  }

  return g;
}

export function renderPlanDrawingLayersSvg(layers, plan, svgRoot, opts = {}) {
  // Render bottom layer first, top layer last so it paints over the others
  const ordered = [...(layers || [])].reverse();
  for (const layer of ordered) {
    if (!layer.visible) continue;
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('data-layer-id', layer.id);
    for (const shape of (layer.shapes || [])) {
      const sg = planShapeToSvgG(shape, plan);
      if (!sg) continue;
      sg.setAttribute('data-shape-id', shape.id);
      sg.setAttribute('data-layer-id', layer.id);
      if (opts.interactive) sg.style.pointerEvents = 'painted';
      g.appendChild(sg);
    }
    svgRoot.appendChild(g);
  }
}
