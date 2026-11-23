import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateStandaloneHtml } from '../src/utils/cliExporter';
import { PREBUILT_TEMPLATES } from '../src/templates/prebuiltTemplates';

// The standalone player embeds its own script; make sure our lifecycle changes
// keep that inline script syntactically valid.
test('standalone player inline script parses', () => {
  const html = generateStandaloneHtml(PREBUILT_TEMPLATES[0]);
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length > 0, 'expected an inline player script');
  for (const code of scripts) {
    assert.doesNotThrow(() => new Function(code));
  }
  assert.ok(html.includes('narrationEpoch'), 'standalone player keeps the narration epoch guard');
  assert.ok(html.includes('speakFromTime'), 'standalone player seeks narration from the current time');
  assert.ok(!html.includes('${project'), 'no unresolved template placeholders');
});
