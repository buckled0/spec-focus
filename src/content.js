// Focus mode: covers the GitHub page with a full-screen reader that shows one
// chunk of the spec at a time, with neighbouring chunks faded for context.
(() => {
  const { buildChunks, findMarkdownBodies } = globalThis.SpecFocus;
  const { renderedText, locateLines } = globalThis.SpecFocusLines;
  const { pullFileOf, hasToken, loadFile, addComment } = globalThis.SpecFocusGitHub;

  const DEFAULT_PREFS = { fontSize: 20, context: true, fullscreen: true, changesOnly: true };
  const FONT_SIZE_RANGE = [14, 32];
  const MAX_SAVED_POSITIONS = 200;
  const STICKY_HEADER_HEIGHT = 80;
  const RICH_DIFF_TIMEOUT = 10000;
  const CHANGE_LABELS = { added: 'Added', removed: 'Removed', changed: 'Changed' };
  const QUOTE_LENGTH = 280;
  const PREVIEW_LINES = 12;

  const HELP = [
    ['j  ↓  Space', 'Next chunk (scrolls long ones first)'],
    ['k  ↑  ⇧Space', 'Previous chunk'],
    ['n  N', 'Next / previous change (PR rich diffs)'],
    ['d', 'Only the changes, or the whole spec (PR rich diffs)'],
    ['m', 'Comment on this chunk, or just the selected text (PRs)'],
    ['⌘↵  ⇧⌘↵', 'Add the comment to your review / post it now'],
    ['g  G', 'First / last chunk'],
    ['c', 'Show or hide surrounding chunks'],
    ['+  −', 'Text size'],
    ['f', 'Full screen on or off'],
    ['Esc  q', 'Leave and jump to this spot on the page'],
  ];

  let session = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'toggle') session ? close() : open();
    sendResponse({});
  });

  async function open() {
    const body = pickBody(visible(findMarkdownBodies(document))) ?? (await showRichDiff());
    if (!body) {
      pageToast('No rendered markdown found on this page.');
      return;
    }
    document.querySelectorAll('.sf-page-toast').forEach((t) => t.remove());
    const bodies = findMarkdownBodies(document);
    const chunks = buildChunks(body);
    if (!chunks.length) {
      pageToast('This markdown is empty.');
      return;
    }

    const stored = await chrome.storage.local.get(['prefs', 'positions']);
    const prefs = { ...DEFAULT_PREFS, ...stored.prefs };
    const positions = stored.positions ?? {};
    const key = `${location.pathname}#${bodies.indexOf(body)}`;
    const saved = positions[key];
    const resumed = saved?.total === chunks.length && saved.index > 0 && saved.index < chunks.length;

    session = {
      chunks,
      prefs,
      positions,
      key,
      order: orderOf(chunks, prefs),
      index: 0,
      els: render(),
      fullscreen: false,
      file: pullFileOf(body, location),
      composer: null,
      drafts: new Map(),
      comments: new Map(),
      reviewComments: 0,
    };
    applyPrefs();
    document.documentElement.classList.add('sf-open');
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('turbo:visit', onNavigate);
    window.addEventListener('popstate', onNavigate);

    const start = resumed ? saved.index : firstChunkInView(chunks);
    show(inOrder(start), 0);
    if (prefs.fullscreen) setFullscreen(true);
    if (resumed) toast(`Picked up where you left off. Press g to start from the top.`);
    else if (session.order.length < chunks.length) toast(`Showing only what changed. Press d for the whole spec.`);
  }

  // The chunks j and k step through: every chunk, or only the changed ones.
  function orderOf(chunks, prefs) {
    const all = [...chunks.keys()];
    const changed = all.filter((i) => chunks[i].change);
    return prefs.changesOnly && changed.length ? changed : all;
  }

  // `index` if it's in the reading order, else the nearest one after it (or
  // before it, at the end).
  function inOrder(index) {
    const { order } = session;
    return order.find((i) => i >= index) ?? order.at(-1);
  }

  function neighbour(direction) {
    const { order, index } = session;
    return direction > 0 ? order.find((i) => i > index) : order.findLast((i) => i < index);
  }

  function close({ jump = true } = {}) {
    if (!session) return;
    const { chunks, index, els, reviewComments } = session;
    if (session.fullscreen) setFullscreen(false);
    els.root.remove();
    document.documentElement.classList.remove('sf-open');
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('turbo:visit', onNavigate);
    window.removeEventListener('popstate', onNavigate);
    session = null;
    if (jump) flash(chunks[index].nodes);
    if (reviewComments) {
      const count = reviewComments === 1 ? '1 comment is' : `${reviewComments} comments are`;
      pageToast(`${count} waiting in your pending review. Reload the page, then finish your review to post them.`);
    }
  }

  function onNavigate() {
    close({ jump: false });
  }

  // Prefer the markdown the reader has selected text in, then the one in the
  // middle of the screen, then the longest on the page.
  function pickBody(bodies) {
    const anchor = document.getSelection()?.anchorNode;
    const selected = anchor && bodies.find((el) => el.contains(anchor));
    if (selected) return selected;
    const middle = innerHeight / 2;
    const inView = bodies.find((el) => {
      const rect = el.getBoundingClientRect();
      return rect.top <= middle && rect.bottom >= middle;
    });
    if (inView) return inView;
    return bodies.reduce((best, el) => (!best || el.textContent.length > best.textContent.length ? el : best), null);
  }

  // PRs show markdown files as a raw diff. Switch the file in view (or the
  // first one) to GitHub's rich diff so there's rendered markdown to read.
  async function showRichDiff() {
    const toggles = [...document.querySelectorAll('button[aria-label="Display the rich diff"]')];
    const fileOf = (toggle) =>
      toggle.closest('.file, [data-file-path], [data-tagsearch-path]') ?? toggle.form ?? toggle;
    const middle = innerHeight / 2;
    const toggle =
      toggles.find((t) => {
        const rect = fileOf(t).getBoundingClientRect();
        return rect.top <= middle && rect.bottom >= middle;
      }) ?? toggles[0];
    if (!toggle) return null;
    const file = fileOf(toggle);
    toggle.click();
    pageToast('Switching to the rich diff…');
    const deadline = Date.now() + RICH_DIFF_TIMEOUT;
    while (Date.now() < deadline) {
      const [body] = visible(findMarkdownBodies(file.isConnected ? file : document));
      if (body) return body;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  function visible(elements) {
    return elements.filter((el) => el.getClientRects().length > 0);
  }

  function firstChunkInView(chunks) {
    const index = chunks.findIndex((c) => c.nodes.at(-1).getBoundingClientRect().bottom > STICKY_HEADER_HEIGHT);
    return Math.max(index, 0);
  }

  function render() {
    const root = el('div', { id: 'spec-focus-root', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Spec focus' });
    const crumb = el('div', { class: 'sf-crumb' });
    const change = el('div', { class: 'sf-change' });
    const commented = el('div', { class: 'sf-commented' });
    const count = el('div', { class: 'sf-count', 'aria-live': 'polite' });
    const hint = el('button', { class: 'sf-hint', type: 'button' }, '? keys');
    const prev = el('div', { class: 'sf-chunk sf-prev markdown-body', 'aria-hidden': 'true' });
    const current = el('div', { class: 'sf-chunk sf-current markdown-body', tabindex: '-1' });
    const next = el('div', { class: 'sf-chunk sf-next markdown-body', 'aria-hidden': 'true' });
    const fill = el('div', { class: 'sf-progress-fill' });
    const toastEl = el('div', { class: 'sf-toast', role: 'status' });
    const composer = renderComposer();
    const help = el('div', { class: 'sf-help', hidden: '' }, [
      el('h2', {}, 'Keys'),
      el(
        'dl',
        {},
        HELP.flatMap(([keys, action]) => [el('dt', {}, keys), el('dd', {}, action)]),
      ),
    ]);

    root.append(
      el('header', { class: 'sf-bar' }, [crumb, el('div', { class: 'sf-bar-end' }, [commented, change, count, hint])]),
      el('main', { class: 'sf-stage' }, [prev, current, next]),
      composer.form,
      el('footer', { class: 'sf-progress' }, [fill]),
      toastEl,
      help,
    );

    prev.addEventListener('click', () => go(neighbour(-1)));
    next.addEventListener('click', () => go(neighbour(1)));
    hint.addEventListener('click', toggleHelp);
    root.addEventListener('click', onLinkClick);
    document.body.append(root);
    return { root, crumb, change, commented, count, prev, current, next, fill, toast: toastEl, help, composer };
  }

  function renderComposer() {
    const where = el('div', { class: 'sf-composer-where' });
    const lines = el('pre', { class: 'sf-composer-lines' });
    const input = el('textarea', { rows: '4', placeholder: 'Leave a comment', 'aria-label': 'Comment' });
    const note = el('span', { class: 'sf-composer-note' });
    const single = el('button', { type: 'button', class: 'sf-button' }, 'Add single comment');
    const review = el('button', { type: 'submit', class: 'sf-button sf-button-primary' }, 'Add review comment');
    const form = el('form', { class: 'sf-composer', hidden: '' }, [
      where,
      lines,
      input,
      el('div', { class: 'sf-composer-foot' }, [note, single, review]),
    ]);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      submitComment({ single: false });
    });
    single.addEventListener('click', () => submitComment({ single: true }));
    note.addEventListener('click', (event) => {
      if (event.target.matches('button')) chrome.runtime.sendMessage({ type: 'options' });
    });
    return { form, where, lines, input, note, buttons: [single, review] };
  }

  function show(index, direction) {
    const { chunks, order, els } = session;
    closeComposer();
    session.index = index;
    const chunk = chunks[index];
    els.prev.replaceChildren(index > 0 ? cloneChunk(chunks[index - 1]) : '');
    els.current.replaceChildren(cloneChunk(chunk));
    els.next.replaceChildren(index < chunks.length - 1 ? cloneChunk(chunks[index + 1]) : '');
    // Coming back up into a long chunk lands on its end, like scrolling would.
    els.current.scrollTop = direction < 0 ? els.current.scrollHeight : 0;
    els.crumb.textContent = chunk.trail.join('  ›  ');
    els.change.textContent = CHANGE_LABELS[chunk.change] ?? '';
    els.change.dataset.change = chunk.change ?? '';
    els.current.dataset.change = chunk.change ?? '';
    const done = order.filter((i) => i <= index).length;
    const changesOnly = order.length < chunks.length;
    els.count.textContent = changesOnly ? `Change ${done} of ${order.length}` : `${index + 1} / ${chunks.length}`;
    els.fill.style.transform = `scaleX(${changesOnly ? done / order.length : (index + 1) / chunks.length})`;
    showCommentCount();
    els.current.classList.remove('sf-enter-down', 'sf-enter-up');
    if (direction) {
      void els.current.offsetWidth; // restart the entrance animation
      els.current.classList.add(direction > 0 ? 'sf-enter-down' : 'sf-enter-up');
    }
    els.current.focus({ preventScroll: true });
    savePosition();
  }

  function step(direction) {
    const view = session.els.current;
    const page = view.clientHeight * 0.85;
    if (direction > 0 && view.scrollTop + view.clientHeight < view.scrollHeight - 2) {
      view.scrollBy({ top: page, behavior: 'smooth' });
    } else if (direction < 0 && view.scrollTop > 2) {
      view.scrollBy({ top: -page, behavior: 'smooth' });
    } else {
      go(neighbour(direction), direction);
    }
  }

  // `direction` says which end was hit when there's nowhere to go.
  function go(index, direction = 1) {
    if (index === undefined) {
      const changesOnly = session.order.length < session.chunks.length;
      if (direction < 0) return toast(changesOnly ? 'No changes before this.' : 'Start of the spec.');
      return toast(
        changesOnly
          ? 'That was the last change. d shows the whole spec; Esc takes you back to the page.'
          : 'End of the spec. Esc takes you back to the page.',
      );
    }
    if (index !== session.index) show(index, Math.sign(index - session.index));
  }

  function toggleChangesOnly() {
    const { chunks } = session;
    if (!chunks.some((c) => c.change)) return toast('Nothing here is marked as changed. This works on PR rich diffs.');
    updatePrefs({ changesOnly: !session.prefs.changesOnly });
    session.order = orderOf(chunks, session.prefs);
    show(inOrder(session.index), 0);
    toast(
      session.prefs.changesOnly
        ? `Showing only the ${session.order.length} changes. d shows the whole spec.`
        : 'Showing the whole spec.',
    );
  }

  function goToChange(direction) {
    const { chunks, index } = session;
    const order = direction > 0 ? chunks.keys() : [...chunks.keys()].reverse();
    const target = [...order].find((i) => (direction > 0 ? i > index : i < index) && chunks[i].change);
    if (target !== undefined) go(target, direction);
    else if (!chunks.some((c) => c.change)) toast('No changes to jump between. This works on PR rich diffs.');
    else toast(direction > 0 ? 'No more changes after this.' : 'No changes before this.');
  }

  function onKey(event) {
    if (session.composer && session.els.composer.form.contains(event.target)) return onComposerKey(event);
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    // Keep GitHub's own shortcuts from firing underneath the overlay.
    event.stopImmediatePropagation();
    const helpOpen = !session.els.help.hidden;
    const actions = {
      j: () => step(1),
      ArrowDown: () => step(1),
      ArrowRight: () => step(1),
      Enter: () => step(1),
      ' ': () => step(event.shiftKey ? -1 : 1),
      k: () => step(-1),
      ArrowUp: () => step(-1),
      ArrowLeft: () => step(-1),
      g: () => go(session.order[0], -1),
      Home: () => go(session.order[0], -1),
      G: () => go(session.order.at(-1)),
      End: () => go(session.order.at(-1)),
      n: () => goToChange(1),
      N: () => goToChange(-1),
      d: toggleChangesOnly,
      m: openComposer,
      c: () => updatePrefs({ context: !session.prefs.context }),
      '+': () => resizeText(2),
      '=': () => resizeText(2),
      '-': () => resizeText(-2),
      _: () => resizeText(-2),
      f: toggleFullscreen,
      '?': toggleHelp,
      q: () => close(),
      Escape: () => (helpOpen ? toggleHelp() : session.composer ? closeComposer() : close()),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  }

  function onComposerKey(event) {
    // Typing goes to the comment box, not to GitHub's shortcuts or ours.
    event.stopImmediatePropagation();
    if (event.key === 'Escape') {
      event.preventDefault();
      closeComposer();
      session.els.current.focus({ preventScroll: true });
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submitComment({ single: event.shiftKey });
    }
  }

  // Opens the comment box for the current chunk, or for the text selected in
  // it, and works out which lines of the file that is.
  async function openComposer() {
    const { file, chunks, index, els } = session;
    if (!file) return toast("Comments work on markdown files on a PR's Files changed tab.");
    const chunk = chunks[index];
    const selected = selectionIn(els.current);
    const side = selected?.side ?? (chunk.change === 'removed' ? 'LEFT' : 'RIGHT');
    const text = selected?.text ?? renderedText(chunk.nodes, side);
    const composer = { index, text, lines: null, ready: false };
    session.composer = composer;

    const { form, where, lines, input, note } = els.composer;
    form.hidden = false;
    where.replaceChildren(el('code', {}, file.path), ' · finding the lines…');
    lines.hidden = true;
    note.replaceChildren();
    input.value = session.drafts.get(index) ?? '';
    input.focus();
    setComposerBusy(true);

    try {
      const [{ rows }, tokenSet] = await Promise.all([loadFile(file), hasToken()]);
      if (session?.composer !== composer) return;
      composer.lines = locateLines(rows, text, side);
      composer.ready = tokenSet;
      showCommentTarget(composer);
      if (!tokenSet) {
        note.replaceChildren(
          'Add a GitHub token to comment. ',
          el('button', { type: 'button', class: 'sf-link' }, 'Open options'),
        );
      }
    } catch (error) {
      if (session?.composer !== composer) return;
      where.replaceChildren(el('code', {}, file.path));
      note.textContent = error.message;
    }
    setComposerBusy(!composer.ready);
  }

  function showCommentTarget({ lines: target, text }) {
    const { where, lines } = session.els.composer;
    const path = el('code', {}, session.file.path);
    if (!target) {
      where.replaceChildren(path, " · this isn't in the diff, so it'll be a file comment quoting it");
      lines.textContent = quote(text);
      lines.hidden = false;
      return;
    }
    const { side, start, end, rows } = target;
    const range = start === end ? `line ${start}` : `lines ${start}–${end}`;
    where.replaceChildren(path, ` · ${range}${side === 'LEFT' ? ' of the old version' : ''}`);
    const key = side === 'LEFT' ? 'left' : 'right';
    const marks = { add: '+', del: '-', context: ' ' };
    const shown = rows.length > PREVIEW_LINES ? [...rows.slice(0, PREVIEW_LINES - 1), null, rows.at(-1)] : rows;
    lines.textContent = shown
      .map((row) => (row ? `${String(row[key]).padStart(4)} ${marks[row.type]} ${row.text}` : '     ⋮'))
      .join('\n');
    lines.hidden = false;
  }

  async function submitComment({ single }) {
    const { composer, file, els } = session;
    const body = els.composer.input.value.trim();
    if (!composer?.ready || !body) return;
    setComposerBusy(true);
    els.composer.note.textContent = single ? 'Posting…' : 'Adding to your review…';
    try {
      const text = composer.lines ? body : `${quote(composer.text)}\n\n${body}`;
      await addComment(file, composer.lines, text, { single });
    } catch (error) {
      if (session?.composer !== composer) return;
      els.composer.note.textContent = error.message;
      setComposerBusy(false);
      return;
    }
    if (!session) return;
    session.drafts.delete(composer.index);
    session.comments.set(composer.index, (session.comments.get(composer.index) ?? 0) + 1);
    if (!single) session.reviewComments++;
    if (session.composer === composer) {
      els.composer.input.value = '';
      closeComposer();
      els.current.focus({ preventScroll: true });
    }
    showCommentCount();
    toast(single ? 'Comment posted.' : 'Added to your pending review. Finish the review on GitHub to post it.');
  }

  function closeComposer() {
    const { composer, els } = session;
    if (!composer) return;
    const draft = els.composer.input.value;
    if (draft.trim()) session.drafts.set(composer.index, draft);
    else session.drafts.delete(composer.index);
    session.composer = null;
    els.composer.form.hidden = true;
  }

  function setComposerBusy(busy) {
    session.els.composer.buttons.forEach((button) => (button.disabled = busy));
  }

  function showCommentCount() {
    const count = session.comments.get(session.index) ?? 0;
    session.els.commented.textContent = count ? `💬 ${count}` : '';
    session.els.commented.title = count ? `You commented on this ${count === 1 ? 'once' : `${count} times`}` : '';
  }

  // Selected text inside the current chunk, and which side of the diff it's on.
  function selectionIn(container) {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || !container.contains(selection.anchorNode)) return null;
    const text = selection.toString().trim();
    if (!text) return null;
    const common = selection.getRangeAt(0).commonAncestorContainer;
    const element = common.nodeType === Node.ELEMENT_NODE ? common : common.parentElement;
    const side = element.closest('del') ? 'LEFT' : element.closest('ins') ? 'RIGHT' : null;
    return { text, side };
  }

  function quote(text) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return `> ${flat.length > QUOTE_LENGTH ? `${flat.slice(0, QUOTE_LENGTH - 1)}…` : flat}`;
  }

  // In-page links (#some-heading) move to that chunk instead of scrolling the
  // hidden page; everything else opens in a new tab so focus mode stays put.
  function onLinkClick(event) {
    const link = event.target.closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href');
    if (!href.startsWith('#')) {
      link.target = '_blank';
      link.rel = 'noopener';
      return;
    }
    event.preventDefault();
    const id = decodeURIComponent(href.slice(1));
    const target = document.getElementById(`user-content-${id}`) ?? document.getElementById(id);
    const index = target ? session.chunks.findIndex((c) => c.nodes.some((node) => node.contains(target))) : -1;
    if (index >= 0 && index !== session.index) show(index, Math.sign(index - session.index));
  }

  function cloneChunk(chunk) {
    const fragment = document.createDocumentFragment();
    for (const node of chunk.nodes) {
      const copy = node.cloneNode(true);
      copy.removeAttribute('id');
      copy.querySelectorAll('[id]').forEach((child) => child.removeAttribute('id'));
      fragment.append(copy);
    }
    return fragment;
  }

  function resizeText(delta) {
    const [min, max] = FONT_SIZE_RANGE;
    updatePrefs({ fontSize: Math.min(max, Math.max(min, session.prefs.fontSize + delta)) });
  }

  function toggleFullscreen() {
    updatePrefs({ fullscreen: !session.prefs.fullscreen });
    setFullscreen(session.prefs.fullscreen);
  }

  function setFullscreen(on) {
    session.fullscreen = on;
    chrome.runtime.sendMessage({ type: 'fullscreen', on }).catch(() => {});
  }

  function toggleHelp() {
    session.els.help.hidden = !session.els.help.hidden;
  }

  function updatePrefs(changes) {
    Object.assign(session.prefs, changes);
    applyPrefs();
    chrome.storage.local.set({ prefs: session.prefs });
  }

  function applyPrefs() {
    const { root } = session.els;
    root.style.setProperty('--sf-font-size', `${session.prefs.fontSize}px`);
    root.classList.toggle('sf-no-context', !session.prefs.context);
  }

  function savePosition() {
    const { positions, key, index, chunks } = session;
    positions[key] = { index, total: chunks.length, at: Date.now() };
    const keys = Object.keys(positions);
    if (keys.length > MAX_SAVED_POSITIONS) {
      keys.sort((a, b) => positions[a].at - positions[b].at);
      keys.slice(0, keys.length - MAX_SAVED_POSITIONS).forEach((k) => delete positions[k]);
    }
    chrome.storage.local.set({ positions });
  }

  function toast(message) {
    const { toast: toastEl } = session.els;
    toastEl.textContent = message;
    toastEl.classList.add('sf-visible');
    clearTimeout(toastEl.timer);
    toastEl.timer = setTimeout(() => toastEl.classList.remove('sf-visible'), 2600);
  }

  function pageToast(message) {
    const toastEl = el('div', { class: 'sf-toast sf-page-toast sf-visible', role: 'status' }, message);
    document.body.append(toastEl);
    setTimeout(() => toastEl.remove(), 4000);
  }

  // Scroll the page to where the reader stopped and briefly highlight it, so
  // they can comment on or edit exactly that part.
  function flash(nodes) {
    const live = visible(nodes.filter((node) => node.isConnected));
    if (!live.length) return;
    live[0].scrollIntoView({ block: 'center' });
    live.forEach((node) => {
      node.classList.remove('sf-flash');
      void node.offsetWidth;
      node.classList.add('sf-flash');
      node.addEventListener('animationend', () => node.classList.remove('sf-flash'), { once: true });
    });
  }

  function el(tag, attrs = {}, children = []) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    node.append(...[].concat(children));
    return node;
  }
})();
