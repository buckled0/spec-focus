# Spec Focus

A Chrome extension for reading agent specs on GitHub without the noise. It
covers the page with a full-screen reader that shows one paragraph, list, code
block or table at a time, with the chunks either side faded out for context.

- **Works on** any rendered markdown on github.com: files, READMEs, PR and
  issue descriptions, comments. On a PR's _Files changed_ tab it flips the
  `.md` file in view to GitHub's rich diff for you and shows only the chunks
  that changed, each labelled **Added**, **Removed** or **Changed**. `d`
  switches to the whole spec and back.
- **Takes line comments**: on a PR, `m` opens a comment box for the chunk
  you're reading, already pointed at the right lines of the file. See
  [Commenting](#commenting).
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
| `d`              | Only the changes, or the whole spec     |
| `m`              | Comment on this chunk or the selection  |
| `g` `G`          | First / last chunk                      |
| `c`              | Show or hide the surrounding chunks     |
| `+` `-`          | Text size                               |
| `f`              | Full screen on or off                   |
| `Esc` `q`        | Leave and jump to this spot on the page |
| `?`              | Show the keys                           |

Text size, context, full screen and changes-only settings are remembered.

## Commenting

On a PR's _Files changed_ tab, press `m` to comment on the chunk you're
reading. Select some text in it first to comment on just the lines that text
sits on. The box shows which lines of the file the comment will land on, so
you can check before posting:

- `⌘↵` **Add review comment** adds it to your pending review, like _Start a
  review_ on GitHub. Finish the review on GitHub to post it.
- `⇧⌘↵` **Add single comment** posts it straight away.
- `Esc` closes the box and keeps what you wrote for when you come back.

GitHub's rich diff has no line numbers, so Spec Focus lines the chunk's words
up against the PR's patch (`src/lines.js`). Comments on removed text go on
the old version's lines. GitHub only takes line comments on lines in the diff,
so a chunk outside it becomes a file comment that quotes it.

Commenting needs a GitHub token: open the extension's **Options**, then paste
a fine-grained token with **Pull requests: Read and write** (or a classic
token with `repo`). It's stored in the extension and only sent to
api.github.com.

## How chunks are made

`src/chunker.js` walks GitHub's rendered markdown: every paragraph, list, code
block, table, quote or alert is a chunk. Headings join the block after them,
and a short lead-in ending in a colon ("The agent must:") joins the list or
code it introduces.

## Development

No build step; the extension runs straight from `src/`.

```sh
npm install
npm test               # chunker and line-mapping tests (node:test + jsdom)
npm run screenshots    # loads the extension in Chromium against a real spec
npm run icons          # re-renders icons/*.png from icons/icon.svg
```

After editing, hit reload on the extension's card in `chrome://extensions`.
