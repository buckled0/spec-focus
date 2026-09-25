import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../src/lines.js', import.meta.url), 'utf8');

function load(html = '') {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.eval(source);
  return { document: dom.window.document, ...dom.window.SpecFocusLines };
}

// From github/spec-kit#4739, docs/guides/monorepo.md.
const PATCH = `@@ -78,8 +78,14 @@ ERROR: SPECIFY_INIT_DIR is not a Spec Kit project
 \`\`\`

 \`SPECIFY_INIT_DIR\` selects the **project**; \`SPECIFY_FEATURE_DIRECTORY\` selects
-the **feature** within it. They compose: set both to pick a project and a
-feature non-interactively. See the
+the **feature**. A relative feature path is joined to that project root
+without a containment check, so a value like \`../shared-feature\` still
+resolves outside it; an absolute path is used as-is and may likewise point
+outside the project root. Either way, the selected feature directory is not
+required to live inside it — the project root identifies the Spec Kit project
+and its command/configuration context, not a containment boundary for feature
+documents. They compose: set both to pick a project and a feature
+non-interactively. See the
 [\`SPECIFY_INIT_DIR\` reference](../reference/core.md#environment-variables) for
 the full contract and the two-axes model.`;

// The same paragraph as GitHub's rich diff renders it.
const RICH_DIFF = `<article class="markdown-body">
  <del><p><code>SPECIFY_INIT_DIR</code> selects the <strong>project</strong>; <code>SPECIFY_FEATURE_DIRECTORY</code> selects the <strong>feature</strong> within it. They compose: set both to pick a project and a feature non-interactively. See the <a href="#"><code>SPECIFY_INIT_DIR</code> reference</a> for the full contract and the two-axes model.</p></del>
  <ins><p><code>SPECIFY_INIT_DIR</code> selects the <strong>project</strong>; <code>SPECIFY_FEATURE_DIRECTORY</code> selects the <strong>feature</strong>. A relative feature path is joined to that project root without a containment check, so a value like <code>../shared-feature</code> still resolves outside it; an absolute path is used as-is and may likewise point outside the project root. Either way, the selected feature directory is not required to live inside it — the project root identifies the Spec Kit project and its command/configuration context, not a containment boundary for feature documents. They compose: set both to pick a project and a feature non-interactively. See the <a href="#"><code>SPECIFY_INIT_DIR</code> reference</a> for the full contract and the two-axes model.</p></ins>
  <p class="changed">Timeout is <del>30s</del><ins>60s</ins>.</p>
</article>`;

test('parsePatch numbers each side of every hunk', () => {
  const { parsePatch } = load();
  const rows = parsePatch('@@ -1,2 +1,2 @@\n a\n-b\n+B\n\\ No newline at end of file\n@@ -10 +10,2 @@\n c\n+d');
  assert.deepEqual(
    [...rows].map(({ type, left, right, hunk }) => [type, left, right, hunk]),
    [
      ['context', 1, 1, 0],
      ['del', 2, null, 0],
      ['add', null, 2, 0],
      ['context', 10, 10, 1],
      ['add', null, 11, 1],
    ],
  );
});

test('an added paragraph maps to its lines in the new file', () => {
  const { document, parsePatch, renderedText, locateLines } = load(RICH_DIFF);
  const text = renderedText([document.querySelector('ins p')], 'RIGHT');
  const found = locateLines(parsePatch(PATCH), text, 'RIGHT');
  assert.equal(found.side, 'RIGHT');
  assert.equal(found.start, 80);
  assert.equal(found.end, 90);
});

test('a removed paragraph maps to its lines in the old file', () => {
  const { document, parsePatch, renderedText, locateLines } = load(RICH_DIFF);
  const text = renderedText([document.querySelector('del p')], 'LEFT');
  const found = locateLines(parsePatch(PATCH), text, 'LEFT');
  assert.deepEqual([found.side, found.start, found.end], ['LEFT', 80, 84]);
});

test('selected text narrows the match to the lines it sits on', () => {
  const { parsePatch, locateLines } = load();
  const found = locateLines(parsePatch(PATCH), 'the selected feature directory is not required to live', 'RIGHT');
  assert.deepEqual([found.start, found.end], [84, 85]);
  assert.deepEqual(
    [...found.rows].map((row) => row.right),
    [84, 85],
  );
});

test('text that is not in the diff finds nothing', () => {
  const { parsePatch, locateLines } = load();
  assert.equal(locateLines(parsePatch(PATCH), 'Each member project has its own constitution', 'RIGHT'), null);
  assert.equal(locateLines(parsePatch(PATCH), '', 'RIGHT'), null);
});

test('renderedText keeps the side asked for and never runs blocks together', () => {
  const { document, renderedText } = load(`
    <p id="changed">Timeout is <del>30s</del><ins>60s</ins>.</p>
    <ul id="list"><li>One</li><li>Two <strong>and</strong> a half</li></ul>
    <h2 id="heading">Tools<a class="anchor"><svg class="octicon"></svg>link</a></h2>
  `);
  const text = (id, side) => renderedText([document.getElementById(id)], side);
  assert.equal(text('changed', 'RIGHT'), 'Timeout is 60s.');
  assert.equal(text('changed', 'LEFT'), 'Timeout is 30s.');
  assert.equal(text('list', 'RIGHT'), 'One Two and a half');
  assert.equal(
    renderedText([document.getElementById('heading'), document.getElementById('list')], 'RIGHT'),
    'Tools One Two and a half',
  );
});
