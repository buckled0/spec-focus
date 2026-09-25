// Splits a rendered GitHub markdown body into reading chunks: one paragraph,
// list, table, code block, quote or alert each. Headings ride along with the
// block that follows them, and a short lead-in ending in a colon ("The agent
// must:") joins the block it introduces, so no chunk is ever just a label.
//
// Also understands GitHub's rich diff of a markdown file in a PR: added and
// removed blocks arrive wrapped in <ins>/<del>, and each chunk records whether
// it was added, removed or changed.
(function (root) {
  const LEAD_IN_MAX_LENGTH = 200;

  // Wrappers GitHub renders around one logical block. Never split these.
  const ATOMIC_CLASSES = ['markdown-heading', 'highlight', 'snippet-clipboard-content', 'markdown-alert'];
  const CONTAINER_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'MAIN', 'INS', 'DEL']);
  // Heading permalinks and the rich diff's "expand" icons: chrome, not content.
  const SKIP_CLASSES = ['anchor', 'octicon'];
  const SKIP_TAGS = new Set(['HR', 'SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);
  const BLOCK_TAGS = new Set([
    'P',
    'UL',
    'OL',
    'DL',
    'PRE',
    'TABLE',
    'BLOCKQUOTE',
    'DETAILS',
    'FIGURE',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'DIV',
    'SECTION',
    'INS',
    'DEL',
  ]);
  const MEDIA = 'img, svg, iframe, video, canvas, picture, math';

  function isAtomic(el) {
    // Mermaid, GeoJSON and other rich renders live in js-render-* wrappers.
    return [...el.classList].some((c) => ATOMIC_CLASSES.includes(c) || c.startsWith('js-render'));
  }

  function headingOf(el) {
    if (/^H[1-6]$/.test(el.tagName)) return el;
    if (el.classList.contains('markdown-heading')) return el.querySelector('h1, h2, h3, h4, h5, h6');
    return null;
  }

  function isEmpty(el) {
    const media = [el, ...el.querySelectorAll(MEDIA)].filter((m) => m.matches(MEDIA));
    return el.textContent.trim() === '' && media.every((m) => m.closest('.anchor, .octicon'));
  }

  function isWrapper(el) {
    return (
      CONTAINER_TAGS.has(el.tagName) &&
      !isAtomic(el) &&
      !headingOf(el) &&
      [...el.children].some((child) => BLOCK_TAGS.has(child.tagName))
    );
  }

  function isLeadIn(el) {
    if (el.tagName !== 'P') return false;
    const text = el.textContent.trim();
    return text.length <= LEAD_IN_MAX_LENGTH && text.endsWith(':');
  }

  function isSkipped(el) {
    return SKIP_TAGS.has(el.tagName) || SKIP_CLASSES.some((c) => el.classList.contains(c));
  }

  function changeOf(el, body) {
    const wrapper = el.closest('ins, del');
    if (wrapper && body.contains(wrapper)) return wrapper.tagName === 'INS' ? 'added' : 'removed';
    if (el.classList.contains('added')) return 'added';
    if (el.classList.contains('removed')) return 'removed';
    if (el.classList.contains('changed') || el.querySelector('ins, del')) return 'changed';
    return null;
  }

  function* blocks(el) {
    for (const child of el.children) {
      if (isSkipped(child)) continue;
      if (isWrapper(child)) yield* blocks(child);
      else if (!isEmpty(child)) yield child;
    }
  }

  /**
   * @param {Element} body a rendered `.markdown-body`
   * @returns {{ nodes: Element[], trail: string[], change: 'added' | 'removed' | 'changed' | null }[]}
   *   chunks in reading order; `trail` is the heading path the chunk sits
   *   under and `change` is set when reading a rich diff.
   */
  function buildChunks(body) {
    const chunks = [];
    const trail = [];
    let pending = [];

    const flush = () => {
      if (!pending.length) return;
      const change = pending.map((node) => changeOf(node, body)).find(Boolean) ?? null;
      chunks.push({ nodes: pending, trail: trail.map((h) => h.text), change });
      pending = [];
    };

    for (const el of blocks(body)) {
      const heading = headingOf(el);
      if (heading) {
        // A dangling lead-in shouldn't swallow the next section's heading.
        if (pending.some((node) => !headingOf(node))) flush();
        const level = Number(heading.tagName[1]);
        while (trail.length && trail[trail.length - 1].level >= level) trail.pop();
        trail.push({ level, text: heading.textContent.trim() });
        pending.push(el);
        continue;
      }
      pending.push(el);
      if (!isLeadIn(el)) flush();
    }
    flush();
    return chunks;
  }

  /** Top-level rendered markdown bodies on the page, in document order. */
  function findMarkdownBodies(doc) {
    return [...doc.querySelectorAll('.markdown-body')].filter(
      (el) =>
        !el.parentElement?.closest('.markdown-body') && !el.closest('#spec-focus-root') && el.textContent.trim() !== '',
    );
  }

  root.SpecFocus = { buildChunks, findMarkdownBodies };
})(globalThis);
