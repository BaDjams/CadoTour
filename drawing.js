// drawing.js — Reusable vector drawing module (floor plans + Leaflet maps)
//
// Usage:
//   import { initDrawing } from './drawing.js';
//   const drawing = initDrawing({ getViewMode, getActiveSite, ... });
//   drawing.initEvents();
//   // then call drawing.renderPanel(), drawing.renderPlanLayers(svg), etc.

import { hexToRgba, planShapeToSvgG, escapeHtml, escapeAttr } from './shared.js';

/**
 * deps = {
 *   getViewMode()           → 'plan' | 'map'
 *   getActiveSite()         → site object
 *   getActiveSitePlanId()   → string | null
 *   getActiveBuildingId()   → string | null
 *   getActiveFloorId()      → string | null
 *   getPlan()               → { img, scale, offsetX, offsetY }
 *   getMap()                → Leaflet map instance
 *   getInteractionMode()    → string | null
 *   setInteractionMode(m)   → void
 *   uid()                   → unique string id
 *   sanitizeFilename(str)   → string
 *   getActivePlanInfo()     → { label, imageId } | null
 *   onSave()                → persist (e.g. scheduleCacheSave)
 *   onRefreshPlan()         → re-render plan markers
 *   setStepBanner(text, btns)
 *   clearStepBanner()
 * }
 */
