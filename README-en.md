# Sidet

<p align="center">
  <a href="https://github.com/jiaoyingxing/sidet/releases">
    <img alt="Release downloads" src="https://img.shields.io/github/downloads/jiaoyingxing/sidet/total.svg?style=flat-square&label=Release%20downloads" />
  </a>
  <a href="https://github.com/jiaoyingxing/sidet/releases">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/jiaoyingxing/sidet?style=flat-square&label=Latest%20release" />
  </a>
  <a href="https://community.obsidian.md/plugins/sidet">
    <img alt="Obsidian Plugin" src="https://img.shields.io/badge/Obsidian-Plugin-7c3aed?style=flat-square" />
  </a>
  <a href="./README.md">
    <img alt="CN 中文版" src="https://img.shields.io/badge/CN-%E4%B8%AD%E6%96%87%E7%89%88-d32f2f?style=flat-square" />
  </a>
  <a href="./README-en.md">
    <img alt="EN English" src="https://img.shields.io/badge/EN-English-2f6fed?style=flat-square" />
  </a>
</p>

Plug in your API key and you get a built-in lightweight agent you can talk to: it reads, edits, and creates notes, with a highly polished conversation experience designed especially for mobile. Open a new tab, and that tab is its home page.

## 1. Installation

1. Open Obsidian settings and go to **Community plugins**.
2. Search for `Sidet`, then install and enable it. Requires Obsidian `1.11.4` or later.

You can also use BRAT (add `https://github.com/jiaoyingxing/sidet`), or download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/jiaoyingxing/sidet/releases) into `<your-vault>/.obsidian/plugins/sidet/`.

## 2. Basic usage

1. Create an Obsidian tab to open or focus the Sidet home page.
2. Type a question; attach the current note, a selection, a webpage, or an image when needed.
3. Keep asking, organizing, and revising in the conversation.
4. To keep a result, preview it first and confirm the write-back (create a note / append / replace); anything you don't save stays in the conversation history.

Conversations run in Obsidian's main tab area; the right sidebar is a full-featured conversation list — creating, title search, pinning, folders, switching, archiving, and exporting all live there. Clicking a conversation opens it in the main tab area instead of squeezing the chat into the narrow sidebar. Archived conversations can be restored or deleted from settings.

**Quick entry points**: pin up to 8 frequently used commands to the home page (Obsidian native and other-plugin commands both work). Sidet also ships two Obsidian URLs — "Open new conversation" and "Import clipboard" — and you can add up to 8 custom URLs for one-click invocation from mobile or desktop shortcuts.

## 3. Web search

- For a specific webpage: enter its URL to add the page content to the current conversation.
- For external research: enable web search in the conversation — Sidet generates the search queries, searches and reads pages as needed, then answers with sources.
- With "Allow the model to search the web automatically" enabled in settings, the model searches on its own when needed (since `0.3.8`).

## 4. Models and API keys

Sidet can save multiple model configurations. Each has its own provider, model, endpoint, and API key, and one can be set as the default. API keys are stored in Obsidian `SecretStorage` (isolated by device and vault), never in conversation history or ordinary plugin settings.

Sidet does not include a model account. You provide and manage the model service, account, API key, usage fees, and service limits.

## 5. Data and privacy

| Data | Stored in |
| --- | --- |
| Conversation history, conversation index, and plugin settings | Local plugin data |
| API keys for each model configuration | Obsidian `SecretStorage`, isolated by device and vault |

- The author does not collect your API keys, conversations, notes, or other personal information.
- Conversation history stays in plugin data; starting a conversation never creates Markdown files in your vault.
- Model requests go only to the endpoint configured for that model. Web search sends queries to the built-in search providers (Bing, Baidu, Sogou); GitHub-focused searches call the GitHub API; adding a webpage requests the URL you provide.
- Sidet centers on deliberate input, selection, and confirmation, and runs no autonomous background tasks; creating, appending, or replacing a note always requires your confirmation.
- Keep independent backups of important notes.

## 6. Removed in `0.3.8`

Knowledge bases, Wiki, and user skills have been removed from Sidet:

- The `Sidet/Wiki`, `Sidet/Skills`, and `Sidet/Memory` folders and files you already have are **not deleted, renamed, or migrated** — keep or clean them up as you prefer.
- The plugin no longer reads, writes, or indexes these directories, and the related settings entries are gone.
- To find existing notes, keep using the note search in conversations.

## 7. License and contact

- Sidet is released under the MIT License; the source is public in the [GitHub repository](https://github.com/jiaoyingxing/sidet). Building locally requires Node.js 20+: run `npm ci`, then `npm run build`. See [LICENSE](./LICENSE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) for terms and third-party notices.
- Bugs, reproducible issues, and feature requests: [GitHub Issues](https://github.com/jiaoyingxing/sidet/issues). Community and product updates: search Xiaohongshu (小红书) for **焦应行** 🔍
