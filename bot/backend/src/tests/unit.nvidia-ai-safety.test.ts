import axios from 'axios';
import { NvidiaAI } from '../ai/NvidiaAI';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const config = {
  mode: 'paper',
  nvidia: {
    apiKey: 'test-key',
    baseUrl: 'https://nvidia.invalid',
    model: 'test-model',
  },
} as any;

const signal = {
  symbol: 'EURUSD',
  side: 'BUY',
  price: 1.1,
  sl: 1.09,
  tp: 1.12,
  confidence: 0.8,
  source: 'TREND',
  reason: 'test',
  timestamp: Date.now(),
};

async function main() {
  const originalPost = (axios as any).post;
  try {
    const ai = new NvidiaAI(config);

    (axios as any).post = async () => ({
      data: {
        choices: [{ message: { content: 'error 999' } }],
      },
    });

    const fallback = await ai.scoreSignal(signal as any);
    assert(
      fallback === 1,
      'malformed NVIDIA score must fail closed to neutral multiplier',
    );

    (axios as any).post = async () => ({
      data: {
        choices: [{ message: { content: '10' } }],
      },
    });

    let missingKeyBlocked = false;
    const missingKeyLive = new NvidiaAI({
      mode: 'binance',
      mlRequired: false,
      nvidia: { apiKey: '' },
    } as any);
    try {
      await missingKeyLive.scoreSignal(signal as any);
    } catch {
      missingKeyBlocked = true;
    }
    assert(
      missingKeyBlocked,
      'missing NVIDIA API key must block live trading',
    );

    let liveBlocked = false;
    const liveAi = new NvidiaAI({
      ...config,
      mode: 'binance',
      mlRequired: false,
    } as any);
    (axios as any).post = async () => ({
      data: {
        choices: [{ message: { content: 'service error 999' } }],
      },
    });
    try {
      await liveAi.scoreSignal(signal as any);
    } catch {
      liveBlocked = true;
    }
    assert(
      liveBlocked,
      'malformed NVIDIA response must block live trading',
    );

    (axios as any).post = async () => ({
      data: { choices: [{ message: { content: '10' } }] },
    });
    const maxScore = await ai.scoreSignal({
      ...signal,
      timestamp: Date.now(),
    } as any);
    assert(
      Math.abs(maxScore - 1.3) < 1e-12,
      'valid NVIDIA score 10 must map to multiplier 1.3',
    );

    let invalidSignalBlocked = false;
    try {
      await ai.scoreSignal({
        ...signal,
        price: Number.NaN,
      } as any);
    } catch {
      invalidSignalBlocked = true;
    }
    assert(
      invalidSignalBlocked,
      'malformed signal must never be sent to NVIDIA',
    );
  } finally {
    (axios as any).post = originalPost;
  }

  console.log('Result: 5 passed, 0 failed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
