# Spec Focus

A Chrome extension for reading agent specs on GitHub without the noise. It
covers the page with a full-screen reader that shows one paragraph, list, code
block or table at a time, with the chunks either side faded out for context.

- **Works on** any rendered markdown on github.com: files, READMEs, PR and
  issue descriptions, comments. On a PR's _Files changed_ tab it flips the
  `.md` file in view to GitHub's rich diff for you, labels each chunk
  **Added**, **Removed** or **Changed**, and `n` / `N` jump between changes.
- **Quiets the window**: puts the browser window into macOS full screen while
  you read and puts it back when you leave. Press `f` to turn that off.
- **Keeps your place**: reopening a spec resumes where you stopped. Leaving
  with `Esc` scrolls the page to the chunk you were on and highlights it, so
  you can comment on or edit that exact part.

Pair it with a macOS Focus mode to silence notifications too; an extension
can't do that part.

## Install

1. `chrome://extensions` → turn on **Developer mode** → **Load unpacked** →
   pick this folder. (Works the same in Arc, Brave and Edge.)
2. Pin the extension. Click it, or press **⌥⇧F**, on any GitHub page with
   markdown. Change the shortcut at `chrome://extensions/shortcuts`.

## Keys

| Key              | Does                                    |
| ---------------- | --------------------------------------- |
| `j` `↓` `Space`  | Next chunk (scrolls long ones first)    |
| `k` `↑` `⇧Space` | Previous chunk                          |
| `n` `N`          | Next / previous change (PR rich diffs)  |
| `g` `G`          | First / last chunk                      |
| `c`              | Show or hide the surrounding chunks     |
| `+` `-`          | Text size                               |
| `f`              | Full screen on or off                   |
| `Esc` `q`        | Leave and jump to this spot on the page |
| `?`              | Show the keys                           |

Text size, context and full screen settings are remembered.

## How chunks are made

`src/chunker.js` walks GitHub's rendered markdown: every paragraph, list, code
block, table, quote or alert is a chunk. Headings join the block after them,
and a short lead-in ending in a colon ("The agent must:") joins the list or
code it introduces.

## Development

No build step; the extension runs straight from `src/`.

```sh
npm install
npm test               # chunker tests (node:test + jsdom)
npm run screenshots    # loads the extension in Chromium against a real spec
npm run icons          # re-renders icons/*.png from icons/icon.svg
```

After editing, hit reload on the extension's card in `chrome://extensions`.
