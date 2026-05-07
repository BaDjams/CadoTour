// imageStore.js — stockage des images comme Blobs en IndexedDB
// + cache d'objectURL en mémoire (le browser garde le Blob vivant tant que
// l'URL n'est pas révoquée, sans le copier dans le heap V8 comme une dataURL).

const DB_NAME    = 'cadocreator';
const DB_VERSION = 2;
const STORE_STATE  = 'state';   // existant : { 'sites' → JSON string }
const STORE_IMAGES = 'images';  // nouveau  : { imageId → Blob }

let _db = null;
const _urlCache = new Map(); // imageId → objectURL

export async function openDB() {
  if (_db) return _db;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_STATE))  db.createObjectStore(STORE_STATE);
      if (!db.objectStoreNames.contains(STORE_IMAGES)) db.createObjectStore(STORE_IMAGES);
    };
    req.onsuccess = e => { _db = e.target.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

export const STORE_STATE_NAME = STORE_STATE;

function _genId() {
  return 'img_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

export async function putBlob(blob) {
  const id = _genId();
  await putBlobWithId(id, blob);
  return id;
}

export async function putBlobWithId(id, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, 'readwrite');
    tx.objectStore(STORE_IMAGES).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function getBlob(id) {
  if (!id) return null;
  const db = await openDB();
  return new Promise(resolve => {
    const req = db.transaction(STORE_IMAGES, 'readonly').objectStore(STORE_IMAGES).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  });
}

// Renvoie un objectURL utilisable dans <img src=…> ou Pannellum.
// Le résultat est mis en cache jusqu'à révocation/suppression.
export async function getURL(id) {
  if (!id) return null;
  if (_urlCache.has(id)) return _urlCache.get(id);
  const blob = await getBlob(id);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  _urlCache.set(id, url);
  return url;
}

export function revokeURL(id) {
  const url = _urlCache.get(id);
  if (url) { URL.revokeObjectURL(url); _urlCache.delete(id); }
}

export function revokeAll() {
  for (const url of _urlCache.values()) URL.revokeObjectURL(url);
  _urlCache.clear();
}

export async function deleteImage(id) {
  if (!id) return;
  revokeURL(id);
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, 'readwrite');
    tx.objectStore(STORE_IMAGES).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// Helpers de conversion --------------------------------------------------

export function dataURLtoBlob(dataURL) {
  const [meta, b64] = dataURL.split(',');
  const mime = meta.match(/data:([^;]+)/)?.[1] || 'application/octet-stream';
  const bin  = atob(b64);
  const buf  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime });
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

// Migre un dataURL legacy vers un Blob stocké, renvoie l'imageId généré.
export async function migrateDataURL(dataURL) {
  if (!dataURL) return null;
  const blob = dataURLtoBlob(dataURL);
  return await putBlob(blob);
}
