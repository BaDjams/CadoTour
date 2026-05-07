// splitter.js — resizable handle between #center-panel and #viewer-panel
const STORAGE_KEY = 'viewer-panel-width';
const MIN_W = 160;
const MAX_W = 900;
const DEFAULT_W = 360;

let _currentWidth = DEFAULT_W;

export function initViewerSplitter() {
  const resizer = document.getElementById('viewer-resizer');
  const panel   = document.getElementById('viewer-panel');
  if (!resizer || !panel) return;

  // Restore saved width
  const saved = parseInt(localStorage.getItem(STORAGE_KEY), 10);
  if (saved >= MIN_W && saved <= MAX_W) _currentWidth = saved;

  _applyWidth(panel, _currentWidth);

  let dragging = false;
  let startX   = 0;
  let startW   = 0;

  const center = document.getElementById('center-panel');

  function startDrag(clientX) {
    dragging = true;
    startX   = clientX;
    startW   = _currentWidth;
    resizer.classList.add('dragging');
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
    if (center) center.style.pointerEvents = 'none';
  }

  function moveDrag(clientX) {
    if (!dragging) return;
    const delta = startX - clientX;
    _currentWidth = Math.min(MAX_W, Math.max(MIN_W, startW + delta));
    _applyWidth(panel, _currentWidth);
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.cursor     = '';
    document.body.style.userSelect = '';
    if (center) center.style.pointerEvents = '';
    localStorage.setItem(STORAGE_KEY, _currentWidth);
  }

  resizer.addEventListener('mousedown', e => { startDrag(e.clientX); e.preventDefault(); });
  document.addEventListener('mousemove', e => moveDrag(e.clientX));
  document.addEventListener('mouseup',   endDrag);

  resizer.addEventListener('touchstart', e => { startDrag(e.touches[0].clientX); e.preventDefault(); }, { passive: false });
  document.addEventListener('touchmove',  e => { if (dragging) moveDrag(e.touches[0].clientX); }, { passive: true });
  document.addEventListener('touchend',   endDrag);
}

export function showResizer() {
  const resizer = document.getElementById('viewer-resizer');
  if (resizer) resizer.classList.remove('hidden');
}

export function hideResizer() {
  const resizer = document.getElementById('viewer-resizer');
  if (resizer) resizer.classList.add('hidden');
}

function _applyWidth(panel, w) {
  panel.style.width    = w + 'px';
  panel.style.minWidth = w + 'px';
}