export function initDrawing(deps) {
  const {
    getViewMode, getActiveSite,
    getActiveSitePlanId, getActiveBuildingId, getActiveFloorId,
    getPlan, getMap,
    getInteractionMode, setInteractionMode,
    uid, sanitizeFilename, getActivePlanInfo,
    onSave, onRefreshPlan, setStepBanner, clearStepBanner,
  } = deps;

  // ===== STATE =====
  let panelOpen          = true;
  let activeLayerId      = null;
  let tool               = null;  // null | 'select' | 'polygon' | 'polyline' | 'arrow' | 'circle' | 'text'
  let color              = '#e63946';
  let strokeWidth        = 2;
  let fontSize           = 14;
  let dashed             = false;
  let doubleArrow        = false;
  let outlineColor       = '#000000';
  let textOutline        = 2;
  let planDrawing        = false;
  let planPoints         = [];    // [{x, y}] image-space pixels
  let planSelShapeId     = null;
  let planSelLayerId     = null;

  let mapLayerGroups     = {};   // layerId → L.layerGroup
  let mapHandleMarkers   = [];   // draggable L.markers for editing
  let mapDrawing         = false;
  let mapPoints          = [];   // [{lat, lon}]
  let mapRubberBand      = null;
  let mapPreviewShape    = null;
  let mapSelShapeId      = null;
  let mapSelLayerId      = null;
  let mapCurrentTool     = null;

  const LINE_TOOLS = new Set(['polygon', 'polyline', 'arrow', 'circle']);

  // ===== CONTEXT =====
  function _ctx() {
    const site = getActiveSite();
    if (!site) return null;
    if (getViewMode() === 'map') {
      if (!site.mapDrawingLayers) site.mapDrawingLayers = [];
      return { type: 'map', container: site, layers: site.mapDrawingLayers };
    }
    const spId = getActiveSitePlanId();
    if (spId) {
      const sp = site.sitePlans?.find(s => s.id === spId);
      if (sp) { if (!sp.drawingLayers) sp.drawingLayers = []; return { type: 'plan', container: sp, layers: sp.drawingLayers }; }
    }
    const bId = getActiveBuildingId(), fId = getActiveFloorId();
    if (bId && fId) {
      const bld = site.buildings?.find(b => b.id === bId);
      const floor = bld?.floors?.find(f => f.id === fId);
      if (floor) { if (!floor.drawingLayers) floor.drawingLayers = []; return { type: 'plan', container: floor, layers: floor.drawingLayers }; }
    }
    return null;
  }

  function _refresh() {
    if (getViewMode() === 'plan') onRefreshPlan();
    else if (getViewMode() === 'map') renderMapLayers();
  }

  // ===== LAYER MANAGEMENT =====
  function addLayer() {
    const ctx = _ctx();
    if (!ctx) return;
    const layer = { id: uid(), name: `Calque ${ctx.layers.length + 1}`, visible: true, shapes: [] };
    ctx.layers.push(layer);
    activeLayerId = layer.id;
    renderPanel();
    _refresh();
    onSave();
  }

  function deleteLayer(layerId) {
    const ctx = _ctx();
    if (!ctx || !confirm('Supprimer ce calque et toutes ses formes ?')) return;
    const idx = ctx.layers.findIndex(l => l.id === layerId);
    if (idx < 0) return;
    ctx.layers.splice(idx, 1);
    if (activeLayerId === layerId) activeLayerId = ctx.layers[0]?.id || null;
    if (planSelLayerId === layerId) { planSelShapeId = null; planSelLayerId = null; }
    if (mapSelLayerId === layerId) { mapSelShapeId = null; mapSelLayerId = null; _clearMapHandles(); }
    renderPanel();
    _refresh();
    onSave();
  }

  function _setActiveLayer(layerId) {
    activeLayerId = layerId;
    planSelShapeId = null;
    planSelLayerId = null;
    _clearMapHandles();
    renderPanel();
    _updateModeClass();
  }

  // ===== PANEL =====
  function renderPanel() {
    const panel = document.getElementById('drawing-panel');
    if (!panel) return;
    const hasSite = !!getActiveSite();
    panel.classList.toggle('hidden', !hasSite);
    if (!hasSite) return;

    const toggleBtn = document.getElementById('drawing-panel-toggle');
    const body = document.getElementById('drawing-panel-body');
    toggleBtn.textContent = `✏ Calques ${panelOpen ? '▲' : '▼'}`;
    body.classList.toggle('hidden', !panelOpen);
    if (!panelOpen) return;

    const ctx = _ctx();
    const layers = ctx?.layers || [];
    const list = document.getElementById('drawing-layers-list');
    list.innerHTML = '';

    if (!layers.length) {
      const hint = document.createElement('div');
      hint.style.cssText = 'padding:8px 4px;color:var(--color-text-muted);font-size:11px;text-align:center';
      hint.textContent = 'Aucun calque. Créez-en un pour dessiner.';
      list.appendChild(hint);
    }

    layers.forEach((layer, i) => {
      const row = document.createElement('div');
      row.className = 'drawing-layer-row' + (layer.id === activeLayerId ? ' active' : '');
      row.innerHTML = `
        <button class="dl-btn dl-vis" title="${layer.visible ? 'Masquer' : 'Afficher'}">${layer.visible ? '👁' : '🚫'}</button>
        <span class="dl-name">${escapeHtml(layer.name)}</span>
        <button class="dl-btn dl-rename" title="Renommer">✏</button>
        <button class="dl-btn" title="Monter" data-dir="up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="dl-btn" title="Descendre" data-dir="down" ${i === layers.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="dl-btn dl-del" title="Supprimer">🗑</button>`;

      row.querySelector('.dl-vis').addEventListener('click', e => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        _refresh();
        renderPanel();
        onSave();
      });

      row.querySelector('.dl-rename').addEventListener('click', e => {
        e.stopPropagation();
        // Activate layer without re-rendering (renderPanel would destroy this row)
        if (activeLayerId !== layer.id) {
          activeLayerId = layer.id;
          planSelShapeId = null; planSelLayerId = null;
          _clearMapHandles();
          list.querySelectorAll('.drawing-layer-row').forEach(r => r.classList.remove('active'));
          row.classList.add('active');
          _updateModeClass();
          _updateToolbarState();
        }
        const nameEl = row.querySelector('.dl-name');
        if (!nameEl) return;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'dl-name-input';
        inp.value = layer.name;
        nameEl.replaceWith(inp);
        inp.focus(); inp.select();
        const commit = () => {
          layer.name = inp.value.trim() || 'Calque';
          onSave();
          renderPanel();
        };
        inp.addEventListener('blur', commit);
        inp.addEventListener('keydown', ev => {
          if (ev.key === 'Enter') { ev.preventDefault(); inp.blur(); }
          if (ev.key === 'Escape') { inp.value = layer.name; inp.blur(); }
          ev.stopPropagation();
        });
      });

      row.querySelectorAll('[data-dir]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const dir = btn.dataset.dir === 'up' ? -1 : 1;
          const ni = i + dir;
          if (ni < 0 || ni >= layers.length) return;
          [layers[i], layers[ni]] = [layers[ni], layers[i]];
          _refresh();
          renderPanel();
          onSave();
        });
      });
      row.querySelector('.dl-del').addEventListener('click', e => { e.stopPropagation(); deleteLayer(layer.id); });
      row.addEventListener('click', () => _setActiveLayer(layer.id));
      list.appendChild(row);
    });

    _updateToolbarState();
  }

  // ===== TOOLBAR STATE =====
  function _updateToolbarState() {
    const toolbar = document.getElementById('drawing-toolbar');
    const hasLayer = !!activeLayerId && !!((_ctx())?.layers.find(l => l.id === activeLayerId));
    toolbar.classList.toggle('hidden', !hasLayer);
    if (!hasLayer) return;

    const selShape = _getSelectedShape();
    let displayType = null;
    if (tool && tool !== 'select') {
      displayType = tool;
    } else if (tool === 'select' && selShape) {
      displayType = selShape.type;
    }

    document.querySelectorAll('.draw-tool-btn[data-tool]').forEach(btn => {
      const t = btn.dataset.tool;
      const isCurrentTool = t === tool;
      const isSelectedShapeType = tool === 'select' && selShape && t === selShape.type;
      btn.classList.toggle('active', isCurrentTool || isSelectedShapeType);
    });

    const isLine  = displayType ? LINE_TOOLS.has(displayType) : false;
    const isText  = displayType === 'text';
    const isArrow = displayType === 'arrow';

    const source = selShape && tool === 'select' ? selShape : null;
    const c   = source ? (source.color        || '#e63946')  : color;
    const sw  = source ? (source.strokeWidth   ?? 2)          : strokeWidth;
    const fs  = source ? (source.fontSize      || 14)         : fontSize;
    const ds  = source ? !!source.dashed                      : dashed;
    const da  = source ? !!source.doubleArrow                 : doubleArrow;
    const ow  = source ? (source.strokeWidth   ?? 2)          : textOutline;
    const oc  = source ? (source.outlineColor  || '#000000')  : outlineColor;

    document.getElementById('drawing-color').value         = c;
    document.getElementById('drawing-stroke-width').value  = sw;
    document.getElementById('drawing-text-outline').value  = ow;
    document.getElementById('drawing-outline-color').value = oc;
    document.getElementById('btn-drawing-dashed').classList.toggle('active', ds);
    document.getElementById('btn-drawing-double-arrow').classList.toggle('active', da);
    document.getElementById('drawing-font-size').value = fs;

    document.getElementById('drawing-stroke-width').classList.toggle('hidden',       !isLine);
    document.getElementById('btn-drawing-dashed').classList.toggle('hidden',         !isLine);
    document.getElementById('btn-drawing-double-arrow').classList.toggle('hidden',   !isArrow);
    document.getElementById('drawing-font-size').classList.toggle('hidden',          !isText);
    document.getElementById('drawing-text-outline').classList.toggle('hidden',       !isText);
    document.getElementById('drawing-outline-color').classList.toggle('hidden',      !isText);

    const hasSel = !!(planSelShapeId || mapSelShapeId);
    const hasSelText = hasSel && isText;
    document.getElementById('btn-edit-text-shape').classList.toggle('hidden', !hasSelText);
    document.getElementById('btn-delete-selected-shape').classList.toggle('hidden', !hasSel);
  }

  function _getSelectedShape() {
    if (planSelShapeId) {
      const ctx = _ctx();
      return ctx?.layers.flatMap(l => l.shapes).find(s => s.id === planSelShapeId) || null;
    }
    if (mapSelShapeId) {
      const site = getActiveSite();
      const layer = site?.mapDrawingLayers?.find(l => l.id === mapSelLayerId);
      return layer?.shapes.find(s => s.id === mapSelShapeId) || null;
    }
    return null;
  }

  // ===== TOOL SELECTION =====
  function setTool(t) {
    if (planDrawing) cancelPlanDrawing();
    if (mapDrawing) cancelMapDrawing();
    _clearMapHandles();
    tool = t;
    planSelShapeId = null;
    planSelLayerId = null;
    _updateModeClass();
    _updateToolbarState();
    if (getViewMode() === 'plan') onRefreshPlan();
  }

  function _handleToolBtnClick(t) {
    if (!activeLayerId) return;
    if (getViewMode() === 'plan') {
      setTool(tool === t ? null : t);
    } else if (getViewMode() === 'map') {
      if (t === 'select') {
        tool = tool === 'select' ? null : 'select';
        if (tool === null) _clearMapHandles();
        _updateToolbarState();
      } else {
        if (mapDrawing) cancelMapDrawing();
        _startMapTool(t);
      }
    }
  }

  // ===== PLAN: SVG RENDERING =====
  function renderPlanLayers(svg) {
    const ctx = _ctx();
    if (!ctx || ctx.type !== 'plan') return;
    const plan = getPlan();

    const vp = document.getElementById('plan-viewport');
    const hr = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hr.setAttribute('class', 'drawing-hit-area');
    hr.setAttribute('x', '0'); hr.setAttribute('y', '0');
    hr.setAttribute('width', vp.clientWidth || 2000);
    hr.setAttribute('height', vp.clientHeight || 2000);
    hr.setAttribute('fill', 'transparent');
    hr.setAttribute('pointer-events', (tool && activeLayerId) ? 'all' : 'none');
    svg.appendChild(hr);

    [...ctx.layers].reverse().forEach(layer => {
      if (!layer.visible) return;
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      g.setAttribute('data-layer-id', layer.id);
      layer.shapes.forEach(shape => {
        const sg = planShapeToSvgG(shape, plan);
        if (!sg) return;
        sg.setAttribute('data-shape-id', shape.id);
        sg.setAttribute('data-layer-id', layer.id);
        sg.setAttribute('class', 'drawing-shape' + (shape.id === planSelShapeId ? ' drawing-shape-selected editing' : ''));
        if (tool === 'select') {
          sg.style.pointerEvents = 'painted';
          sg.style.cursor = shape.type === 'text' ? 'text' : 'move';
          sg.addEventListener('mousedown', e => {
            e.stopPropagation();
            _selectPlanShape(shape.id, layer.id);
            _startPlanShapeDrag(shape, e.clientX, e.clientY);
          });
        } else {
          sg.style.pointerEvents = 'none';
        }
        g.appendChild(sg);
      });
      svg.appendChild(g);
    });

    if (tool === 'select' && planSelShapeId) {
      const shape = ctx.layers.flatMap(l => l.shapes).find(s => s.id === planSelShapeId);
      if (shape) _renderPlanHandles(svg, shape);
    }
  }

  function _renderPlanHandles(svg, shape) {
    const plan = getPlan();
    const canRemove = shape.type === 'polygon' ? shape.points.length > 3 : shape.points.length > 2;
    const hg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    hg.setAttribute('class', 'drawing-handles');

    const canHaveMidpoints = shape.type === 'polygon' || shape.type === 'polyline';
    if (canHaveMidpoints) {
      const n = shape.points.length;
      const segs = shape.type === 'polygon' ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = shape.points[i], b = shape.points[(i + 1) % n];
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
        const sx = mx * plan.scale + plan.offsetX;
        const sy = my * plan.scale + plan.offsetY;
        const m = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        m.setAttribute('cx', sx); m.setAttribute('cy', sy);
        m.setAttribute('r', 4);
        m.setAttribute('fill', shape.color || '#e63946');
        m.setAttribute('opacity', '0.45');
        m.setAttribute('stroke', 'white');
        m.setAttribute('stroke-width', 1.5);
        m.setAttribute('class', 'drawing-midpoint');
        m.style.pointerEvents = 'all';
        m.style.cursor = 'crosshair';
        const insertIdx = i + 1;
        m.addEventListener('mousedown', e => {
          e.stopPropagation();
          shape.points.splice(insertIdx, 0, { x: mx, y: my });
          onRefreshPlan();
          _startPlanHandleDrag(shape, insertIdx, e.clientX, e.clientY);
        });
        hg.appendChild(m);
      }
    }

    shape.points.forEach((p, i) => {
      const sx = p.x * plan.scale + plan.offsetX;
      const sy = p.y * plan.scale + plan.offsetY;
      const h = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      h.setAttribute('cx', sx); h.setAttribute('cy', sy);
      h.setAttribute('r', 6);
      h.setAttribute('fill', 'white');
      h.setAttribute('stroke', shape.color || '#e63946');
      h.setAttribute('stroke-width', 2);
      h.setAttribute('class', 'drawing-handle');
      h.style.pointerEvents = 'all';
      h.style.cursor = 'move';
      h.addEventListener('mousedown', e => { e.stopPropagation(); _startPlanHandleDrag(shape, i, e.clientX, e.clientY); });
      const removeVertex = e => {
        e.preventDefault(); e.stopPropagation();
        if (!canRemove) return;
        shape.points.splice(i, 1);
        onRefreshPlan();
        onSave();
      };
      h.addEventListener('contextmenu', removeVertex);
      h.addEventListener('dblclick',    removeVertex);
      hg.appendChild(h);
    });

    svg.appendChild(hg);
  }

  // ===== PLAN: DRAG =====
  function _startPlanShapeDrag(shape, startX, startY) {
    const plan = getPlan();
    const origPts = shape.points.map(p => ({ ...p }));
    let moved = false;
    const onMove = e => {
      moved = true;
      const dx = (e.clientX - startX) / plan.scale;
      const dy = (e.clientY - startY) / plan.scale;
      shape.points = origPts.map(p => ({ x: p.x + dx, y: p.y + dy }));
      onRefreshPlan();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      if (moved) onSave();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function _startPlanHandleDrag(shape, idx, startX, startY) {
    const plan = getPlan();
    const origPt = { ...shape.points[idx] };
    const onMove = e => {
      shape.points[idx] = {
        x: origPt.x + (e.clientX - startX) / plan.scale,
        y: origPt.y + (e.clientY - startY) / plan.scale,
      };
      onRefreshPlan();
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onSave();
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  // ===== PLAN: SHAPE SELECTION =====
  function _selectPlanShape(shapeId, layerId) {
    planSelShapeId = shapeId;
    planSelLayerId = layerId;
    _updateToolbarState();
    onRefreshPlan();
  }

  function _deselectPlanShape() {
    planSelShapeId = null;
    planSelLayerId = null;
    _updateToolbarState();
    onRefreshPlan();
  }

  function _deletePlanShape() {
    if (!planSelShapeId) return;
    const ctx = _ctx();
    if (!ctx) return;
    for (const layer of ctx.layers) {
      const idx = layer.shapes.findIndex(s => s.id === planSelShapeId);
      if (idx >= 0) { layer.shapes.splice(idx, 1); break; }
    }
    planSelShapeId = null;
    planSelLayerId = null;
    onRefreshPlan();
    onSave();
    _updateToolbarState();
  }

  // ===== PLAN: DRAWING CLICKS =====
  function _onPlanClick(planX, planY, screenX, screenY) {
    if (tool === 'text') {
      _showTextPopover(screenX, screenY, planX, planY, 'plan');
      return;
    }
    if (!planDrawing) {
      planDrawing = true;
      planPoints = [{ x: planX, y: planY }];
    } else {
      planPoints.push({ x: planX, y: planY });
      if ((tool === 'arrow' || tool === 'circle') && planPoints.length >= 2) {
        _finishPlanShape();
        return;
      }
    }
    _renderPlanPreview();
  }

  function _renderPlanPreview() {
    const svg = document.getElementById('plan-overlay');
    svg.querySelectorAll('.drawing-preview').forEach(el => el.remove());
    if (!planDrawing || !planPoints.length) return;
    const plan = getPlan();
    const pts = planPoints.map(p => ({
      x: p.x * plan.scale + plan.offsetX,
      y: p.y * plan.scale + plan.offsetY,
    }));
    const S = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);

    if (pts.length >= 2 && tool !== 'circle') {
      const ln = S('polyline');
      ln.setAttribute('class', 'drawing-preview');
      ln.setAttribute('points', pts.map(p => `${p.x},${p.y}`).join(' '));
      ln.setAttribute('fill', 'none');
      ln.setAttribute('stroke', color);
      ln.setAttribute('stroke-width', strokeWidth);
      ln.setAttribute('stroke-dasharray', '6,3');
      ln.setAttribute('opacity', '0.8');
      ln.setAttribute('pointer-events', 'none');
      svg.appendChild(ln);
    }

    const dot = S('circle');
    dot.setAttribute('class', 'drawing-preview');
    dot.setAttribute('cx', pts[0].x); dot.setAttribute('cy', pts[0].y);
    dot.setAttribute('r', 5);
    dot.setAttribute('fill', color);
    dot.setAttribute('stroke', 'white');
    dot.setAttribute('stroke-width', '1.5');
    dot.setAttribute('pointer-events', 'none');
    svg.appendChild(dot);
  }

  function _updateRubberBand(clientX, clientY) {
    const svg = document.getElementById('plan-overlay');
    svg.querySelectorAll('.drawing-rubber').forEach(el => el.remove());
    if (!planDrawing || !planPoints.length) return;
    const plan = getPlan();
    const rect = svg.getBoundingClientRect();
    const mx = clientX - rect.left, my = clientY - rect.top;
    const p0 = planPoints[0];
    const sx0 = p0.x * plan.scale + plan.offsetX;
    const sy0 = p0.y * plan.scale + plan.offsetY;
    const S = tag => document.createElementNS('http://www.w3.org/2000/svg', tag);

    if (tool === 'circle') {
      const r = Math.hypot(mx - sx0, my - sy0);
      const c = S('circle');
      c.setAttribute('class', 'drawing-rubber');
      c.setAttribute('cx', sx0); c.setAttribute('cy', sy0);
      c.setAttribute('r', r);
      c.setAttribute('fill', hexToRgba(color, 0.1));
      c.setAttribute('stroke', color);
      c.setAttribute('stroke-width', strokeWidth);
      c.setAttribute('stroke-dasharray', '6,3');
      c.setAttribute('opacity', '0.7');
      c.setAttribute('pointer-events', 'none');
      svg.appendChild(c);
    } else {
      const lp = planPoints[planPoints.length - 1];
      const lsx = lp.x * plan.scale + plan.offsetX;
      const lsy = lp.y * plan.scale + plan.offsetY;
      const rb = S('line');
      rb.setAttribute('class', 'drawing-rubber');
      rb.setAttribute('x1', lsx); rb.setAttribute('y1', lsy);
      rb.setAttribute('x2', mx); rb.setAttribute('y2', my);
      rb.setAttribute('stroke', color);
      rb.setAttribute('stroke-width', strokeWidth);
      rb.setAttribute('stroke-dasharray', '4,3');
      rb.setAttribute('opacity', '0.5');
      rb.setAttribute('pointer-events', 'none');
      svg.appendChild(rb);
    }
  }

  function _finishPlanShape() {
    if (!planDrawing) return;
    let pts = [...planPoints];
    const plan = getPlan();
    if (pts.length >= 2 && (tool === 'polygon' || tool === 'polyline')) {
      const a = pts[pts.length - 1], b = pts[pts.length - 2];
      if (Math.hypot((a.x - b.x) * plan.scale, (a.y - b.y) * plan.scale) < 8) pts.pop();
    }
    const minPts = tool === 'polygon' ? 3 : 2;
    if (pts.length < minPts) { cancelPlanDrawing(); return; }
    const ctx = _ctx();
    const layer = ctx?.layers.find(l => l.id === activeLayerId);
    if (!layer) { cancelPlanDrawing(); return; }
    const shape = { id: uid(), type: tool, color, strokeWidth, dashed, points: pts };
    if (tool === 'polygon' || tool === 'circle') shape.fillOpacity = 0.15;
    if (tool === 'arrow') shape.doubleArrow = doubleArrow;
    layer.shapes.push(shape);
    planDrawing = false;
    planPoints = [];
    const svg = document.getElementById('plan-overlay');
    svg.querySelectorAll('.drawing-preview, .drawing-rubber').forEach(el => el.remove());
    onRefreshPlan();
    onSave();
  }

  function cancelPlanDrawing() {
    planDrawing = false;
    planPoints = [];
    const svg = document.getElementById('plan-overlay');
    if (svg) svg.querySelectorAll('.drawing-preview, .drawing-rubber').forEach(el => el.remove());
  }

  // ===== TEXT POPOVER =====
  // existingShape: if provided, edits that shape's text instead of creating a new one
  function _showTextPopover(screenX, screenY, coordA, coordB, context, existingShape = null) {
    const pop = document.getElementById('drawing-text-popover');
    const cp = document.getElementById('center-panel');
    const cpRect = cp.getBoundingClientRect();
    pop.style.left = Math.min(screenX, cpRect.width - 230) + 'px';
    pop.style.top  = Math.min(screenY + 10, cpRect.height - 110) + 'px';
    pop.classList.remove('hidden');
    const input = document.getElementById('drawing-text-value');
    input.value = existingShape?.text || '';
    input.focus();
    input.select();

    const confirm = () => {
      const text = input.value.trim();
      pop.classList.add('hidden');
      if (!text) return;
      if (existingShape) {
        existingShape.text = text;
        if (context === 'plan') onRefreshPlan();
        else renderMapLayers();
        onSave();
        return;
      }
      const ctx = _ctx();
      const layer = ctx?.layers.find(l => l.id === activeLayerId);
      if (!layer) return;
      const pts = context === 'plan' ? [{ x: coordA, y: coordB }] : [{ lat: coordA, lon: coordB }];
      const shape = { id: uid(), type: 'text', color, strokeWidth: textOutline, outlineColor, points: pts, text, fontSize };
      layer.shapes.push(shape);
      if (context === 'plan') onRefreshPlan();
      else renderMapLayers();
      onSave();
    };
    const cancel = () => { pop.classList.add('hidden'); };

    document.getElementById('btn-drawing-text-ok').onclick = confirm;
    document.getElementById('btn-drawing-text-cancel').onclick = cancel;
    input.onkeydown = e => { if (e.key === 'Enter') confirm(); else if (e.key === 'Escape') cancel(); };
  }

  // ===== EXPORT PLAN =====
  async function downloadAnnotatedPlan() {
    const site = getActiveSite();
    const active = getActivePlanInfo();
    const plan = getPlan();
    if (!active?.imageId || !plan.img) return;

    const ctx = _ctx();
    const layers = ctx?.layers || [];
    const hasAnnotations = layers.some(l => l.visible && l.shapes.length > 0);

    const W = plan.img.naturalWidth;
    const H = plan.img.naturalHeight;
    const offscreen = document.createElement('canvas');
    offscreen.width  = W;
    offscreen.height = H;
    const c = offscreen.getContext('2d');
    c.fillStyle = '#ffffff';
    c.fillRect(0, 0, W, H);
    c.drawImage(plan.img, 0, 0, W, H);

    if (hasAnnotations) {
      // strokeWidth is in screen pixels; scale up to match image natural resolution
      const strokeScale = 1 / plan.scale;
      const fakePlan = { scale: 1, offsetX: 0, offsetY: 0 };
      const ordered = [...layers].reverse();
      for (const layer of ordered) {
        if (!layer.visible) continue;
        for (const shape of layer.shapes) {
          _drawShapeOnCanvas(c, shape, fakePlan, strokeScale);
        }
      }
    }

    offscreen.toBlob(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = sanitizeFilename(`${site?.name || 'site'}_${active.label}_annote`) + '.jpg';
      a.click();
      URL.revokeObjectURL(url);
    }, 'image/jpeg', 0.92);
  }

  function _drawShapeOnCanvas(c, shape, fakePlan, strokeScale = 1) {
    if (!shape.points?.length) return;
    const pts = shape.points.map(p => ({
      x: p.x * fakePlan.scale + fakePlan.offsetX,
      y: p.y * fakePlan.scale + fakePlan.offsetY,
    }));
    const sw  = (shape.strokeWidth || 2) * strokeScale;
    const col = shape.color || '#e63946';

    c.save();
    c.strokeStyle = col;
    c.lineWidth   = sw;
    c.lineJoin    = 'round';
    c.lineCap     = 'round';
    if (shape.dashed) c.setLineDash([sw * 4, sw * 2]);
    else              c.setLineDash([]);

    if (shape.type === 'polygon' && pts.length >= 2) {
      c.beginPath();
      pts.forEach((p, i) => i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y));
      c.closePath();
      c.fillStyle = hexToRgba(col, shape.fillOpacity ?? 0.15);
      c.fill();
      c.stroke();
    } else if (shape.type === 'circle' && pts.length >= 2) {
      const r = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      c.beginPath();
      c.arc(pts[0].x, pts[0].y, r, 0, Math.PI * 2);
      c.fillStyle = hexToRgba(col, shape.fillOpacity ?? 0.15);
      c.fill();
      c.stroke();
    } else if (shape.type === 'polyline' && pts.length >= 2) {
      c.beginPath();
      pts.forEach((p, i) => i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y));
      c.stroke();
    } else if (shape.type === 'arrow' && pts.length >= 2) {
      c.beginPath();
      pts.forEach((p, i) => i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y));
      c.stroke();
      const len = 8 + sw * 2;
      const drawHead = (tip, from) => {
        const a = Math.atan2(tip.y - from.y, tip.x - from.x);
        c.setLineDash([]);
        c.beginPath();
        c.moveTo(tip.x, tip.y);
        c.lineTo(tip.x - len * Math.cos(a - Math.PI/6), tip.y - len * Math.sin(a - Math.PI/6));
        c.lineTo(tip.x - len * Math.cos(a + Math.PI/6), tip.y - len * Math.sin(a + Math.PI/6));
        c.closePath();
        c.fillStyle = col;
        c.fill();
      };
      drawHead(pts[pts.length - 1], pts[pts.length - 2]);
      if (shape.doubleArrow) drawHead(pts[0], pts[1]);
    } else if (shape.type === 'text' && pts.length >= 1) {
      const fs  = (shape.fontSize || 14) * strokeScale;
      const ow  = (shape.strokeWidth ?? 2) * strokeScale;
      const oc  = shape.outlineColor || 'rgba(0,0,0,0.65)';
      c.font      = `600 ${fs}px "Segoe UI", system-ui, sans-serif`;
      c.fillStyle = col;
      if (ow > 0) {
        c.strokeStyle = oc;
        c.lineWidth   = ow * 2;
        c.lineJoin    = 'round';
        c.setLineDash([]);
        c.strokeText(shape.text || '', pts[0].x, pts[0].y);
      }
      c.fillText(shape.text || '', pts[0].x, pts[0].y);
    }

    c.restore();
  }

  // ===== EVENT WIRING =====
  function initEvents() {
    const svg = document.getElementById('plan-overlay');

    svg.addEventListener('mousedown', e => {
      if (!tool || !activeLayerId) return;
      if (tool !== 'select') {
        e.stopPropagation();
      } else {
        if (e.target.closest('.drawing-handle') || e.target.closest('[data-shape-id]')) e.stopPropagation();
      }
    });

    svg.addEventListener('click', e => {
      if (!tool || !activeLayerId) return;
      if (tool === 'select') {
        const shapeEl = e.target.closest('[data-shape-id]');
        if (shapeEl) {
          _selectPlanShape(shapeEl.dataset.shapeId, shapeEl.dataset.layerId);
        } else if (!e.target.closest('.drawing-handle')) {
          _deselectPlanShape();
        }
        return;
      }
      e.stopPropagation();
      const plan = getPlan();
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      _onPlanClick((mx - plan.offsetX) / plan.scale, (my - plan.offsetY) / plan.scale, mx, my);
    });

    svg.addEventListener('dblclick', e => {
      if (!tool || !activeLayerId) return;
      if (tool === 'select') {
        const shapeEl = e.target.closest('[data-shape-id]');
        if (!shapeEl) return;
        const ctx = _ctx();
        const shape = ctx?.layers.flatMap(l => l.shapes).find(s => s.id === shapeEl.dataset.shapeId);
        if (!shape || shape.type !== 'text') return;
        e.stopPropagation(); e.preventDefault();
        const p = getPlan();
        const sx = shape.points[0].x * p.scale + p.offsetX;
        const sy = shape.points[0].y * p.scale + p.offsetY;
        _showTextPopover(sx, sy, shape.points[0].x, shape.points[0].y, 'plan', shape);
        return;
      }
      e.stopPropagation(); e.preventDefault();
      if (planDrawing && (tool === 'polygon' || tool === 'polyline')) _finishPlanShape();
    });

    svg.addEventListener('mousemove', e => {
      if (!planDrawing || tool === 'text' || tool === 'select') return;
      _updateRubberBand(e.clientX, e.clientY);
    });

    document.getElementById('drawing-panel-toggle').addEventListener('click', () => {
      panelOpen = !panelOpen;
      if (!panelOpen) {
        if (planDrawing) cancelPlanDrawing();
        if (mapDrawing) cancelMapDrawing();
        _clearMapHandles();
        tool = null;
        planSelShapeId = null;
        planSelLayerId = null;
        _updateModeClass();
        if (getViewMode() === 'plan') onRefreshPlan();
      }
      renderPanel();
    });
    document.getElementById('btn-add-drawing-layer').addEventListener('click', addLayer);

    document.querySelectorAll('.draw-tool-btn[data-tool]').forEach(btn => {
      btn.addEventListener('click', () => _handleToolBtnClick(btn.dataset.tool));
    });

    document.getElementById('drawing-color').addEventListener('input', e => {
      color = e.target.value;
      const s = _getSelectedShape(); if (s) { s.color = color; _refresh(); onSave(); }
    });
    document.getElementById('drawing-stroke-width').addEventListener('input', e => {
      strokeWidth = Math.max(1, Math.min(20, parseInt(e.target.value) || 2));
      const s = _getSelectedShape();
      if (s && s.type !== 'text') { s.strokeWidth = strokeWidth; _refresh(); onSave(); }
    });
    document.getElementById('drawing-font-size').addEventListener('change', e => {
      fontSize = parseInt(e.target.value) || 14;
      const s = _getSelectedShape(); if (s && s.type === 'text') { s.fontSize = fontSize; _refresh(); onSave(); }
    });
    document.getElementById('drawing-text-outline').addEventListener('input', e => {
      textOutline = Math.max(0, Math.min(20, parseInt(e.target.value) || 2));
      const s = _getSelectedShape(); if (s && s.type === 'text') { s.strokeWidth = textOutline; _refresh(); onSave(); }
    });
    document.getElementById('drawing-outline-color').addEventListener('input', e => {
      outlineColor = e.target.value;
      const s = _getSelectedShape(); if (s && s.type === 'text') { s.outlineColor = outlineColor; _refresh(); onSave(); }
    });
    document.getElementById('btn-drawing-dashed').addEventListener('click', () => {
      const s = _getSelectedShape();
      if (s) { s.dashed = !s.dashed; dashed = s.dashed; }
      else    { dashed = !dashed; }
      _refresh(); onSave();
      _updateToolbarState();
    });
    document.getElementById('btn-drawing-double-arrow').addEventListener('click', () => {
      const s = _getSelectedShape();
      if (s) { s.doubleArrow = !s.doubleArrow; doubleArrow = s.doubleArrow; }
      else    { doubleArrow = !doubleArrow; }
      _refresh(); onSave();
      _updateToolbarState();
    });

    document.getElementById('btn-edit-text-shape').addEventListener('click', () => {
      const shape = _getSelectedShape();
      if (!shape || shape.type !== 'text') return;
      if (planSelShapeId) {
        const p = getPlan();
        const sx = shape.points[0].x * p.scale + p.offsetX;
        const sy = shape.points[0].y * p.scale + p.offsetY;
        _showTextPopover(sx, sy, shape.points[0].x, shape.points[0].y, 'plan', shape);
      } else if (mapSelShapeId) {
        const map = getMap();
        const ll = [shape.points[0].lat, shape.points[0].lon];
        const cp = map.latLngToContainerPoint(ll);
        const mapEl = document.getElementById('map');
        const mapRect = mapEl.getBoundingClientRect();
        const cpPanel = document.getElementById('center-panel').getBoundingClientRect();
        _showTextPopover(mapRect.left - cpPanel.left + cp.x, mapRect.top - cpPanel.top + cp.y, ll[0], ll[1], 'map', shape);
      }
    });
    document.getElementById('btn-delete-selected-shape').addEventListener('click', deleteSelectedShape);
    document.getElementById('btn-download-plan-annotated').addEventListener('click', downloadAnnotatedPlan);
  }

  // ===== MAP: LAYER RENDERING =====
  function renderMapLayers() {
    const map = getMap();
    Object.values(mapLayerGroups).forEach(lg => lg?.remove());
    mapLayerGroups = {};
    const site = getActiveSite();
    if (!site || !map) return;
    [...(site.mapDrawingLayers || [])].reverse().forEach(layer => {
      const lg = L.layerGroup().addTo(map);
      if (layer.visible) {
        layer.shapes.forEach(shape => _addMapShape(shape, lg, layer.id));
      }
      mapLayerGroups[layer.id] = lg;
    });
  }

  function _addMapShape(shape, lg, layerId) {
    const map = getMap();
    if (!shape.points?.length) return;
    const ll = shape.points.map(p => [p.lat, p.lon]);
    const sw = shape.strokeWidth || 2;
    const dashArray = shape.dashed ? `${sw * 4} ${sw * 2}` : null;
    const opts = { color: shape.color || '#e63946', weight: sw, dashArray, interactive: true };
    const click = layer => {
      layer.on('click', () => {
        if (getInteractionMode() === 'map-drawing') return;
        if (tool === 'select' && activeLayerId) _selectMapShape(shape.id, layerId);
      });
    };
    if (shape.type === 'polygon' && ll.length >= 2) {
      const l = L.polygon(ll, { ...opts, fill: true, fillColor: shape.color, fillOpacity: shape.fillOpacity || 0.15 });
      click(l); l.addTo(lg);
    } else if (shape.type === 'circle' && ll.length >= 2) {
      const radius = L.latLng(ll[0]).distanceTo(ll[1]);
      const l = L.circle(ll[0], { ...opts, radius, fill: true, fillColor: shape.color, fillOpacity: shape.fillOpacity || 0.15 });
      click(l); l.addTo(lg);
    } else if (shape.type === 'polyline' && ll.length >= 2) {
      const l = L.polyline(ll, { ...opts, fill: false });
      click(l); l.addTo(lg);
    } else if (shape.type === 'arrow' && ll.length >= 2) {
      _addMapArrow(shape, lg, layerId);
    } else if (shape.type === 'text' && ll.length >= 1) {
      const fs  = shape.fontSize || 14;
      const ow  = shape.strokeWidth ?? 2;
      const oc  = shape.outlineColor || '#000000';
      const shadow = `0 0 ${ow * 1.5}px ${escapeAttr(oc)}, 0 0 ${ow * 3}px ${escapeAttr(oc)}`;
      const l = L.marker(ll[0], {
        icon: L.divIcon({
          className: '',
          html: `<div class="map-drawing-text" style="color:${escapeAttr(shape.color || '#e63946')};font-size:${fs}px;text-shadow:${shadow}">${escapeHtml(shape.text || '')}</div>`,
          iconSize: null, iconAnchor: [0, 0],
        }),
        interactive: true,
      });
      l.on('dblclick', e => {
        L.DomEvent.stopPropagation(e);
        if (tool !== 'select' || !activeLayerId) return;
        const map = getMap();
        const cp = map.latLngToContainerPoint(ll[0]);
        const mapEl = document.getElementById('map');
        const mapRect = mapEl.getBoundingClientRect();
        const cpPanel = document.getElementById('center-panel').getBoundingClientRect();
        _showTextPopover(mapRect.left - cpPanel.left + cp.x, mapRect.top - cpPanel.top + cp.y, ll[0][0], ll[0][1], 'map', shape);
      });
      click(l); l.addTo(lg);
    }
  }

  function _addMapArrow(shape, lg, layerId) {
    const map = getMap();
    const ll = shape.points.map(p => [p.lat, p.lon]);
    const col = escapeAttr(shape.color || '#e63946');
    L.polyline(ll, { color: shape.color || '#e63946', weight: shape.strokeWidth || 2, interactive: false }).addTo(lg);
    const _arrowMarker = (tip, from) => {
      const p1 = map.latLngToLayerPoint(from);
      const p2 = map.latLngToLayerPoint(tip);
      const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
      const svg = `<svg width="24" height="24" viewBox="-12 -12 24 24" style="transform:rotate(${angle}deg);overflow:visible"><polygon points="12,0 -5,-6 -5,6" fill="${col}" stroke="none"/></svg>`;
      L.marker(tip, {
        icon: L.divIcon({ className: '', html: svg, iconSize: [24, 24], iconAnchor: [12, 12] }),
        interactive: true,
      }).on('click', () => {
        if (tool === 'select' && activeLayerId) _selectMapShape(shape.id, layerId);
      }).addTo(lg);
    };
    _arrowMarker(ll[ll.length - 1], ll[ll.length - 2]);
    if (shape.doubleArrow) _arrowMarker(ll[0], ll[1]);
  }

  // ===== MAP: SHAPE SELECTION =====
  function _selectMapShape(shapeId, layerId) {
    const map = getMap();
    _clearMapHandles();
    mapSelShapeId = shapeId;
    mapSelLayerId = layerId;
    _updateToolbarState();
    const site = getActiveSite();
    const layer = site?.mapDrawingLayers?.find(l => l.id === layerId);
    const shape = layer?.shapes.find(s => s.id === shapeId);
    if (!shape || !map) return;

    const canRemove = shape.type === 'polygon' ? shape.points.length > 3 : shape.points.length > 2;
    const canHaveMidpoints = shape.type === 'polygon' || shape.type === 'polyline';

    if (canHaveMidpoints) {
      const n = shape.points.length;
      const segs = shape.type === 'polygon' ? n : n - 1;
      for (let i = 0; i < segs; i++) {
        const a = shape.points[i], b = shape.points[(i + 1) % n];
        const mlat = (a.lat + b.lat) / 2, mlon = (a.lon + b.lon) / 2;
        const insertIdx = i + 1;
        const mm = L.marker([mlat, mlon], {
          draggable: true,
          zIndexOffset: -10,
          icon: L.divIcon({ className: 'drawing-handle-marker drawing-midpoint-marker', html: '<div class="drawing-midpoint-dot"></div>', iconSize: [10, 10], iconAnchor: [5, 5] }),
        }).addTo(map);
        let inserted = false;
        mm.on('dragstart', () => {
          if (!inserted) {
            shape.points.splice(insertIdx, 0, { lat: mlat, lon: mlon });
            inserted = true;
          }
        });
        mm.on('drag', e => {
          if (inserted) {
            shape.points[insertIdx] = { lat: e.latlng.lat, lon: e.latlng.lng };
            const lg = mapLayerGroups[layerId];
            if (lg) { lg.clearLayers(); layer.shapes.forEach(s => _addMapShape(s, lg, layerId)); }
          }
        });
        mm.on('dragend', () => { onSave(); _selectMapShape(shapeId, layerId); });
        mapHandleMarkers.push(mm);
      }
    }

    shape.points.forEach((p, i) => {
      const m = L.marker([p.lat, p.lon], {
        draggable: true,
        icon: L.divIcon({ className: 'drawing-handle-marker', html: '<div class="drawing-handle-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
      }).addTo(map);
      m.on('drag', e => {
        shape.points[i] = { lat: e.latlng.lat, lon: e.latlng.lng };
        const lg = mapLayerGroups[layerId];
        if (lg) { lg.clearLayers(); layer.shapes.forEach(s => _addMapShape(s, lg, layerId)); }
      });
      m.on('dragend', () => onSave());
      const removeMapVertex = () => {
        if (!canRemove) return;
        shape.points.splice(i, 1);
        _clearMapHandles();
        const lg = mapLayerGroups[layerId];
        if (lg) { lg.clearLayers(); layer.shapes.forEach(s => _addMapShape(s, lg, layerId)); }
        _selectMapShape(shapeId, layerId);
        onSave();
      };
      m.on('contextmenu', removeMapVertex);
      m.on('dblclick', e => { L.DomEvent.stopPropagation(e); removeMapVertex(); });
      mapHandleMarkers.push(m);
    });
  }

  function _clearMapHandles() {
    mapHandleMarkers.forEach(m => m.remove());
    mapHandleMarkers = [];
    mapSelShapeId = null;
    mapSelLayerId = null;
  }

  function _deleteMapShape() {
    if (!mapSelShapeId) return;
    const site = getActiveSite();
    const layer = site?.mapDrawingLayers?.find(l => l.id === mapSelLayerId);
    if (!layer) return;
    const idx = layer.shapes.findIndex(s => s.id === mapSelShapeId);
    if (idx >= 0) layer.shapes.splice(idx, 1);
    _clearMapHandles();
    renderMapLayers();
    onSave();
    _updateToolbarState();
  }

  function clearMapLayers() {
    Object.values(mapLayerGroups).forEach(lg => lg?.remove());
    mapLayerGroups = {};
    _clearMapHandles();
  }

  // ===== MAP: DRAWING INTERACTION =====
  function _startMapTool(t) {
    const map = getMap();
    mapCurrentTool = t;
    mapDrawing = true;
    mapPoints = [];
    setInteractionMode('map-drawing');
    document.getElementById('map').classList.add('map-cursor-crosshair');
    let bannerText;
    if (t === 'text')   bannerText = 'Cliquez pour placer le texte.';
    else if (t === 'arrow')  bannerText = 'Clic pour le départ, clic pour la pointe de la flèche.';
    else if (t === 'circle') bannerText = 'Clic pour le centre, clic pour le rayon du cercle.';
    else bannerText = 'Cliquez pour ajouter des points. Double-clic pour terminer.';
    setStepBanner(bannerText, [
      ...(t !== 'text' && t !== 'arrow' && t !== 'circle' ? [{ label: 'Terminer', primary: true, action: finishMapDrawing }] : []),
      { label: 'Annuler', primary: false, action: cancelMapDrawing },
    ]);
    map.on('mousemove', _onMapMousemove);
    map.on('dblclick', _onMapDblclick);
  }

  function addMapPoint(latlng) {
    const map = getMap();
    if (!mapDrawing) return;
    if (mapCurrentTool === 'text') {
      const cp = map.latLngToContainerPoint(latlng);
      const mapEl = document.getElementById('map');
      const mapRect = mapEl.getBoundingClientRect();
      const cpPanel = document.getElementById('center-panel').getBoundingClientRect();
      _showTextPopover(mapRect.left - cpPanel.left + cp.x, mapRect.top - cpPanel.top + cp.y, latlng.lat, latlng.lng, 'map');
      cancelMapDrawing();
      return;
    }
    mapPoints.push({ lat: latlng.lat, lon: latlng.lng });
    if ((mapCurrentTool === 'arrow' || mapCurrentTool === 'circle') && mapPoints.length >= 2) {
      finishMapDrawing();
      return;
    }
    _updateMapPreview();
  }

  function _updateMapPreview() {
    const map = getMap();
    if (mapPreviewShape) { mapPreviewShape.remove(); mapPreviewShape = null; }
    if (mapPoints.length < 2) return;
    const ll = mapPoints.map(p => [p.lat, p.lon]);
    mapPreviewShape = L.polyline(ll, {
      color, weight: strokeWidth, dashArray: '6,3', opacity: 0.8, interactive: false,
    }).addTo(map);
  }

  function _onMapMousemove(e) {
    const map = getMap();
    if (!mapDrawing || !mapPoints.length) return;
    if (mapRubberBand) { mapRubberBand.remove(); mapRubberBand = null; }
    const lp = mapPoints[mapPoints.length - 1];
    mapRubberBand = L.polyline([[lp.lat, lp.lon], [e.latlng.lat, e.latlng.lng]], {
      color, weight: strokeWidth, dashArray: '4,3', opacity: 0.5, interactive: false,
    }).addTo(map);
  }

  function _onMapDblclick(e) {
    if (!mapDrawing) return;
    L.DomEvent.stopPropagation(e);
    finishMapDrawing();
  }

  function finishMapDrawing() {
    const map = getMap();
    if (!mapDrawing) return;
    let pts = [...mapPoints];
    if (pts.length >= 2 && (mapCurrentTool === 'polygon' || mapCurrentTool === 'polyline')) {
      const a = pts[pts.length - 1], b = pts[pts.length - 2];
      const pa = map.latLngToContainerPoint([a.lat, a.lon]);
      const pb = map.latLngToContainerPoint([b.lat, b.lon]);
      if (Math.hypot(pa.x - pb.x, pa.y - pb.y) < 10) pts.pop();
    }
    const minPts = mapCurrentTool === 'polygon' ? 3 : 2;
    if (pts.length < minPts) { cancelMapDrawing(); return; }
    const site = getActiveSite();
    const layer = site?.mapDrawingLayers?.find(l => l.id === activeLayerId);
    if (!layer) { cancelMapDrawing(); return; }
    const shape = { id: uid(), type: mapCurrentTool, color, strokeWidth, dashed, points: pts };
    if (mapCurrentTool === 'polygon' || mapCurrentTool === 'circle') shape.fillOpacity = 0.15;
    if (mapCurrentTool === 'arrow') shape.doubleArrow = doubleArrow;
    layer.shapes.push(shape);
    _cleanupMapDrawing();
    renderMapLayers();
    onSave();
  }

  function cancelMapDrawing() {
    _cleanupMapDrawing();
  }

  function _cleanupMapDrawing() {
    const map = getMap();
    if (!map) return;
    map.off('mousemove', _onMapMousemove);
    map.off('dblclick', _onMapDblclick);
    document.getElementById('map').classList.remove('map-cursor-crosshair');
    if (mapRubberBand) { mapRubberBand.remove(); mapRubberBand = null; }
    if (mapPreviewShape) { mapPreviewShape.remove(); mapPreviewShape = null; }
    mapDrawing = false;
    mapPoints = [];
    mapCurrentTool = null;
    setInteractionMode(null);
    clearStepBanner();
  }

  // ===== UTILITIES =====
  function _updateModeClass() {
    const vp = document.getElementById('plan-viewport');
    if (!vp) return;
    const active = !!(tool && activeLayerId && getViewMode() === 'plan');
    vp.classList.toggle('drawing-mode', active && tool !== 'select');
    vp.classList.toggle('drawing-select', active && tool === 'select');
  }

  function deleteSelectedShape() {
    if (planSelShapeId) _deletePlanShape();
    else if (mapSelShapeId) _deleteMapShape();
  }

  // ===== PUBLIC API =====
  return {
    initEvents,
    renderPanel,
    renderPlanLayers,
    renderMapLayers,
    clearMapLayers,
    setTool,
    cancelPlanDrawing,
    cancelMapDrawing,
    updateModeClass: _updateModeClass,
    deleteSelectedShape,
    downloadAnnotatedPlan,
    addMapPoint,
    get tool()               { return tool; },
    get activeLayerId()      { return activeLayerId; },
    get isPlanDrawing()      { return planDrawing; },
    get isMapDrawing()       { return mapDrawing; },
    get isBlockingPan()      { return !!(tool && tool !== 'select' && activeLayerId); },
    get selectedPlanShapeId(){ return planSelShapeId; },
    get selectedMapShapeId() { return mapSelShapeId; },
  };
}
