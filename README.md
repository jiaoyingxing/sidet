[简体中文](./README.zh-CN.md)

# Sidet

Sidet is an easy-to-use AI chat plugin for Obsidian.

It is built for a simple goal: keep chat usable inside your vault without turning the whole plugin into a heavy control center. You open Sidet, switch conversations from the side, stay focused on the current chat, and bring useful notes, web pages, and images into the same flow.

This public repository ships installable release files only. Source code is not included here.

## Why Sidet

Many AI plugins inside note apps ask users to carry too much setup and too many visible controls before a normal conversation can even begin.

Sidet takes a lighter path:

- simpler setup
- a clearer chat-first layout
- easier movement between conversation and vault content
- a cleaner way to save useful results back into Obsidian

## What Sidet Feels Like

### Side browsing, focused chat

- Browse and switch conversations from the side
- Keep the active conversation in the main view
- Stay closer to a normal chat experience instead of a settings-heavy workflow

### A home page you can turn into your own launcher

- Sidet has its own home page inside Obsidian
- You can pin selected Obsidian commands to that page
- These can include Sidet commands, suitable commands from other plugins, and some built-in Obsidian actions
- This makes common actions easier to reach right after opening Sidet

If you want, Sidet's home page can become your quick entry for everyday AI actions inside Obsidian.

## Bring Context In Naturally

Sidet keeps the high-frequency context inputs simple:

- quote Markdown notes
- quote web pages
- choose images
- use `@` to reference Markdown notes

These inputs are attached as conversation context instead of being dumped into the message body. The result is easier to read, easier to manage, and easier to continue.

## Capture Useful Results Back Into Your Vault

Sidet is not only for asking questions. It also helps you continue useful results back into your own vault.

- Organize the current conversation into your knowledge base
- Bring existing notes into the same knowledge flow
- Preview writing actions before anything is written to files

This keeps the write-back path more usable and easier to trust.

## A Lightweight Knowledge Structure

Sidet's current knowledge flow centers on `Sidet/Wiki`.

It is designed to stay maintainable instead of becoming a dumping ground:

- `knowledge-card` for compact long-term knowledge
- `concept-page` for larger topics that need structure
- `supporting-note` for supporting material
- `Index.md` as the top route page

The goal is simple: make useful knowledge easier to revisit, connect, and keep improving over time.

## Main Things You Can Do

- Start and switch chats quickly
- Keep local conversation history inside the plugin
- Export the current conversation when needed
- Quote Markdown notes into chat
- Quote a web page and preview it before sending
- Choose an image as conversation context
- Turn useful conversation results into knowledge-base work

## Home Shortcuts And Sidet Commands

These are two related but different things:

- Home shortcuts: the Sidet home page can pin up to 8 selected Obsidian commands
- Sidet commands: the plugin also ships its own command set

Home shortcuts are chosen from a filtered command pool. They are not limited to Sidet itself.

They can include:

- suitable Sidet commands
- suitable commands from other plugins
- some built-in Obsidian actions

Editor-formatting commands are hidden by default, because the home page is meant to surface launch actions instead of becoming a second toolbar.

Current Sidet commands include:

- Open Sidet
- New chat
- Export current conversation
- Insert the current note into the draft
- Insert the current selection into the draft
- Organize the current conversation into the knowledge base

## Install

1. Download the files from the latest release.
2. Put them in:

```text
.obsidian/plugins/sidet/
```

3. Make sure the folder contains:
   - `main.js`
   - `manifest.json`
   - `styles.css`

## Current Public Build

`0.0.1` is an early public artifact release.

It already covers the main chat path, conversation browsing, lightweight context input, and the first version of Sidet's knowledge capture flow. More capability will continue to grow from this base, but the current public description only covers what is already present.

## Public Repository Scope

This repository contains release artifacts only:

- `main.js`
- `manifest.json`
- `styles.css`
- `versions.json`

Source code, development documents, scripts, and local runtime data are not published here.
