import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

async function loadContentScriptExports() {
  const sourcePath = path.resolve('chrome-extensions/pi-slack/content-script.js');
  const source = await readFile(sourcePath, 'utf8');
  const instrumented = source.replace(
    /}\s*else\s*\{/,
    '  globalThis.__testExports = { parseSlackTsFromUrl, countIdentityBackedMessages, countOutOfOrderMessageTs, evaluateThreadExtractionConfidence, evaluateChannelExtractionConfidence, buildExtractionWarnings };\n} else {',
  );

  class FakeElement {}
  class FakeHTMLElement extends FakeElement {}
  class FakeHTMLAnchorElement extends FakeHTMLElement {}

  const noop = () => {};
  const sandbox = {
    console: { debug: noop, warn: noop, error: noop, log: noop },
    URL,
    setTimeout,
    clearTimeout,
    HTMLElement: FakeHTMLElement,
    HTMLAnchorElement: FakeHTMLAnchorElement,
    Element: FakeElement,
    Node: FakeElement,
    chrome: {
      runtime: {
        onMessage: { addListener: noop },
      },
    },
    window: {
      location: { href: 'https://app.slack.com/client/T1/C1' },
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', overflowY: 'visible' }),
    },
    document: {
      title: 'Slack',
      visibilityState: 'hidden',
      querySelector: () => null,
      querySelectorAll: () => [],
      body: null,
    },
    globalThis: null,
  };
  sandbox.globalThis = sandbox;

  vm.runInNewContext(instrumented, sandbox, { filename: sourcePath });
  return sandbox.__testExports;
}

const contentScript = await loadContentScriptExports();

test('parseSlackTsFromUrl supports query-style and archive permalinks', () => {
  assert.equal(
    contentScript.parseSlackTsFromUrl('https://app.slack.com/client/T1/C1?message_ts=1712345678.000100'),
    '1712345678.000100',
  );
  assert.equal(
    contentScript.parseSlackTsFromUrl('https://example.slack.com/archives/C1/p1712345678000100'),
    '1712345678.000100',
  );
});

test('evaluateThreadExtractionConfidence rejects low-identity thread snapshots', () => {
  const messages = [
    { text: 'root without identity' },
    { text: 'reply one', author: 'alice' },
    { text: 'reply two', author: 'bob' },
    { text: 'reply three', author: 'carol' },
  ];
  const diagnostics = {
    finalMessageCount: 4,
    permalinkCount: 0,
    messageTsCount: 0,
  };

  const result = contentScript.evaluateThreadExtractionConfidence(messages, diagnostics);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'message_identity_ambiguous');
  assert.match(result.message, /confidence was too low/i);
});

test('evaluateThreadExtractionConfidence rejects out-of-order thread timestamps', () => {
  const messages = [
    { text: 'root', messageTs: '1712345678.000100', permalinkUrl: 'u1' },
    { text: 'reply', messageTs: '1712345677.000099', permalinkUrl: 'u2' },
    { text: 'reply two', messageTs: '1712345679.000200', permalinkUrl: 'u3' },
    { text: 'reply three', messageTs: '1712345680.000300', permalinkUrl: 'u4' },
  ];
  const diagnostics = {
    finalMessageCount: 4,
    permalinkCount: 4,
    messageTsCount: 4,
  };

  const result = contentScript.evaluateThreadExtractionConfidence(messages, diagnostics);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'message_order_ambiguous');
});

test('evaluateChannelExtractionConfidence rejects non-advancing pagination and ambiguous end boundaries', () => {
  const stalledPage = contentScript.evaluateChannelExtractionConfidence(
    [
      { text: 'm1', messageTs: '1712345678.000100', permalinkUrl: 'u1' },
      { text: 'm2', messageTs: '1712345678.000100', permalinkUrl: 'u2' },
      { text: 'm3', messageTs: '1712345679.000100', permalinkUrl: 'u3' },
      { text: 'm4', messageTs: '1712345680.000100', permalinkUrl: 'u4' },
    ],
    { reachedEndBoundary: true, hitLimit: false },
    { cursorTs: '1712345678.000100' },
  );
  assert.equal(stalledPage.ok, false);
  assert.equal(stalledPage.code, 'message_identity_ambiguous');
  assert.match(stalledPage.message, /did not advance beyond the requested pagination cursor/i);

  const ambiguousEnd = contentScript.evaluateChannelExtractionConfidence(
    [
      { text: 'm1', messageTs: '1712345678.000100', permalinkUrl: 'u1' },
      { text: 'm2', messageTs: '1712345679.000100', permalinkUrl: 'u2' },
      { text: 'm3', messageTs: '1712345680.000100', permalinkUrl: 'u3' },
      { text: 'm4', messageTs: '1712345681.000100', permalinkUrl: 'u4' },
    ],
    { reachedEndBoundary: false, hitLimit: false },
    { endTs: '1712345699.000900' },
  );
  assert.equal(ambiguousEnd.ok, false);
  assert.equal(ambiguousEnd.code, 'boundary_ambiguous');
});

test('buildExtractionWarnings surfaces identity coverage and order warnings', () => {
  const warnings = contentScript.buildExtractionWarnings({
    rootSelector: '',
    finalMessageCount: 4,
    permalinkCount: 2,
    messageTsCount: 2,
    identityMessageCount: 2,
    outOfOrderTsCount: 1,
    fallbackTextCount: 1,
    backfilledAuthorCount: 1,
    candidateRowCount: 4,
    filteredRowCount: 4,
  }, 'thread');

  assert.equal(warnings.some((warning) => /trusted permalink or Slack timestamp/i.test(warning)), true);
  assert.equal(warnings.some((warning) => /out of order/i.test(warning)), true);
});
