const fs = require('fs');
const path = require('path');

const PHOTO_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — photos don't change often
// Use path relative to this file so it works from any install location
// (C:\EcaAfrica\backend\cache\photos  OR  any dev/test path)
const DEFAULT_CACHE_ROOT = path.join(__dirname, 'cache', 'photos');

function normalizeCacheRoot(rootPath) {
  return (rootPath || DEFAULT_CACHE_ROOT).replace(/\\/g, '/');
}

function sanitizeKey(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-');
}

function resolveLocalPhotoPath(studentId, roomKey, rootPath = DEFAULT_CACHE_ROOT) {
  const cacheRoot = normalizeCacheRoot(rootPath);
  const safeStudent = sanitizeKey(studentId || 'unknown-student');
  const safeRoom = sanitizeKey(roomKey || 'all-rooms');
  const localDir = path.join(cacheRoot, safeRoom);
  return path.join(localDir, `${safeStudent}.jpg`);
}

function getPhotoMetadataPath(localPath) {
  return `${localPath}.meta.json`;
}

function readPhotoMetadata(localPath) {
  const metaPath = getPhotoMetadataPath(localPath);
  if (!fs.existsSync(metaPath)) return null;

  try {
    const content = fs.readFileSync(metaPath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function writePhotoMetadata(localPath, payload = {}) {
  const metaPath = getPhotoMetadataPath(localPath);
  const safePayload = {
    ...payload,
    updatedAt: payload.updatedAt || Date.now(),
  };

  try {
    fs.writeFileSync(metaPath, JSON.stringify(safePayload, null, 2));
  } catch {
    // best-effort only; a missing metadata file should not block photo sync
  }
}

function scanRoomPhotoFiles(roomKey, rootPath = DEFAULT_CACHE_ROOT) {
  const roomRoot = path.join(normalizeCacheRoot(rootPath), sanitizeKey(roomKey || 'all-rooms'));
  if (!fs.existsSync(roomRoot)) return [];

  return fs.readdirSync(roomRoot)
    .filter((fileName) => /\.(jpe?g|png|webp)$/i.test(fileName))
    .map((fileName) => path.join(roomRoot, fileName))
    .sort((a, b) => a.localeCompare(b));
}

function buildPhotoCacheManifest(students = [], roomKey, deviceId, rootPath = DEFAULT_CACHE_ROOT) {
  return (Array.isArray(students) ? students : []).map((student) => {
    const studentId = student?.id || student?.student_id || student?.studentId || 'unknown';
    const photoUrl = student?.photo_url || student?.photoUrl || '';
    const localPath = resolveLocalPhotoPath(studentId, roomKey, rootPath);

    return {
      studentId,
      roomKey: String(roomKey || 'all-rooms'),
      deviceId: String(deviceId || 'unknown-device'),
      photoUrl,
      localPath,
      updatedAt: Date.now(),
    };
  });
}

function buildPhotoCacheSyncPlan({ studentsList = [], roomKey = 'all-rooms', deviceId = 'tablet', rootPath = DEFAULT_CACHE_ROOT } = {}) {
  const desiredManifest = buildPhotoCacheManifest(studentsList, roomKey, deviceId, rootPath);
  const desiredById = new Map();

  for (const entry of desiredManifest) {
    if (entry.photoUrl) {
      desiredById.set(String(entry.studentId), entry);
    }
  }

  const existingFiles = scanRoomPhotoFiles(roomKey, rootPath);
  const existingIds = new Set();
  const keep = [];
  const add = [];
  const changed = [];
  const remove = [];

  for (const localPath of existingFiles) {
    const studentId = path.basename(localPath, path.extname(localPath));
    existingIds.add(studentId);

    if (!desiredById.has(studentId)) {
      remove.push({ studentId, localPath, reason: 'stale' });
      continue;
    }

    const desiredEntry = desiredById.get(studentId);
    const metadata = readPhotoMetadata(localPath);
    const isSame = metadata && metadata.studentId === studentId && metadata.photoUrl === desiredEntry.photoUrl && metadata.roomKey === String(roomKey || 'all-rooms');

    if (isSame) {
      keep.push({ ...desiredEntry, localPath });
    } else {
      changed.push({
        ...desiredEntry,
        localPath,
        previousPhotoUrl: metadata?.photoUrl || null,
        previousUpdatedAt: metadata?.updatedAt || null,
        reason: 'changed',
      });
    }
  }

  for (const [studentId, desiredEntry] of desiredById.entries()) {
    if (!existingIds.has(studentId)) {
      add.push({ ...desiredEntry, localPath: desiredEntry.localPath, reason: 'missing' });
    }
  }

  return {
    roomKey: String(roomKey || 'all-rooms'),
    deviceId: String(deviceId || 'tablet'),
    total: desiredManifest.length,
    keep,
    add,
    changed,
    remove,
    manifest: desiredManifest,
  };
}

function shouldRefreshPhotoCache(entry, now = Date.now()) {
  if (!entry || !entry.updatedAt) return true;
  return (now - Number(entry.updatedAt)) > PHOTO_CACHE_TTL_MS;
}

function ensurePhotoCacheDirectory(localPath) {
  const dir = path.dirname(localPath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function savePhotoToCache(url, localPath, token = null) {
  if (!url || !localPath) return { ok: false, reason: 'missing-url-or-path' };

  try {
    const dir = ensurePhotoCacheDirectory(localPath);
    if (!dir) return { ok: false, reason: 'missing-dir' };

    return new Promise((resolve) => {
      const request = {
        method: 'GET',
        headers: {},
      };

      if (token) request.headers.Authorization = `Bearer ${token}`;

      fetch(url, request)
        .then(async (response) => {
          if (!response.ok) {
            resolve({ ok: false, reason: `http-${response.status}`, localPath });
            return;
          }

          const buffer = Buffer.from(await response.arrayBuffer());
          fs.writeFileSync(localPath, buffer);
          writePhotoMetadata(localPath, {
            studentId: path.basename(localPath, path.extname(localPath)),
            photoUrl: url,
            localPath,
            updatedAt: Date.now(),
          });
          resolve({ ok: true, localPath, size: buffer.length, updatedAt: Date.now() });
        })
        .catch((error) => {
          resolve({ ok: false, reason: error && error.message ? error.message : 'download-error', localPath });
        });
    });
  } catch (error) {
    return { ok: false, reason: error && error.message ? error.message : 'cache-write-error', localPath };
  }
}

module.exports = {
  PHOTO_CACHE_TTL_MS,
  DEFAULT_CACHE_ROOT,
  buildPhotoCacheManifest,
  buildPhotoCacheSyncPlan,
  shouldRefreshPhotoCache,
  resolveLocalPhotoPath,
  scanRoomPhotoFiles,
  readPhotoMetadata,
  writePhotoMetadata,
  ensurePhotoCacheDirectory,
  savePhotoToCache,
};
