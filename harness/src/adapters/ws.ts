import { WebSocketServer, WebSocket } from 'ws';
import { JSONRPCServer } from 'json-rpc-2.0';
import type { CommAdapter, ChannelMessage } from '../comms.js';
import { logger } from '../logger.js';

export interface WsAdapterOptions {
  port: number;
  host: string;
}

export class WsAdapter implements CommAdapter {
  readonly name = 'ws';

  private wss: WebSocketServer | null = null;
  private clients: Set<WebSocket> = new Set();
  private rpc: JSONRPCServer = new JSONRPCServer();
  private options: WsAdapterOptions;

  constructor(options: WsAdapterOptions) {
    this.options = options;
  }

  get port(): number {
    const addr = this.wss?.address();
    if (addr && typeof addr === 'object') {
      return addr.port;
    }
    throw new Error('WS server is not listening');
  }

  addMethod(name: string, handler: (params: unknown) => unknown): void {
    this.rpc.addMethod(name, handler);
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        port: this.options.port,
        host: this.options.host,
      });

      wss.on('listening', () => {
        this.wss = wss;
        logger.info({ port: this.port, host: this.options.host }, 'WS adapter listening');
        resolve();
      });

      wss.on('error', (err) => {
        reject(err);
      });

      wss.on('connection', (socket) => {
        this.clients.add(socket);
        logger.debug({ clientCount: this.clients.size }, 'WS client connected');

        socket.on('message', async (data) => {
          const text = data.toString();
          const response = await this.rpc.receiveJSON(text);
          if (response !== null) {
            socket.send(JSON.stringify(response));
          }
        });

        socket.on('close', () => {
          this.clients.delete(socket);
          logger.debug({ clientCount: this.clients.size }, 'WS client disconnected');
        });

        socket.on('error', (err) => {
          logger.error({ err }, 'WS client error');
          this.clients.delete(socket);
        });
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const client of this.clients) {
        client.terminate();
      }
      this.clients.clear();

      if (!this.wss) {
        resolve();
        return;
      }

      this.wss.close((err) => {
        this.wss = null;
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async send(msg: ChannelMessage): Promise<void> {
    this.broadcastNotification('channel_message', {
      ...msg,
      timestamp: msg.timestamp.toISOString(),
    });
  }

  async setStatus(channelId: string, status: 'received' | 'working' | 'completed' | 'failed'): Promise<void> {
    this.broadcastNotification('status_update', { channelId, status });
  }

  broadcastNotification(method: string, params: unknown): void {
    const notification = JSON.stringify({ jsonrpc: '2.0', method, params });
    for (const client of this.clients) {
      try {
        client.send(notification, (err) => {
          if (err) {
            logger.error({ err, method }, 'WS notification send error');
            this.clients.delete(client);
          }
        });
      } catch (err) {
        logger.error({ err, method }, 'WS notification failed');
        this.clients.delete(client);
      }
    }
  }
}
