// Maps rendered markdown back to lines of the file's source, so a chunk read
// in a PR's rich diff can take a line comment. GitHub's rich diff carries no
// line numbers, so this aligns the chunk's words against the PR's patch.
(function (root) {
  const MATCH = 2;
  const MISS = -1;
  // Text that's in the source but never rendered: link targets and HTML tags.
  const HIDDEN_SOURCE = [/\]\([^)\s]*(?:\s+"[^"]*")?\)/g, /<\/?[a-z][^>]*>/gi];
  const HIDDEN_RENDERED = '.anchor, .octicon, svg, script, style, template';
  const TEXT_BLOCKS = 'p, li, dt, dd, th, td, pre, blockquote, h1, h2, h3, h4, h5, h6, div';

  /**
   * @param {string} patch a unified diff hunk list, as the GitHub API returns it
   * @returns {{ type: 'context' | 'add' | 'del', left: number | null, right: number | null, text: string, hunk: number }[]}
   */
  function parsePatch(patch) {
    const rows = [];
    let left = 0;
    let right = 0;
    let hunk = -1;
    for (const line of patch.split('\n')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (header) {
        left = Number(header[1]);
        right = Number(header[2]);
        hunk++;
      } else if (hunk < 0 || line.startsWith('\\')) {
        continue;
      } else if (line.startsWith('+')) {
        rows.push({ type: 'add', left: null, right: right++, text: line.slice(1), hunk });
      } else if (line.startsWith('-')) {
        rows.push({ type: 'del', left: left++, right: null, text: line.slice(1), hunk });
      } else {
        rows.push({ type: 'context', left: left++, right: right++, text: line.slice(1), hunk });
      }
    }
    return rows;
  }

  function words(text) {
    return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  }

  function sourceWords(line) {
    return words(HIDDEN_SOURCE.reduce((text, pattern) => text.replace(pattern, ']'), line));
  }

  /**
   * Text of rendered nodes as one side of the diff shows it: the new file
   * (`RIGHT`) drops what was deleted, the old file (`LEFT`) drops what was
   * inserted. Separate blocks (list items, table cells) are spaced apart so
   * their words never run together.
   */
  function renderedText(nodes, side) {
    const drop = side === 'LEFT' ? 'ins' : 'del';
    let text = '';
    for (const node of nodes) {
      const copy = node.cloneNode(true);
      copy.querySelectorAll(`${drop}, ${HIDDEN_RENDERED}`).forEach((el) => el.remove());
      const walker = copy.ownerDocument.createTreeWalker(copy, 4 /* NodeFilter.SHOW_TEXT */);
      let block = null;
      while (walker.nextNode()) {
        const next = walker.currentNode.parentElement?.closest(TEXT_BLOCKS) ?? copy;
        text += (next === block ? '' : ' ') + walker.currentNode.nodeValue;
        block = next;
      }
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Finds the lines on one side of a patch that best match some rendered
   * text, via local alignment of their words. A match never crosses hunks,
   * since GitHub only takes a multi-line comment within one.
   *
   * @param {ReturnType<typeof parsePatch>} rows
   * @param {string} text rendered text to look for
   * @param {'LEFT' | 'RIGHT'} side
   * @returns {{ side: 'LEFT' | 'RIGHT', start: number, end: number, rows: ReturnType<typeof parsePatch> } | null}
   */
  function locateLines(rows, text, side) {
    const target = words(text);
    if (!target.length) return null;
    const key = side === 'LEFT' ? 'left' : 'right';
    const onSide = rows.filter((row) => row[key] !== null);

    let best = null;
    for (const hunk of new Set(onSide.map((row) => row.hunk))) {
      const hunkRows = onSide.filter((row) => row.hunk === hunk);
      const stream = hunkRows.flatMap((row, index) => sourceWords(row.text).map((word) => ({ word, index })));
      const found = align(
        stream.map((s) => s.word),
        target,
      );
      if (found && (!best || found.score > best.score)) {
        best = { score: found.score, rows: hunkRows.slice(stream[found.start].index, stream[found.end].index + 1) };
      }
    }

    // Most of the text has to be there, or it's a coincidence of common words.
    const needed = Math.min(MATCH * target.length, Math.max(4, target.length));
    if (!best || best.score < needed) return null;
    return { side, start: best.rows[0][key], end: best.rows.at(-1)[key], rows: best.rows };
  }

  // Smith–Waterman over words: the best-scoring stretch of `stream` that lines
  // up with a stretch of `target`, allowing for words only one side has.
  function align(stream, target) {
    let prevScore = new Array(target.length + 1).fill(0);
    let prevStart = new Array(target.length + 1).fill(0);
    let best = null;
    for (let i = 0; i < stream.length; i++) {
      const score = [0];
      const start = [i];
      for (let j = 1; j <= target.length; j++) {
        const options = [
          [
            prevScore[j - 1] + (stream[i] === target[j - 1] ? MATCH : MISS),
            prevScore[j - 1] > 0 ? prevStart[j - 1] : i,
          ],
          [prevScore[j] + MISS, prevStart[j]],
          [score[j - 1] + MISS, start[j - 1]],
        ];
        const [s, from] = options.reduce((a, b) => (b[0] > a[0] ? b : a), [0, i + 1]);
        score.push(s);
        start.push(from);
        if (s > 0 && (!best || s > best.score)) best = { score: s, start: from, end: i };
      }
      prevScore = score;
      prevStart = start;
    }
    return best;
  }

  root.SpecFocusLines = { parsePatch, renderedText, locateLines };
})(globalThis);
