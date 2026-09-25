import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const source = readFileSync(new URL('../src/chunker.js', import.meta.url), 'utf8');

// Runs the chunker the way the content script does: as a plain script
// against a page, reading the global it leaves behind. Arrays it returns
// belong to the page's realm, so they're copied before deep comparison.
function load(html) {
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  dom.window.eval(source);
  return { document: dom.window.document, ...dom.window.SpecFocus };
}

function chunksOf(markdownHtml) {
  const { document, buildChunks } = load(`<article class="markdown-body">${markdownHtml}</article>`);
  return [...buildChunks(document.querySelector('.markdown-body'))].map((chunk) => ({
    text: [...chunk.nodes].map((node) => node.textContent.trim()),
    trail: [...chunk.trail],
    change: chunk.change,
  }));
}

test('each paragraph, list, code block, table and quote is its own chunk', () => {
  const chunks = chunksOf(`
    <p>One.</p>
    <ul><li>Two</li></ul>
    <div class="highlight"><pre>three()</pre></div>
    <table><tr><td>Four</td></tr></table>
    <blockquote><p>Five.</p><p>Still five.</p></blockquote>
  `);
  assert.deepEqual(
    chunks.map((c) => c.text),
    [['One.'], ['Two'], ['three()'], ['Four'], ['Five.Still five.']],
  );
});

test('a heading joins the block after it, and stacked headings stay together', () => {
  const chunks = chunksOf(`
    <h2>Goals</h2>
    <p>Ship it.</p>
    <p>Then rest.</p>
    <h2>Tools</h2>
    <h3>Shell</h3>
    <p>Allowed.</p>
  `);
  assert.deepEqual(
    chunks.map((c) => c.text),
    [['Goals', 'Ship it.'], ['Then rest.'], ['Tools', 'Shell', 'Allowed.']],
  );
});

test('a short lead-in ending in a colon joins the block it introduces', () => {
  const chunks = chunksOf(`
    <p>The agent must:</p>
    <ol><li>Read the spec</li></ol>
    <p>${'A long paragraph that happens to end with a colon. '.repeat(5)}:</p>
    <ul><li>Separate</li></ul>
  `);
  assert.deepEqual(
    chunks.map((c) => c.text.length),
    [2, 1, 1],
  );
});

test('a lead-in with nothing after it before the next heading stands alone', () => {
  const chunks = chunksOf(`
    <p>Examples:</p>
    <h2>Next</h2>
    <p>Body.</p>
  `);
  assert.deepEqual(
    chunks.map((c) => c.text),
    [['Examples:'], ['Next', 'Body.']],
  );
});

test('the trail follows the heading hierarchy', () => {
  const chunks = chunksOf(`
    <h1>Spec</h1><p>Intro.</p>
    <h2>Tools</h2><p>a</p>
    <h3>Shell</h3><p>b</p>
    <h3>Browser</h3><p>c</p>
    <h2>Limits</h2><p>d</p>
  `);
  assert.deepEqual(
    chunks.map((c) => c.trail),
    [['Spec'], ['Spec', 'Tools'], ['Spec', 'Tools', 'Shell'], ['Spec', 'Tools', 'Browser'], ['Spec', 'Limits']],
  );
});

test("GitHub's heading, alert and render wrappers are kept whole", () => {
  const chunks = chunksOf(`
    <div class="markdown-heading"><h2 class="heading-element">Setup</h2><a class="anchor" href="#setup"><svg></svg></a></div>
    <div class="markdown-alert markdown-alert-note"><p>Note</p><p>Careful.</p></div>
    <section class="js-render-needs-enrichment"><div><p>graph TD</p></div></section>
  `);
  assert.deepEqual(
    chunks.map((c) => c.text),
    [['Setup', 'NoteCareful.'], ['graph TD']],
  );
});

test('plain wrapper divs are looked inside; rules and empty blocks are skipped', () => {
  const chunks = chunksOf(`
    <div><p>Inside.</p><p>Also inside.</p></div>
    <hr>
    <p> </p>
    <p><img src="diagram.png" alt=""></p>
  `);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks.at(-1).text, ['']);
});

test('rich diffs: ins/del wrappers are looked inside and each chunk knows what changed', () => {
  const chunks = chunksOf(`
    <div class="expandable unchanged js-expandable">
      <svg class="octicon octicon-unfold"></svg>
      <h2 class="heading-element unchanged">Tools</h2><a class="anchor" href="#tools"><svg class="octicon"></svg></a>
      <p class="unchanged">Shell is allowed.</p>
    </div>
    <ins><h2 class="heading-element">Limits</h2></ins>
    <ins><a class="anchor" href="#limits"><svg class="octicon"></svg></a></ins>
    <ins><p>No network.</p></ins>
    <del><p>Network is fine.</p></del>
    <p class="changed">Timeout is <del>30s</del><ins>60s</ins>.</p>
  `);
  assert.deepEqual(chunks, [
    { text: ['Tools', 'Shell is allowed.'], trail: ['Tools'], change: null },
    { text: ['Limits', 'No network.'], trail: ['Limits'], change: 'added' },
    { text: ['Network is fine.'], trail: ['Limits'], change: 'removed' },
    { text: ['Timeout is 30s60s.'], trail: ['Limits'], change: 'changed' },
  ]);
});

test('only outermost markdown bodies with content are found', () => {
  const { document, findMarkdownBodies } = load(`
    <div class="markdown-body" id="outer"><div class="markdown-body"><p>Nested</p></div></div>
    <div class="markdown-body" id="empty"> </div>
    <div class="markdown-body" id="second"><p>Second</p></div>
    <div id="spec-focus-root"><div class="markdown-body"><p>Our own copy</p></div></div>
  `);
  assert.deepEqual(
    [...findMarkdownBodies(document)].map((el) => el.id),
    ['outer', 'second'],
  );
});
