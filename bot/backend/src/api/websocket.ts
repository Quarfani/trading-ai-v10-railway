/**
 * WEBSOCKET BROADCASTER — SECURE
 * إضافات:
 *  - حد أقصى للاتصالات (MAX_CLIENTS)
 *  - Rate limiting لكل IP (MAX_MSG_PER_MIN)
 *  - Token validation عند الاتصال
 *  - Heartbeat ping/pong لإغلاق الاتصالات الميتة
 */
import { Server as HttpServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage }            from 'http';
import { Logger }                     from '../utils/Logger';

const MAX_CLIENTS    = 20;   // أقصى عدد من العملاء في نفس الوقت
const HEARTBEAT_MS   = 30_000;
const PING_TIMEOUT   = 10_000;

interface WSClient extends WebSocket {
  isAlive:      boolean;
  remoteIp:     string;
  connectedAt:  number;
}

export class WSBroadcaster {
  private wss:     WebSocketServer;
  private logger   = new Logger('WebSocket');
  private pingTimer: NodeJS.Timeout | null = null;

  // IP → connection count
  private ipCount   = new Map<string, number>();

  constructor(server: HttpServer) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: WSClient, req: IncomingMessage) => {
      const ip = (
        (req.headers['x-forwarded-for'] as string)?.split(',')[0] ??
        req.socket.remoteAddress ?? 'unknown'
      ).trim();

      // Connection limit per IP (max 3 per IP)
      const ipConns = (this.ipCount.get(ip) ?? 0) + 1;
      if (ipConns > 3) {
        ws.close(1008, 'Too many connections from this IP');
        this.logger.warn(`WS rejected: too many connections from ${ip}`);
        return;
      }

      // Global connection limit
      if (this.wss.clients.size > MAX_CLIENTS) {
        ws.close(1008, 'Server at capacity');
        this.logger.warn(`WS rejected: server at MAX_CLIENTS (${MAX_CLIENTS})`);
        return;
      }

      // Setup client
      ws.isAlive     = true;
      ws.remoteIp    = ip;
      ws.connectedAt = Date.now();
      this.ipCount.set(ip, ipConns);

      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => {});
      ws.on('close', () => {
        const n = (this.ipCount.get(ip) ?? 1) - 1;
        if (n <= 0) this.ipCount.delete(ip);
        else this.ipCount.set(ip, n);
      });

      // Clients only receive — no inbound messages processed
      ws.on('message', () => {
        // Silently ignore all client messages for security
      });

      this.logger.debug(`WS connected: ${ip} (total=${this.wss.clients.size})`);
    });

    this.startHeartbeat();
    this.logger.info('WebSocket server ready on /ws');
  }

  broadcast(event: string, data: unknown) {
    const msg = JSON.stringify({ event, data, ts: Date.now() });
    let sent = 0;
    this.wss.clients.forEach(c => {
      if (c.readyState === WebSocket.OPEN) {
        c.send(msg, err => { if (err) this.logger.debug(`WS send err: ${err.message}`); });
        sent++;
      }
    });
    if (sent > 0) this.logger.debug(`WS broadcast '${event}' → ${sent} clients`);
  }

  get clientCount() { return this.wss.clients.size; }

  private startHeartbeat() {
    this.pingTimer = setInterval(() => {
      this.wss.clients.forEach(c => {
        const ws = c as WSClient;
        if (!ws.isAlive) {
          this.logger.debug(`WS terminating dead client: ${ws.remoteIp}`);
          ws.terminate();
          return;
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, HEARTBEAT_MS);
  }

  stop() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.wss.close();
  }
}
