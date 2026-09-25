import { TelegramBot } from '../notifications/TelegramBot';
import { DatabaseManager } from '../database/DatabaseManager';
import { Logger } from '../utils/Logger';

const log = new Logger('Shutdown');

export class GracefulShutdown {
  private static registered = false;

  static register(
    engine: { stop: () => Promise<void> | void; isActive: () => boolean },
    telegram: TelegramBot,
    db: DatabaseManager,
  ): void {
    if (this.registered) return;
    this.registered = true;
    let shuttingDown = false;

    const shutdown = async (signal: string, exitCode: number) => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.warn(`Received ${signal} — starting fail-closed shutdown...`);

      await telegram
        .sendMessage(`🛑 <b>Bot shutting down</b> (${signal})\nTrading is stopped; broker protective orders must remain authoritative.`)
        .catch(() => {});

      try {
        await engine.stop();
        log.info('Engine stopped');
      } catch (e: any) {
        log.error(`Engine stop error: ${e?.message ?? e}`);
        exitCode = 1;
      }

      await new Promise(r => setTimeout(r, 3_000));
      try {
        db.raw().pragma('wal_checkpoint(FULL)');
        log.info('DB checkpoint complete');
      } catch (e) {
        log.error(`DB checkpoint failed: ${String(e)}`);
        exitCode = 1;
      }

      log.info(`Shutdown complete — exiting ${exitCode}`);
      process.exit(exitCode);
    };

    const forceExit = (signal: string, code = 0) => {
      const timer = setTimeout(() => {
        log.error('Shutdown timed out after 15s — forcing exit');
        process.exit(1);
      }, 15_000);
      timer.unref();
      shutdown(signal, code).catch(e => {
        log.error(`Shutdown error: ${e?.message ?? e}`);
        process.exit(1);
      });
    };

    process.on('SIGTERM', () => forceExit('SIGTERM'));
    process.on('SIGINT', () => forceExit('SIGINT'));

    // An uncaught exception leaves application state untrustworthy. Do not
    // continue a financial engine after such an event.
    process.on('uncaughtException', (err) => {
      log.error(`Uncaught exception: ${err?.message ?? err}\n${err?.stack ?? ''}`);
      forceExit('UNCAUGHT_EXCEPTION', 1);
    });

    process.on('unhandledRejection', (reason) => {
      log.error(`Unhandled rejection: ${String(reason)}`);
      forceExit('UNHANDLED_REJECTION', 1);
    });

    log.info('Fail-closed shutdown handler registered');
  }
}
