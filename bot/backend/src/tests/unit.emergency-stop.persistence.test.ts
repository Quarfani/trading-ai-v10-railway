import { DatabaseManager } from '../database/DatabaseManager';
import { TradingEngine } from '../core/TradingEngine';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();

  const events: unknown[] = [];
  const engine = Object.create(TradingEngine.prototype) as any;
  engine.db = db;
  engine.broadcast = (event: string, data: unknown) => events.push({ event, data });
  engine.manualEmergencyKey = 'manual_emergency_stop:test';
  engine.emergency = new (await import('../integration/EmergencyStop')).EmergencyStop();

  await engine.activateEmergencyStop('unit-test stop');
  const persisted = db.getSetting('manual_emergency_stop:test');
  assert(!!persisted, 'manual emergency stop must persist a database marker');
  assert(engine.isEmergencyStopActive(), 'activated emergency stop must be active');

  const restored = Object.create(TradingEngine.prototype) as any;
  restored.db = db;
  restored.broadcast = () => {};
  restored.manualEmergencyKey = 'manual_emergency_stop:test';
  restored.emergency = new (await import('../integration/EmergencyStop')).EmergencyStop();

  assert(
    await restored.restoreManualEmergencyStop(),
    'persisted manual emergency stop must restore on a new process instance',
  );
  assert(
    restored.isEmergencyStopActive(),
    'restored manual emergency stop must remain active',
  );

  await restored.deactivateEmergencyStop('unit-test resume');
  assert(
    !restored.isEmergencyStopActive(),
    'manual emergency resume must clear the active state',
  );
  assert(
    db.getSetting('manual_emergency_stop:test') === '',
    'manual emergency resume must clear its persistence marker',
  );

  assert(
    events.some((e: any) => e.event === 'emergency_stop'),
    'emergency state changes must be broadcast',
  );

  db.raw().close();
  console.log('Result: 8 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
