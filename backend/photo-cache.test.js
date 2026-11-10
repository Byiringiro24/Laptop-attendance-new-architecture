const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPhotoCacheManifest,
  buildPhotoCacheSyncPlan,
  shouldRefreshPhotoCache,
  resolveLocalPhotoPath,
} = require('./photo-cache');

test('buildPhotoCacheManifest scopes cache entries by room and student', () => {
  const result = buildPhotoCacheManifest(
    [{ id: 's-101', photo_url: '/uploads/student-101.jpg' }],
    'dorm-3',
    'tablet-01',
    'C:/tmp/eca-photo-cache'
  );

  assert.equal(result.length, 1);
  assert.equal(result[0].studentId, 's-101');
  assert.equal(result[0].roomKey, 'dorm-3');
  assert.equal(result[0].deviceId, 'tablet-01');
  assert.match(result[0].localPath, /dorm-3/);
  assert.equal(result[0].photoUrl, '/uploads/student-101.jpg');
});

test('shouldRefreshPhotoCache returns true after the 5 minute TTL', () => {
  const now = Date.now();
  const staleEntry = {
    studentId: 's-101',
    roomKey: 'dorm-3',
    deviceId: 'tablet-01',
    updatedAt: now - (6 * 60 * 1000),
  };

  assert.equal(shouldRefreshPhotoCache(staleEntry, now), true);
  assert.equal(shouldRefreshPhotoCache({ ...staleEntry, updatedAt: now - 120000 }, now), false);
});

test('resolveLocalPhotoPath keeps the room-scoped cache structure predictable', () => {
  const path = resolveLocalPhotoPath('s-101', 'dorm-3', 'C:/tmp/eca-photo-cache');

  assert.match(path, /C:\\tmp\\eca-photo-cache\\dorm-3\\s-101/);
});

test('buildPhotoCacheSyncPlan removes stale files and flags changed photos', () => {
  const rootPath = 'C:/tmp/eca-photo-cache-sync-plan';
  const roomKey = 'dorm-3';
  const staleStudentId = 'old-student';
  const changedStudentId = 's-101';
  const roomDir = path.join(rootPath, roomKey).replace(/[\\/]+/g, path.sep);

  fs.mkdirSync(roomDir, { recursive: true });
  fs.writeFileSync(path.join(roomDir, `${staleStudentId}.jpg`), 'stale');
  fs.writeFileSync(path.join(roomDir, `${changedStudentId}.jpg`), 'old-image');
  fs.writeFileSync(path.join(roomDir, `${changedStudentId}.jpg.meta.json`), JSON.stringify({
    studentId: changedStudentId,
    roomKey,
    photoUrl: '/old-photo-url',
    updatedAt: Date.now(),
  }));

  const plan = buildPhotoCacheSyncPlan({
    studentsList: [{ id: changedStudentId, photo_url: '/new-photo-url' }],
    roomKey,
    deviceId: 'tablet-01',
    rootPath,
  });

  assert.equal(plan.remove.some((entry) => entry.studentId === staleStudentId), true);
  assert.equal(plan.changed.some((entry) => entry.studentId === changedStudentId), true);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.keep.length, 0);
  assert.equal(plan.roomKey, roomKey);

  fs.rmSync(roomDir, { recursive: true, force: true });
});
