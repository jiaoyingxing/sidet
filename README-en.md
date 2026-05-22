[简体中文](./README.md)

# Sidet

I did not build Sidet just to make another plugin that can call a model.

What I kept seeing was this: many AI plugins have a lot of features, but they are still awkward to use. In Obsidian, a lot of them are basically narrow side panels. The input area is small, the reading area is small, and the whole thing feels cramped. On mobile, that gets worse.

What I actually wanted was simpler. I wanted to pull Obsidian's scattered entry points into one more natural main work surface. When someone opens Sidet, they should feel where to go next instead of facing a pile of features and settings first.

For me, Sidet is not mainly about "chat as a feature". It is about these things:

- conversation as the main work surface
- conversation itself as part of the record
- the knowledge base as a later layer that grows out of use

## Why it looks like this

I borrowed a lot from the way modern AI apps already work. The active conversation should have enough room, so Sidet keeps the current chat in the main workspace instead of squeezing it into a thin side pane. The side dock is used as the conversation list, which makes switching chats much more natural.

Obsidian also has a lot of scattered entry points. I want Sidet to gradually become a center people can come back to, both to continue thinking and to move naturally into the next action.

## The modules that are already part of this flow

### 1. Conversation work surface

- the active conversation lives in the main workspace
- the side dock is used as the conversation list
- conversations support search, pinning, and folders
- new tabs can return you to Sidet
- the home page can pin common commands as quick entry points

These may not look like "big features", but they decide whether the product is actually usable every day.

### 2. Bringing context in

One thing I care about a lot is that people should not have to keep moving material around by hand. They should be able to bring it directly into the current conversation and keep thinking.

Right now Sidet can bring in:

- the current note
- the current selection
- related notes
- a folder summary
- a webpage
- an image

Once these are in the conversation, the user can keep asking, sorting, and refining around them.

### 3. Conversation history and write-back

I do not want the result to be either "nothing gets kept" or "the plugin writes into the vault by default".

So Sidet currently supports:

- keeping and revisiting conversation history
- exporting the current conversation
- previewing write-back before anything is written
- creating, appending, or replacing Markdown notes only after confirmation

This part matters a lot to me. AI can help organize your material, but it should not take over your vault.

### 4. The knowledge-base side

Sidet's main axis is still AI. It is not a knowledge-base product first.

But the way I think about this side is that knowledge should not start as manual filing. It should grow out of use. You can bring notes, links, and images into the conversation, turn them into your own understanding, and then decide what should go into `Sidet/Wiki` and what should stay in the conversation.

The parts already connected here include:

- organizing the current conversation into the knowledge base
- organizing the current note into the knowledge base
- creating `Index.md` for a folder
- using `Index.md` as a clearer knowledge-base entry point

I do not want to describe this as "one more knowledge feature". I think the better way to say it is that it helps your knowledge base come alive.

### 5. Mobile

I do not accept the idea that "desktop works and mobile can just be good enough".

Sidet treats mobile as a real use case from the beginning. Desktop and mobile are not supposed to be the same layout shrunk down. On a phone, it still needs to be easy to enter, easy to continue, and easy to keep one useful result.

## What I care about most is not more features, but whether it feels natural

I think software is moving toward a different direction. It is not about exposing more and more features. It is about letting people use more capability in a smoother and more natural way.

That is the direction behind Sidet too. I am not trying to make Obsidian more complicated. I am trying to make the AI side of Obsidian feel more direct and more usable. You can work through your thoughts in conversation, and you can also bring in notes, knowledge material, images, and links while you think, sort, and keep things.

Conversation is not the thing that happens before the real note. Conversation is already where the record, the thinking, and the new ideas happen.

## Who it fits

If you already spend a lot of time reading, writing, collecting, and organizing inside Obsidian, and you want AI to stay close to that workflow, Sidet will probably fit you.

It fits people who:

- do not want to leave Obsidian and restart in another AI app
- care about conversation history being reusable
- need folders, search, and pinning for chat management
- want mobile to be genuinely usable, not just technically supported
- want valuable results to settle into the vault without chat polluting it by default

If what you want is a heavy agent platform, a wall of parameters, and a lot of background automation, Sidet is not built on that line.

## Installation

Sidet is currently distributed through GitHub Releases and [BRAT](https://github.com/TfTHacker/obsidian42-brat), so you cannot install it from the Community Plugins browser right now.

If you just want to try it quickly, BRAT is usually the fastest path. If you want release files and version notes, check [Releases](https://github.com/jiaoyingxing/sidet/releases).

## License

Sidet is currently distributed as closed-source software. Official release files are free to use, but no source code license is granted and modified redistribution is not allowed. See [LICENSE](./LICENSE).
