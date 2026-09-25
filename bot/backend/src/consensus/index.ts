/**
 * CONSENSUS MODULE — PUBLIC API
 * Import everything from here.
 */
export * from './types';
export { StrategyRegistry }        from './StrategyRegistry';
export { PerformanceGate }         from './PerformanceGate';
export { StrategyConsensusEngine } from './StrategyConsensusEngine';
export { ConsensusLogger }         from './ConsensusLogger';
export { ConsensusOrchestrator }   from './ConsensusOrchestrator';
export { createDefaultAdapters,
         TrendStrategyAdapter,
         RSIStrategyAdapter,
         BreakoutStrategyAdapter,
         StructureStrategyAdapter }  from './StrategyAdapters';
