[简体中文](./README.zh-CN.md)

# Sidet

Sidet is an easy-to-use AI chat plugin for Obsidian. It keeps conversation browsing on the side, the current chat in focus, and useful results easier to capture back into your vault.

This public repository publishes the installable release files for Sidet. Source code is not included here.

## Why Sidet

Many AI plugins inside note apps feel heavy: too much setup, too many switches, and too much friction before a real conversation can even start.

Sidet takes a lighter path:

- simpler setup
- a more natural chat flow
- easier movement between conversation and notes
- useful results that can continue back into your vault

## What You Get

- Simple setup without a heavy configuration flow
- Side browsing for faster conversation switching
- A focused chat view that feels natural for longer conversations
- Hidden local conversation storage with export when you need it
- Easier capture of useful results back into your vault

## Main Experience

### Side browsing with a focused main chat

- Browse conversations from the side without losing the current thread
- Keep the active chat in the main view for longer reading and writing
- Switch faster between conversations while keeping the overall layout simple

### A home page you can turn into your own launcher

- Sidet has its own home page inside Obsidian
- You can pin useful commands to the home page for faster access
- This makes common actions easier to reach without digging through menus

### Lightweight context input

Sidet supports several natural ways to bring context into a conversation:

- quote Markdown notes
- quote web pages
- choose images
- use `@` to quickly reference Markdown notes

These inputs are attached as context instead of being dumped into the message body, which keeps the conversation cleaner and easier to manage.

### Easier knowledge capture

Sidet does not stop at answering. It also helps move useful results back into your vault in a more structured way.

- You can organize the current conversation into your knowledge base
- Existing notes can be brought into the same knowledge flow
- Writing actions stay confirm-first, so the result is reviewed before it changes your files

### A simple knowledge structure

Sidet's knowledge flow currently centers on `Sidet/Wiki`, with a lightweight structure designed for continued maintenance instead of one-off dumping:

- `knowledge-card` for compact long-term knowledge
- `concept-page` for larger topics that need structure
- `supporting-note` for related supporting material
- `Index.md` as a top-level route page

The goal is to keep knowledge easier to revisit, connect, and update over time.

### Better note and web capture

- Web pages can be quoted into chat and previewed before sending
- Markdown notes can be brought in as clean attachments
- Images can be added as conversation context
- Useful results can be exported or written back into your vault through a confirm-first flow

## Install

1. Download the files from the latest release.
2. Place them in:

```text
.obsidian/plugins/sidet/
```

3. Make sure these files are present:
   - `main.js`
   - `manifest.json`
   - `styles.css`

## Public Commands and Shortcuts

Sidet already supports commands that can be useful as pinned home actions or regular shortcuts, including:

- Open Sidet
- New chat
- Export current conversation
- Insert the current note into the draft
- Insert the current selection into the draft
- Organize the current conversation into the knowledge base

This keeps the main path visible without forcing users into a heavy control center.

## Public Repository Scope

This repository contains release artifacts only:

- `main.js`
- `manifest.json`
- `styles.css`
- `versions.json`

Source code, development documents, scripts, and local runtime data are not published here.
