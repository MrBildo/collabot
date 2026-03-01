import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CommunicationRegistry } from './registry.js';
import type {
  CommunicationProvider,
  ChannelMessage,
  PluginManifest,
  InboundHandler,
} from './comms.js';

// ── Test helpers ────────────────────────────────────────────────

function makeManifest(name: string): PluginManifest {
  return {
    id: `collabot.communication.${name}`,
    name: `${name} provider`,
    version: '1.0.0',
    description: `Test ${name} provider`,
    providerType: 'communication',
  };
}

function makeMsg(overrides?: Partial<ChannelMessage>): ChannelMessage {
  return {
    id: 'msg-1',
    channelId: 'ch-1',
    from: 'harness',
    timestamp: new Date(),
    type: 'lifecycle',
    content: 'test message',
    ...overrides,
  };
}

type Call = { method: string; args?: unknown[] };

function makeMockProvider(
  name: string,
  opts?: {
    ready?: boolean;
    acceptedTypes?: ReadonlySet<ChannelMessage['type']>;
    startFails?: boolean;
    stopFails?: boolean;
  },
): CommunicationProvider & { calls: Call[] } {
  const calls: Call[] = [];
  const ready = opts?.ready ?? true;
  let started = false;

  return {
    name,
    manifest: makeManifest(name),
    acceptedTypes: opts?.acceptedTypes,
    calls,

    async start(): Promise<void> {
      calls.push({ method: 'start' });
      if (opts?.startFails) throw new Error(`${name} start failed`);
      started = true;
    },

    async stop(): Promise<void> {
      calls.push({ method: 'stop' });
      if (opts?.stopFails) throw new Error(`${name} stop failed`);
      started = false;
    },

    isReady(): boolean {
      return ready && started;
    },

    async send(msg: ChannelMessage): Promise<void> {
      calls.push({ method: 'send', args: [msg] });
    },

    async setStatus(channelId: string, status: string): Promise<void> {
      calls.push({ method: 'setStatus', args: [channelId, status] });
    },

    onInbound(_handler: InboundHandler): void {
      calls.push({ method: 'onInbound' });
    },
  };
}

// Override isReady to always return a fixed value regardless of start state
function makeMockProviderAlwaysReady(
  name: string,
  opts?: {
    acceptedTypes?: ReadonlySet<ChannelMessage['type']>;
  },
): CommunicationProvider & { calls: Call[] } {
  const provider = makeMockProvider(name, { ready: true, ...opts });
  // Override isReady to always return true (for broadcast tests that don't call start)
  (provider as { isReady: () => boolean }).isReady = () => true;
  return provider;
}

function makeMockProviderNeverReady(
  name: string,
): CommunicationProvider & { calls: Call[] } {
  const provider = makeMockProvider(name);
  (provider as { isReady: () => boolean }).isReady = () => false;
  return provider;
}

// ── Tests ───────────────────────────────────────────────────────

let registry: CommunicationRegistry;

beforeEach(() => {
  registry = new CommunicationRegistry();
});

describe('registration and lookup', () => {
  test('register and get a provider', () => {
    const provider = makeMockProvider('cli');
    registry.register(provider);

    assert.strictEqual(registry.get('cli'), provider);
    assert.strictEqual(registry.has('cli'), true);
    assert.strictEqual(registry.has('ws'), false);
  });

  test('get returns undefined for unregistered name', () => {
    assert.strictEqual(registry.get('nonexistent'), undefined);
  });

  test('providers returns all registered in order', () => {
    const a = makeMockProvider('a');
    const b = makeMockProvider('b');
    const c = makeMockProvider('c');
    registry.register(a);
    registry.register(b);
    registry.register(c);

    const all = registry.providers();
    assert.strictEqual(all.length, 3);
    assert.strictEqual(all[0], a);
    assert.strictEqual(all[1], b);
    assert.strictEqual(all[2], c);
  });

  test('duplicate name throws', () => {
    registry.register(makeMockProvider('cli'));
    assert.throws(
      () => registry.register(makeMockProvider('cli')),
      /already registered/,
    );
  });
});

