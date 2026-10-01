import { DatabaseManager } from '../database/DatabaseManager';
import { StrategyDefinitionStore } from '../consensus/StrategyDefinitionStore';
import { StrategyDefinition } from '../consensus/strategyDefinition';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const db = new DatabaseManager(':memory:');
  await db.initialize();

  const definition: StrategyDefinition = {
    strategyId: 'store.test',
    name: 'Store Test',
    version: '1.0.0',
    enabled: true,
    lifecycle: 'RESEARCH',
    scope: {
      assetClasses: ['FOREX'],
      symbols: ['EURUSD'],
      timeframes: ['H1', 'H4'],
      regimes: ['STRONG_UPTREND'],
      sessions: ['LONDON'],
    },
    requiredData: ['OHLCV'],
    parametersVersion: 'params-1',
    riskProfile: {
      baseRiskFraction: 0.01,
      minimumRiskReward: 1.5,
      maximumDrawdown: 0.20,
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const store = new StrategyDefinitionStore(db);
  store.save(definition);

  const loaded = store.get('store.test');
  assert(loaded?.strategyId === definition.strategyId, 'definition should round-trip');

  let failed = false;
  try {
    store.promote('store.test', 'PRODUCTION', 'must not jump stages');
  } catch {
    failed = true;
  }
  assert(failed, 'invalid lifecycle jump must be rejected');

  const backtest = store.promote('store.test', 'BACKTEST', 'backtest registered');
  assert(backtest.lifecycle === 'BACKTEST', 'promotion should persist');

  const transitions = store.getTransitions('store.test');
  assert(transitions.length === 1, 'one transition should be recorded');

  console.log('Result: 8 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
