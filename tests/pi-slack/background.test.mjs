import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

async function loadBackgroundExports() {
  const sourcePath = path.resolve('chrome-extensions/pi-slack/background.js');
  const source = await readFile(sourcePath, 'utf8');
  const instrumented = `${source}\n;globalThis.__testExports = {\n  extractEmbeddedPairingCode,\n  parsePairingCode,\n  parseSlackContextFromUrl,\n  describeObservedSlackContext,\n  buildObservedThreadApprovalContext,\n  policyMatchesObservedContext,\n  summarizeChannelRangeScope,\n  classifyApprovalRequest,\n  normalizeSlackTs,\n  parseSlackMessageLink,\n  shouldClearPairingOnClose,\n};`;

  const noop = () => {};
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    crypto: globalThis.crypto,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    structuredClone,
    chrome: {
      runtime: {
        onInstalled: { addListener: noop },
        onStartup: { addListener: noop },
        onMessage: { addListener: noop },
        getManifest: () => ({ version: 'test' }),
        getURL: (value) => value,
      },
      storage: {
        session: { get: async () => ({}), set: async () => {}, remove: async () => {} },
        onChanged: { addListener: noop },
      },
      alarms: {
        onAlarm: { addListener: noop },
        create: noop,
        clear: async () => true,
      },
      windows: {
        onRemoved: { addListener: noop },
        update: async () => ({}),
        create: async () => ({ id: 1 }),
      },
      tabs: {
        query: async () => [],
        remove: async () => {},
        update: async () => ({}),
        get: async () => ({ id: 1, status: 'complete' }),
        sendMessage: async () => ({}),
        onUpdated: { addListener: noop, removeListener: noop },
      },
      action: {
        setBadgeBackgroundColor: async () => {},
        setBadgeText: async () => {},
        setTitle: async () => {},
        setIcon: async () => {},
      },
      scripting: {
        executeScript: async () => {},
      },
    },
    WebSocket: { OPEN: 1 },
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(instrumented, sandbox, { filename: sourcePath });
  return sandbox.__testExports;
}

const background = await loadBackgroundExports();

test('parseSlackContextFromUrl extracts workspace, channel, and thread context', () => {
  const context = background.parseSlackContextFromUrl('https://app.slack.com/client/T123/C456?message_ts=1712345678.000100&thread_ts=1712345678.000100');
  assert.deepEqual(JSON.parse(JSON.stringify(context)), {
    url: 'https://app.slack.com/client/T123/C456?message_ts=1712345678.000100&thread_ts=1712345678.000100',
    host: 'app.slack.com',
    workspaceKey: 'T123',
    channelKey: 'C456',
    threadKey: '1712345678.000100',
  });
});

test('classifyApprovalRequest differentiates bounded and open-ended broad reads', () => {
  const bounded = background.classifyApprovalRequest({
    action: 'getChannelRange',
    payload: {
      startUrl: 'https://app.slack.com/client/T1/C1?message_ts=1712345678.000100',
      endUrl: 'https://app.slack.com/client/T1/C1?message_ts=1712345688.000200',
      limit: 10,
    },
  });
  assert.equal(bounded.risk, 'medium');
  assert.equal(bounded.scopeLabel, 'bounded channel range');

  const openEnded = background.classifyApprovalRequest({
    action: 'getChannelRangeAll',
    payload: {
      startUrl: 'https://app.slack.com/client/T1/C1?message_ts=1712345678.000100',
      maxMessages: 500,
      includeThreads: true,
    },
  });
  assert.equal(openEnded.risk, 'high');
  assert.equal(openEnded.scopeLabel, 'open-ended paginated summary + thread expansion');
});

test('policyMatchesObservedContext requires matching thread identity once known', () => {
  const policyContext = {
    type: 'thread',
    tabId: 7,
    url: 'https://app.slack.com/client/T1/C1',
    workspaceKey: 'T1',
    channelKey: 'C1',
    threadKey: '1712345678.000100',
    threadPermalink: 'https://app.slack.com/client/T1/C1?message_ts=1712345678.000100',
  };

  assert.equal(background.policyMatchesObservedContext({ context: policyContext }, {
    ...policyContext,
  }), true);

  assert.equal(background.policyMatchesObservedContext({ context: policyContext }, {
    ...policyContext,
    threadKey: '1712345678.000200',
    threadPermalink: 'https://app.slack.com/client/T1/C1?message_ts=1712345678.000200',
  }), false);
});

test('summarizeChannelRangeScope flags cross-context permalink spans', () => {
  const scope = background.summarizeChannelRangeScope(
    'https://app.slack.com/client/T1/C1?message_ts=1712345678.000100',
    'https://app.slack.com/client/T2/C9?message_ts=1712345699.000300',
  );
  assert.equal(scope.crossesContext, true);
  assert.equal(scope.startLocation, 'C1 in T1');
  assert.equal(scope.endLocation, 'C9 in T2');
});

test('normalizeSlackTs and parseSlackMessageLink handle Slack permalink variants', () => {
  assert.equal(background.normalizeSlackTs('1712345678000100'), '1712345678.000100');
  assert.equal(background.normalizeSlackTs('1712345678.000100'), '1712345678.000100');

  const parsed = background.parseSlackMessageLink('https://example.slack.com/archives/C123/p1712345678000100?thread_ts=1712345678.000100');
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), {
    workspaceHost: 'example.slack.com',
    channelId: 'C123',
    messageTs: '1712345678.000100',
    threadTs: '1712345678.000100',
  });
});

test('parsePairingCode accepts a full copied pairing card and extracts the embedded code', () => {
  const pairing = {
    version: 1,
    host: '127.0.0.1',
    port: 27183,
    sessionId: 'session-123',
    secret: 'secret-abc',
  };
  const code = `pi-slack-pair:${Buffer.from(JSON.stringify(pairing), 'utf8').toString('base64url')}`;
  const pastedCard = [
    'slack-pair',
    'Current Pi Slack pairing code:',
    '',
    'Keep this code confidential until it is rotated or the Pi Slack session exits.',
    '',
    'Pairing code:',
    code,
    '',
    'Endpoint: ws://127.0.0.1:27183',
    'Session: session-123',
  ].join('\n');

  assert.deepEqual(JSON.parse(JSON.stringify(background.parsePairingCode(pastedCard))), pairing);
});

test('parsePairingCode accepts wrapped pairing code with embedded newlines', () => {
  const pairing = {
    version: 1,
    host: '127.0.0.1',
    port: 27183,
    sessionId: 'session-456',
    secret: 'secret-def',
  };
  const code = `pi-slack-pair:${Buffer.from(JSON.stringify(pairing), 'utf8').toString('base64url')}`;
  const wrapped = `${code.slice(0, 40)}\n${code.slice(40, 95)}\n${code.slice(95)}`;

  assert.equal(background.extractEmbeddedPairingCode(wrapped), code);
  assert.deepEqual(JSON.parse(JSON.stringify(background.parsePairingCode(wrapped))), pairing);
});

test('shouldClearPairingOnClose only clears stale or rotated pairing failures', () => {
  assert.equal(background.shouldClearPairingOnClose({ code: 1008, reason: 'Pairing rotated' }), true);
  assert.equal(background.shouldClearPairingOnClose({ code: 1008, reason: 'Session mismatch' }), true);
  assert.equal(background.shouldClearPairingOnClose({ code: 1000, reason: 'normal close' }), false);
  assert.equal(background.shouldClearPairingOnClose({ code: 1008, reason: 'other policy violation' }), false);
});