describe('startAll', () => {
  test('starts all providers', async () => {
    const a = makeMockProvider('a');
    const b = makeMockProvider('b');
    registry.register(a);
    registry.register(b);

    await registry.startAll();

    assert.deepStrictEqual(a.calls, [{ method: 'start' }]);
    assert.deepStrictEqual(b.calls, [{ method: 'start' }]);
  });

  test('best-effort — one fails, others still start', async () => {
    const good = makeMockProvider('good');
    const bad = makeMockProvider('bad', { startFails: true });
    const alsoGood = makeMockProvider('also-good');
    registry.register(good);
    registry.register(bad);
    registry.register(alsoGood);

    await registry.startAll(); // should not throw

    assert.strictEqual(good.calls.filter((c) => c.method === 'start').length, 1);
    assert.strictEqual(bad.calls.filter((c) => c.method === 'start').length, 1);
    assert.strictEqual(alsoGood.calls.filter((c) => c.method === 'start').length, 1);
  });
});

describe('stopAll', () => {
  test('stops in reverse registration order', async () => {
    const order: string[] = [];
    const a = makeMockProvider('a');
    const b = makeMockProvider('b');
    const c = makeMockProvider('c');

    // Patch stop to record order
    a.stop = async () => { order.push('a'); };
    b.stop = async () => { order.push('b'); };
    c.stop = async () => { order.push('c'); };

    registry.register(a);
    registry.register(b);
    registry.register(c);

    await registry.stopAll();

    assert.deepStrictEqual(order, ['c', 'b', 'a']);
  });

  test('logs errors but never throws', async () => {
    const good = makeMockProvider('good');
    const bad = makeMockProvider('bad', { stopFails: true });
    registry.register(good);
    registry.register(bad);

    await registry.startAll();

    // Should not throw even though 'bad' stop fails
    await registry.stopAll();
  });
});

describe('broadcast', () => {
  test('sends to all ready providers', async () => {
    const a = makeMockProviderAlwaysReady('a');
    const b = makeMockProviderAlwaysReady('b');
    registry.register(a);
    registry.register(b);

    const msg = makeMsg();
    await registry.broadcast(msg);

    assert.strictEqual(a.calls.filter((c) => c.method === 'send').length, 1);
    assert.strictEqual(b.calls.filter((c) => c.method === 'send').length, 1);
  });

  test('skips providers that are not ready', async () => {
    const ready = makeMockProviderAlwaysReady('ready');
    const notReady = makeMockProviderNeverReady('not-ready');
    registry.register(ready);
    registry.register(notReady);

    await registry.broadcast(makeMsg());

    assert.strictEqual(ready.calls.filter((c) => c.method === 'send').length, 1);
    assert.strictEqual(notReady.calls.filter((c) => c.method === 'send').length, 0);
  });

  test('respects acceptedTypes via filteredSend', async () => {
    const full = makeMockProviderAlwaysReady('full');
    const minimal = makeMockProviderAlwaysReady('minimal', {
      acceptedTypes: new Set(['lifecycle', 'result']),
    });
    registry.register(full);
    registry.register(minimal);

    // lifecycle — both should receive
    await registry.broadcast(makeMsg({ type: 'lifecycle' }));
    assert.strictEqual(full.calls.filter((c) => c.method === 'send').length, 1);
    assert.strictEqual(minimal.calls.filter((c) => c.method === 'send').length, 1);

    // thinking — only full should receive
    await registry.broadcast(makeMsg({ type: 'thinking' }));
    assert.strictEqual(full.calls.filter((c) => c.method === 'send').length, 2);
    assert.strictEqual(minimal.calls.filter((c) => c.method === 'send').length, 1); // still 1
  });
});

describe('broadcastStatus', () => {
  test('calls setStatus on all ready providers', async () => {
    const a = makeMockProviderAlwaysReady('a');
    const b = makeMockProviderAlwaysReady('b');
    registry.register(a);
    registry.register(b);

    await registry.broadcastStatus('ch-1', 'working');

    const aStatus = a.calls.filter((c) => c.method === 'setStatus');
    const bStatus = b.calls.filter((c) => c.method === 'setStatus');
    assert.strictEqual(aStatus.length, 1);
    assert.strictEqual(bStatus.length, 1);
    assert.deepStrictEqual(aStatus[0].args, ['ch-1', 'working']);
  });

  test('skips providers that are not ready', async () => {
    const ready = makeMockProviderAlwaysReady('ready');
    const notReady = makeMockProviderNeverReady('not-ready');
    registry.register(ready);
    registry.register(notReady);

    await registry.broadcastStatus('ch-1', 'completed');

    assert.strictEqual(ready.calls.filter((c) => c.method === 'setStatus').length, 1);
    assert.strictEqual(notReady.calls.filter((c) => c.method === 'setStatus').length, 0);
  });
});
