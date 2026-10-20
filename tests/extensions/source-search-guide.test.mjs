import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentGrepTool } from '../../extensions/agent-tools/search.ts';

const guide = new URL('../../skills/codemode/references/source-search.md', import.meta.url);
test('source-search examples find the positive control in literal and regex modes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-control-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const selected = join(root, 'source');
  await mkdir(selected);
  await mkdir(join(root, 'vendor'));
  await writeFile(join(selected, 'deployment.yaml'), 'endpoint: metrics.agent.datadoghq.com\n');
  await writeFile(join(root, 'vendor', 'unrelated.yaml'), 'outside the selected scope\n');
  const text = await readFile(guide, 'utf8');
  const examples = [...text.matchAll(/```json\n([^`]+)\n```/g)].map(match => JSON.parse(match[1]));
  assert.equal(examples.length, 2);
  const tool = createAgentGrepTool();
  const ctx = { cwd: root, sessionManager: { getSessionId: () => 'source-control', getSessionFile: () => undefined } };
  async function exists(input) {
    const result = await tool.execute('control', input, undefined, undefined, ctx);
    assert.equal(result.structuredContent.ok, true, JSON.stringify(result.structuredContent));
    return result.structuredContent.exists;
  }
  for (const input of examples) assert.equal(await exists({ ...input, path: selected }), true);
  assert.equal(await exists({ ...examples[1], path: selected, literal: true }), false,
    'regex backslashes must not be copied into a literal query');
  assert.match(text, /If the control fails, stop the absence claim/);
  assert.equal(await exists({ ...examples[0], path: join(root, 'vendor') }), false,
    'a negative result in another directory does not invalidate the selected-file control');
});
