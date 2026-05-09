// progress.js — overlay de progression sur la carte (load / save)
// Affiche un % et une estimation du temps restant calculée à partir
// du temps écoulé et de la fraction réalisée.

let _start = 0;
let _total = 0;

export function show(label, total) {
  _start = Date.now();
  _total = total;
  const ov = document.getElementById('progress-overlay');
  if (!ov) return;
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-percent').textContent = '0 %';
  document.getElementById('progress-eta').textContent = '';
  document.getElementById('progress-bar-fill').style.width = '0%';
  ov.classList.remove('hidden');
}

export function update(current) {
  const ov = document.getElementById('progress-overlay');
  if (!ov || ov.classList.contains('hidden')) return;
  const pct = _total > 0 ? Math.min(1, current / _total) : 1;
  document.getElementById('progress-percent').textContent = Math.round(pct * 100) + ' %';
  document.getElementById('progress-bar-fill').style.width = (pct * 100) + '%';
  if (current > 0 && current < _total) {
    const elapsed = (Date.now() - _start) / 1000;
    const totalEst = elapsed / pct;
    const remaining = Math.max(0, totalEst - elapsed);
    document.getElementById('progress-eta').textContent = _formatETA(remaining);
  } else {
    document.getElementById('progress-eta').textContent = '';
  }
}

export function hide() {
  const ov = document.getElementById('progress-overlay');
  if (ov) ov.classList.add('hidden');
}

export function setLabel(text) {
  const el = document.getElementById('progress-label');
  if (el) el.textContent = text;
}

function _formatETA(seconds) {
  if (seconds < 1) return '< 1 s restante';
  if (seconds < 60) return `~${Math.ceil(seconds)} s restantes`;
  const m = Math.ceil(seconds / 60);
  return `~${m} min restantes`;
}
