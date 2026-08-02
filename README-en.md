[简体中文](./README.md)

# Sidet

After Sidet is installed, creating an Obsidian tab opens or focuses the Sidet home page first. If the home page is already active, creating another tab keeps Obsidian's native blank page. From the Sidet home page, you can type a question or run one of your pinned commands.

The current note, a selection, webpages, and images can be brought into a conversation. The home page also provides entry points for knowledge-base search, webpage clipping, web search, and Wiki cards. When you want to save a result, Sidet shows a preview before creating a note, appending to an existing note, or replacing a selected note.

Conversations open in Obsidian's main tab area. The conversation list lives in the right sidebar, where you can create, search, pin, organize, switch, archive, and export conversations.

## 1. ✨ Main Features

| Feature | Description |
| --- | --- |
| 🏠 Home and pinned commands | Creating a tab opens or focuses Sidet home; when home is already active, you can continue to a native blank tab. Sidet, Obsidian, and other plugin commands can be pinned to the home page. |
| 💬 Conversations | Continuous conversations, streaming responses, history, and per-conversation model selection. |
| 📥 Notes and materials | Bring the current note, a selection, webpages, and images into a conversation. |
| 📚 Knowledge bases | Search one knowledge base or all knowledge bases. Search currently runs locally with keywords. |
| 🗂️ Wiki organization | Turn the current input into a Wiki-card draft, organize a conversation or note into a knowledge base, and create `Index.md` for a folder. |
| 🌐 Webpages and web search | Add a specific webpage to a conversation or enable web search for the current conversation. |
| 📝 Controlled write-back | Preview the result, then create a note, append to an existing note, or replace a selected note. |
| 📂 Conversation management | Use the right sidebar to create, search, pin, organize, and switch conversations, or archive and export them. Archived conversations can be restored or deleted from settings. |
| 📱 Desktop and mobile | Conversations use the main tab area and the sidebar manages sessions. Input, keyboard behavior, scrolling, and layout are adapted for phones. |

## 2. ⚙️ A Typical Workflow

1. Create an Obsidian tab to open or focus the Sidet home page.
2. Type a question directly, or first select knowledge-base search, webpage clipping, web search, or Wiki cards.
3. Add the current note, a selection, a webpage, or an image when needed.
4. Continue asking, organizing, and revising in the conversation.
5. Preview anything you want to keep, then confirm the write-back action. Everything else can remain in conversation history.

## 3. 💬 Main Chat and Right Sidebar

Sidet keeps the active conversation in Obsidian's main tab area and uses the right sidebar only for the conversation list. Opening a conversation from the list shows it in the main area instead of squeezing the chat into the sidebar.

The sidebar is restored after the workspace starts and can also be reopened with the **Open conversation list** command. It supports creating conversations, title search, pinning, folders, and switching. Conversation menus provide move, archive, and export actions, and the active conversation is marked in the list.

## 4. 🏠 Home Shortcuts

Up to eight commands can be pinned to the home page. You can use Sidet commands, Obsidian commands, and commands from other plugins, then adjust their order and icons. If no Sidet home page exists, creating a tab opens one. If home is in the background, Sidet focuses it. Only when home is already active does the next new-tab action open Obsidian's native blank page.

## 5. 🔗 URL Launching

Sidet includes two Obsidian URLs for opening a new conversation and importing the clipboard. You can also configure up to eight custom URLs for frequently used commands.

These links can be used with mobile shortcuts, desktop shortcuts, or other apps. A link can open a new conversation, import clipboard content, or run its assigned command.

## 6. ⚙️ Model Services

Sidet can save multiple model configurations. Each configuration has its own provider, model, endpoint, and API key, and one configuration can be selected as the default.

New conversations use the current default model, while existing conversations keep their assigned model. If an assigned model is deleted, affected conversations fall back to the current default. API keys are stored in Obsidian `SecretStorage`, not in conversation history or ordinary plugin settings.

Sidet does not include a model account. You provide and manage the model service, account, API key, usage fees, and service limits.

## 7. 📚 Knowledge Bases and Wiki

Knowledge-base search can target one knowledge base or all of them. Search currently runs locally with keywords and does not call a model. To organize new material, you can turn the current conversation or note into a knowledge card; Sidet shows a plan or content preview before writing.

Knowledge bases use `Index.md` as the folder entry point. Sidet can create a knowledge-base root page for a selected folder. Maintenance for historical Sidet Wiki-card formatting is available under **Settings → Sidet → Data and export** and asks for confirmation before making changes. Files are created or modified only after user confirmation.

## 8. 🌐 Webpages and Web Search

For a specific webpage, enter its URL to add the page content to the current conversation. For external research, enable web search: Sidet generates a search query, searches and reads pages as needed, then returns an answer with sources.

Knowledge-base search and web search are separate modes and cannot be enabled together. If you have already attached a note, webpage, image, or other explicit material, Sidet handles the request as a normal material-based conversation.

## 9. 📝 Conversations, Export, and Notes

Conversation history is stored in plugin data and does not create Markdown files just because a conversation has started. When you want to save something, you can:

- Export the current conversation as Markdown.
- Create a new note.
- Append to an existing note.
- Replace a selected note.
- Organize the current conversation or note into a knowledge base.

Create, append, and replace actions all show a preview and require confirmation. The export directory can be changed in settings; leaving it blank uses Sidet's default export directory.

Conversations you no longer use can be archived. Archived conversations remain read-only and can be restored or deleted from settings.

## 10. 🔐 Data and Privacy

Conversation history, plugin settings, and API keys are stored separately. The author does not collect your API keys, conversations, notes, or other personal information.

When you use a cloud model, web search, or webpage service, the content required for the request is sent through the third-party service you configured. Its fees, limits, and data practices are governed by that provider.

Sidet does not modify notes by default or run autonomous background tasks. Creating, appending, or replacing a note requires confirmation. Keep independent backups of important notes.

## 11. 📌 Current Scope

Sidet currently centers on deliberate user input, selection, and confirmation. Its web features search and reference webpages; they do not provide a full browser with an address bar, tabs, login state, and browsing history. Knowledge-base search currently uses local keywords and does not automatically aggregate across directories.

If your day-to-day work happens in Obsidian, you can start from Sidet home to ask questions, search your own knowledge, work with web material, or run common commands, then write back only the results worth keeping.

## 12. 🚀 Installation

Sidet requires Obsidian `1.11.4` or later.

### 12.1 Community Plugins

1. Open Obsidian settings and go to **Community plugins**.
2. Search for `Sidet`.
3. Install and enable the plugin.

### 12.2 BRAT

1. Install BRAT from Obsidian Community Plugins.
2. Choose **Add Beta plugin**.
3. Enter `https://github.com/jiaoyingxing/sidet`.
4. Enable Sidet in Obsidian settings after installation.

### 12.3 Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from [GitHub Releases](https://github.com/jiaoyingxing/sidet/releases).
2. Put the three files in `<your-vault>/.obsidian/plugins/sidet/`.
3. Restart Obsidian or reload community plugins.
4. Enable Sidet in settings.

## 13. 📜 License

- Sidet is distributed as closed-source software; the source code is not public.
- No source-code license is granted, and modified redistribution is not allowed.
- See [LICENSE](./LICENSE) for the full terms.

## 14. 📮 Contact

Search for “焦应行” on Xiaohongshu.
