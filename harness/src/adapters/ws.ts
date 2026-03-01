import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { JSONRPCServer } from 'json-rpc-2.0';
import type { CommunicationProvider, ChannelMessage, PluginManifest, InboundHandler } from '../comms.js';
import { logger } from '../logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const { version: HARNESS_VERSION } = JSON.parse(
  readFileSync(join(__dirname, '../../package.json'), 'utf-8'),
);

export const PROTOCOL_VERSION = 1;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export interface WsAdapterOptions {
  port: number;
  host: string;
}

export class WsAdapter implements CommunicationProvider {
  readonly name = 'ws';
  readonly manifest: PluginManifest = {
    id: 'collabot.communication.ws',
    name: 'WebSocket Adapter',
    version: '1.0.0',
    description: 'JSON-RPC 2.0 over WebSocket. Supports TUI and external clients.',
    providerType: 'communication',
  };

  private wss: WebSocketServer | null = null;
  private inboundHandler: InboundHandler | undefined;
  private clients: Set<WebSocket> = new Set();
  private handshaked: Set<WebSocket> = new Set();
  private handshakeTimeouts: Map<WebSocket, ReturnType<typeof setTimeout>> = new Map();
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

  isReady(): boolean {
    return this.wss !== null;
  }

  onInbound(handler: InboundHandler): void {
    this.inboundHandler = handler;
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
        logger.info({ clientCount: this.clients.size }, 'WS client connected');

        const timeout = setTimeout(() => {
          if (!this.handshaked.has(socket)) {
            logger.warn('WS client failed to handshake within timeout, closing');
            socket.close(4000, 'Handshake timeout');
          }
        }, HANDSHAKE_TIMEOUT_MS);
        this.handshakeTimeouts.set(socket, timeout);

        socket.on('message', async (data) => {
          const text = data.toString();

          if (!this.handshaked.has(socket)) {
            this.handlePreHandshake(socket, text);
            return;
          }

          const response = await this.rpc.receiveJSON(text);
          if (response !== null) {
            socket.send(JSON.stringify(response));
          }
        });

        socket.on('close', () => {
          this.cleanupSocket(socket);
          logger.info({ clientCount: this.clients.size }, 'WS client disconnected');
        });

        socket.on('error', (err) => {
          logger.error({ err }, 'WS client error');
          this.cleanupSocket(socket);
        });
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const timeout of this.handshakeTimeouts.values()) {
        clearTimeout(timeout);
      }
      this.handshakeTimeouts.clear();
      this.handshaked.clear();

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
      if (!this.handshaked.has(client)) continue;
      try {
        client.send(notification, (err) => {
          if (err) {
            logger.error({ err, method }, 'WS notification send error');
            this.clients.delete(client);
            this.handshaked.delete(client);
          }
        });
      } catch (err) {
        logger.error({ err, method }, 'WS notification failed');
        this.clients.delete(client);
        this.handshaked.delete(client);
      }
    }
  }

  private handlePreHandshake(socket: WebSocket, text: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(text);
    } catch {
      socket.close(4002, 'Invalid JSON');
      return;
    }

    if (parsed.method === 'handshake') {
      const params = (parsed.params ?? {}) as Record<string, unknown>;
      const clientVersion = params.protocolVersion;

      if (clientVersion !== PROTOCOL_VERSION) {
        const error = {
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: `Protocol version mismatch: server=${PROTOCOL_VERSION}, client=${clientVersion}. Update your client.`,
          },
          id: parsed.id ?? null,
        };
        socket.send(JSON.stringify(error), () => {
          socket.close(4001, 'Protocol version mismatch');
        });
        return;
      }

      this.handshaked.add(socket);
      const hsTimeout = this.handshakeTimeouts.get(socket);
      if (hsTimeout) {
        clearTimeout(hsTimeout);
        this.handshakeTimeouts.delete(socket);
      }

      logger.info(
        { clientName: params.clientName, clientVersion: params.clientVersion },
        'WS client handshake complete',
      );

      const response = {
        jsonrpc: '2.0',
        result: {
          protocolVersion: PROTOCOL_VERSION,
          harnessVersion: HARNESS_VERSION,
        },
        id: parsed.id ?? null,
      };
      socket.send(JSON.stringify(response));
      return;
    }

    // Non-handshake call before handshake — reject
    const error = {
      jsonrpc: '2.0',
      error: {
        code: -32600,
        message: 'Handshake required',
      },
      id: parsed.id ?? null,
    };
    socket.send(JSON.stringify(error));
  }

  private cleanupSocket(socket: WebSocket): void {
    this.clients.delete(socket);
    this.handshaked.delete(socket);
    const timeout = this.handshakeTimeouts.get(socket);
    if (timeout) {
      clearTimeout(timeout);
      this.handshakeTimeouts.delete(socket);
    }
  }
}
