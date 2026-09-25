// Focus mode: covers the GitHub page with a full-screen reader that shows one
// chunk of the spec at a time, with neighbouring chunks faded for context.
(() => {
  const { buildChunks, findMarkdownBodies } = globalThis.SpecFocus;

  const DEFAULT_PREFS = { fontSize: 20, context: true, fullscreen: true };
  const FONT_SIZE_RANGE = [14, 32];
  const MAX_SAVED_POSITIONS = 200;
  const STICKY_HEADER_HEIGHT = 80;
  const RICH_DIFF_TIMEOUT = 10000;
  const CHANGE_LABELS = { added: 'Added', removed: 'Removed', changed: 'Changed' };

  const HELP = [
    ['j  ↓  Space', 'Next chunk (scrolls long ones first)'],
    ['k  ↑  ⇧Space', 'Previous chunk'],
    ['n  N', 'Next / previous change (PR rich diffs)'],
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

    session = { chunks, prefs, positions, key, index: 0, els: render(), fullscreen: false };
    applyPrefs();
    document.documentElement.classList.add('sf-open');
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('turbo:visit', onNavigate);
    window.addEventListener('popstate', onNavigate);

    show(resumed ? saved.index : firstChunkInView(chunks), 0);
    if (prefs.fullscreen) setFullscreen(true);
    if (resumed) toast(`Picked up where you left off. Press g to start from the top.`);
  }

  function close({ jump = true } = {}) {
    if (!session) return;
    const { chunks, index, els } = session;
    if (session.fullscreen) setFullscreen(false);
    els.root.remove();
    document.documentElement.classList.remove('sf-open');
    window.removeEventListener('keydown', onKey, true);
    document.removeEventListener('turbo:visit', onNavigate);
    window.removeEventListener('popstate', onNavigate);
    session = null;
    if (jump) flash(chunks[index].nodes);
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
    const count = el('div', { class: 'sf-count', 'aria-live': 'polite' });
    const hint = el('button', { class: 'sf-hint', type: 'button' }, '? keys');
    const prev = el('div', { class: 'sf-chunk sf-prev markdown-body', 'aria-hidden': 'true' });
    const current = el('div', { class: 'sf-chunk sf-current markdown-body', tabindex: '-1' });
    const next = el('div', { class: 'sf-chunk sf-next markdown-body', 'aria-hidden': 'true' });
    const fill = el('div', { class: 'sf-progress-fill' });
    const toastEl = el('div', { class: 'sf-toast', role: 'status' });
    const help = el('div', { class: 'sf-help', hidden: '' }, [
      el('h2', {}, 'Keys'),
      el(
        'dl',
        {},
        HELP.flatMap(([keys, action]) => [el('dt', {}, keys), el('dd', {}, action)]),
      ),
    ]);

    root.append(
      el('header', { class: 'sf-bar' }, [crumb, el('div', { class: 'sf-bar-end' }, [change, count, hint])]),
      el('main', { class: 'sf-stage' }, [prev, current, next]),
      el('footer', { class: 'sf-progress' }, [fill]),
      toastEl,
      help,
    );

    prev.addEventListener('click', () => go(session.index - 1));
    next.addEventListener('click', () => go(session.index + 1));
    hint.addEventListener('click', toggleHelp);
    root.addEventListener('click', onLinkClick);
    document.body.append(root);
    return { root, crumb, change, count, prev, current, next, fill, toast: toastEl, help };
  }

  function show(index, direction) {
    const { chunks, els } = session;
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
    els.count.textContent = `${index + 1} / ${chunks.length}`;
    els.fill.style.transform = `scaleX(${(index + 1) / chunks.length})`;
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
      go(session.index + direction);
    }
  }

  function go(index) {
    const last = session.chunks.length - 1;
    if (index > last) return toast('End of the spec. Esc takes you back to the page.');
    if (index < 0) return toast('Start of the spec.');
    if (index !== session.index) show(index, Math.sign(index - session.index));
  }

  function goToChange(direction) {
    const { chunks, index } = session;
    const order = direction > 0 ? chunks.keys() : [...chunks.keys()].reverse();
    const target = [...order].find((i) => (direction > 0 ? i > index : i < index) && chunks[i].change);
    if (target !== undefined) go(target);
    else if (!chunks.some((c) => c.change)) toast('No changes to jump between. This works on PR rich diffs.');
    else toast(direction > 0 ? 'No more changes after this.' : 'No changes before this.');
  }

  function onKey(event) {
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
      g: () => go(0),
      Home: () => go(0),
      G: () => go(session.chunks.length - 1),
      n: () => goToChange(1),
      N: () => goToChange(-1),
      End: () => go(session.chunks.length - 1),
      c: () => updatePrefs({ context: !session.prefs.context }),
      '+': () => resizeText(2),
      '=': () => resizeText(2),
      '-': () => resizeText(-2),
      _: () => resizeText(-2),
      f: toggleFullscreen,
      '?': toggleHelp,
      q: () => close(),
      Escape: () => (helpOpen ? toggleHelp() : close()),
    };
    const action = actions[event.key];
    if (!action) return;
    event.preventDefault();
    action();
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
    if (index >= 0) go(index);
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
