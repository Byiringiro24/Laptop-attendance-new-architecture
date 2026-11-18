const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { DeviceBridge } = require('./device-bridge');

test('FK -3 from an empty log poll leaves the device connected', async () => {
  const tempParent = path.join(__dirname, '.tmp');
  fs.mkdirSync(tempParent, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(tempParent, 'fk-bridge-test-'));
  const statuses = [];
  const bridge = new DeviceBridge(
    { id: 'device-1', name: 'Gate', ipAddress: '192.168.1.10', port: 5005 },
    tempRoot,
    () => {},
    (_id, status) => statuses.push(status)
  );
  bridge._ready = true;
  bridge._proc = {};
  bridge.connected = true;

  let reconnects = 0;
  bridge._sendRaw = async () => ({
    success: false,
    error: 'FK_LoadGeneralLogData failed: -3',
  });
  bridge._connectRaw = async () => {
    reconnects += 1;
    return { success: true, data: { connected: true } };
  };
  bridge._scheduleReconnect = () => { reconnects += 1; };

  try {
    await bridge._runLogPoll();

    assert.equal(bridge.connected, true);
    assert.equal(reconnects, 0);
    assert.deepEqual(statuses, []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
