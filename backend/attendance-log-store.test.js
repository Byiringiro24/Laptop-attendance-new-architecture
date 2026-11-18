const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { AttendanceLogStore } = require('./attendance-log-store');

test('attendance log store persists multiple devices and deduplicates per device', () => {
  const tempParent = path.join(__dirname, '.tmp');
  fs.mkdirSync(tempParent, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(tempParent, 'attendance-log-store-'));
  const filePath = path.join(tempRoot, 'attendance-logs.json');
  const firstStore = new AttendanceLogStore(filePath);
  const log = { id: 1, userId: '42', timestamp: '2026-11-18T08:00:00.000Z' };

  try {
    assert.equal(firstStore.append('gate-1', [log]).length, 1);
    assert.equal(firstStore.append('gate-1', [log]).length, 0);
    assert.equal(firstStore.append('gate-2', [log]).length, 1);

    const restartedStore = new AttendanceLogStore(filePath);
    assert.equal(restartedStore.getAll().length, 2);
    assert.equal(restartedStore.getForDevice('gate-1').length, 1);
    assert.equal(restartedStore.getForDevice('gate-2').length, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
