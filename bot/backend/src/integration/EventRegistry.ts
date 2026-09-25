import { Signal, Trade, TradeDecision } from '../types/trading.types';

import { Logger } from '../utils/Logger';

/**
 * TYPED EVENT REGISTRY
 *
 * Central, type-safe event system.
 * Replaces ad-hoc WebSocket broadcasts with structured events.
 *
 * Events:
 * - engine:started
 * - engine:stopped
 * - signal:received (raw signal from aggregator)
 * - signal:scored (signal after DecisionEngine)
 * - trade:opened
 * - trade:closed
 * - risk:blocked (trade rejected by risk)
 * - health:alert
 * - emergency:stop
 */
export type EventType =
  | 'engine:started'
  | 'engine:stopped'
  | 'signal:received'
  | 'signal:scored'
  | 'decision:made'
  | 'trade:opened'
  | 'trade:closed'
  | 'risk:blocked'
  | 'health:alert'
  | 'emergency:stop'
  | 'emergency:resume'
  | 'execution:failed'
  | 'system:error';

export interface TypedEvent<T> {
  type: EventType;
  timestamp: number;
  data: T;
}

export interface EventPayloads {
  'engine:started': { mode: string; symbols: string[] };
  'engine:stopped': { reason: string };
  'signal:received': Signal;
  'signal:scored': Signal;
  'decision:made': TradeDecision;
  'trade:opened': Trade;
  'trade:closed': Trade;
  'risk:blocked': { signal: Signal; reason: string };
  'health:alert': { issues: string[] };
  'emergency:stop': { reason: string };
  'emergency:resume': { approver: string };
  'execution:failed': { signal: Signal; error: string; retries?: number };
  'system:error': { error: string; context?: any };
}

type Listener<T extends EventType> = (event: TypedEvent<EventPayloads[T]>) => void;

/**
 * Type-safe event emitter
 */
export class EventRegistry {
  private logger = new Logger('EventRegistry');
  private listeners: Map<EventType, Set<Function>> = new Map();

  on<T extends EventType>(type: T, listener: Listener<T>) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)!.add(listener);
  }

  off<T extends EventType>(type: T, listener: Listener<T>) {
    this.listeners.get(type)?.delete(listener);
  }

  emit<T extends EventType>(type: T, data: EventPayloads[T]) {
    const event: TypedEvent<EventPayloads[T]> = {
      type,
      timestamp: Date.now(),
      data,
    };

    const listeners = this.listeners.get(type);
    if (listeners) {
      listeners.forEach(fn => {
        try {
          (fn as Listener<T>)(event);
        } catch (e: any) {
          this.logger.error(`Listener error for ${type}: ${e.message}`);
        }
      });
    }
  }

  /**
   * Subscribe to all events (for logging/monitoring)
   */
  onAny(listener: (event: TypedEvent<any>) => void) {
    const allTypes: EventType[] = [
      'engine:started',
      'engine:stopped',
      'signal:received',
      'signal:scored',
      'decision:made',
      'trade:opened',
      'trade:closed',
      'risk:blocked',
      'health:alert',
      'emergency:stop',
      'emergency:resume',
      'execution:failed',
      'system:error',
    ];

    allTypes.forEach(type => {
      this.on(type, listener as any);
    });
  }

  getListenerCount(type: EventType): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}
