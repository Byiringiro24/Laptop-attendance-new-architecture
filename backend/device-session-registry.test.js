const test = require('node:test');
const assert = require('node:assert/strict');

const {
  registerDeviceSession,
  getConnectedDeviceSessions,
  getSelectedDeviceSession,
  findDeviceSession,
  selectDeviceSession,
} = require('./device-session-registry');

function pingSuccessFromOutput(output) {
  const text = String(output || '');
  return /TTL=|ttl=|bytes=|Reply from/i.test(text);
}

test('session registry keeps multiple live devices and filters offline ones', () => {
  const sessions = new Map();

  registerDeviceSession(sessions, {
    ipAddress: '192.168.1.10',
    deviceId: 'FK-001',
    connected: true,
  });

  registerDeviceSession(sessions, {
    ipAddress: '192.168.1.11',
    deviceId: 'FK-002',
    connected: true,
  });

  registerDeviceSession(sessions, {
    ipAddress: '192.168.1.10',
    deviceId: 'FK-001',
    connected: false,
  });

  const liveSessions = getConnectedDeviceSessions(sessions);

  assert.equal(liveSessions.length, 1);
  assert.equal(liveSessions[0].ipAddress, '192.168.1.11');
  assert.equal(liveSessions[0].deviceId, 'FK-002');
});

test('session registry can find and select one device from multiple connected sessions', () => {
  const sessions = new Map();

  registerDeviceSession(sessions, {
    ipAddress: '192.168.1.10',
    deviceId: 'FK-001',
    connected: true,
    name: 'Front Gate',
  });

  registerDeviceSession(sessions, {
    ipAddress: '192.168.1.11',
    deviceId: 'FK-002',
    connected: true,
    name: 'Main Hall',
  });

  const selected = selectDeviceSession(sessions, { deviceId: 'FK-002' });
  const byIp = findDeviceSession(sessions, { ipAddress: '192.168.1.10' });

  assert.ok(selected);
  assert.equal(selected.deviceId, 'FK-002');
  assert.equal(selected.name, 'Main Hall');
  assert.equal(byIp.deviceId, 'FK-001');
  assert.equal(byIp.name, 'Front Gate');
});

test('primary session selector keeps the tablet responsive when multiple sessions are connected', () => {
  const sessions = new Map();

  registerDeviceSession(sessions, { ipAddress: '192.168.1.10', deviceId: 'FK-001', connected: true, name: 'Front Gate' });
  registerDeviceSession(sessions, { ipAddress: '192.168.1.11', deviceId: 'FK-002', connected: true, name: 'Main Hall' });

  const selected = getSelectedDeviceSession(sessions, null);

  assert.ok(selected);
  assert.equal(selected.deviceId, 'FK-001');
  assert.equal(selected.name, 'Front Gate');
});

test('session registry keeps distinct device sessions grouped by tablet identity and device names', () => {
  const sessions = new Map();

  registerDeviceSession(sessions, {
    tabletId: 'tablet-01',
    tabletName: 'Mwanza Gate Tablet',
    ipAddress: '192.168.1.10',
    deviceId: 'FK-001',
    sessionId: 'session-001',
    connected: true,
    name: 'Front Gate',
  });

  registerDeviceSession(sessions, {
    tabletId: 'tablet-02',
    tabletName: 'Nairobi Hall Tablet',
    ipAddress: '192.168.1.11',
    deviceId: 'FK-002',
    sessionId: 'session-002',
    connected: true,
    name: 'Main Hall',
  });

  const tabletOne = findDeviceSession(sessions, { tabletId: 'tablet-01', deviceId: 'FK-001' });
  const bySession = findDeviceSession(sessions, { sessionId: 'session-002' });
  const tabletTwo = getSelectedDeviceSession(sessions, { tabletId: 'tablet-02' });

  assert.ok(tabletOne);
  assert.equal(tabletOne.name, 'Front Gate');
  assert.equal(tabletOne.tabletName, 'Mwanza Gate Tablet');
  assert.ok(bySession);
  assert.equal(bySession.deviceId, 'FK-002');
  assert.equal(bySession.name, 'Main Hall');
  assert.ok(tabletTwo);
  assert.equal(tabletTwo.deviceId, 'FK-002');
  assert.equal(tabletTwo.tabletName, 'Nairobi Hall Tablet');
});

test('ping result evaluator correctly identifies successful reachability output', () => {
  const successOutput = 'Reply from 192.168.1.10: bytes=32 time<1ms TTL=128';
  const failureOutput = 'Request timed out.';

  assert.equal(pingSuccessFromOutput(successOutput), true);
  assert.equal(pingSuccessFromOutput(failureOutput), false);
});
