# Chrome Web Store listing

**Name:** Reelbatch – Batch Image & Video Generator for Google Flow
**Category:** Productivity → Tools (alt: Art & Design)
**Language:** English (plus 7 localised names and descriptions in `_locales`)

## Summary (132 characters max)

Run hundreds of image and video prompts in Google Flow or with your own Gemini/Replicate key. Auto-download, characters, chaining.

## Description

Reelbatch turns Google Flow into a batch studio. Paste or import a list of prompts and press Run. Reelbatch submits them one by one, or several at once, and saves every image and video with the file names you choose.

It is built for people who generate at volume: video channels, ad studios, storyboard artists, online shops and anyone testing many prompts.

### Bulk generation in Google Flow
• Queue hundreds of prompts: paste them or import a text file or spreadsheet
• Use any image or video model your Flow plan includes
• Text-to-video, start and end frames, and reference images
• Images and videos in one queue: turn any row into a video with one click
• Change the model, aspect ratio or length for a single row
• See the credit cost of the whole run on the Run button before you press it
• Automatic downloads with your own file-name template and folders

### Your own API keys (optional)
Prefer to pay per use? Connect your own Google AI or Replicate key and generate without Flow. You pay the provider directly; there is no markup and no middle server.

### Animate photos in bulk (Pro)
Drop a folder of photos, write one motion prompt and get one video per photo, named after the source file.

### Consistency and storytelling
• Characters: mention @Mia in a prompt and her reference images are attached automatically
• Chaining: each clip starts from the last frame of the previous one
• Turn a generated still into a video with a motion prompt
• Variations: "a {red|blue} car" expands into one prompt per option

### Safe, unattended runs
• A credit budget stops the run before it spends more than you allow
• Smart retries, a cooldown when Flow asks you to slow down, and a pause when credits run out
• Keeps the computer awake during a run, and a scheduler starts a queue overnight
• Stop at any time and continue later with the prompts that did not run

### And more
• AI prompt helper: turn an idea or a script into a list of prompts
• Results gallery with search, re-run and ZIP export
• A CSV log of every output with its prompt, status and cost
• Interface in 8 languages

### Free and Pro
Free: Google Flow, 30 prompts a day, one at a time, automatic downloads.
Pro ($9/month or $69 once): no daily limit, parallel runs, your own API keys, photo animation, characters, chaining, the scheduler, the AI helper and ZIP export. A 7-day Pro trial is included and needs no card.

### FAQ
Why does Chrome show "Reelbatch started debugging this browser"? Flow only reacts to real clicks and key presses. Reelbatch uses Chrome's debugger interface on the Flow tab, only while a batch runs, to press Generate for you. The bar disappears when the run ends, and closing it pauses the run.
Do I need a paid Flow plan? No. Reelbatch uses the credits of whatever Flow plan you have. Pro unlocks features in Reelbatch, not Flow credits.
What if Flow changes its page? Reelbatch reads a small public configuration file, so most layout changes are fixed within hours without a store update. Report problems at https://github.com/adck8888/reelbatch/issues
Will it spend my credits by surprise? No. Set a credit budget and Reelbatch stops before it is reached. Each prompt is sent once, and a failure after sending is never retried automatically.

### Privacy
Reelbatch has no server. Your prompts, files and keys stay in your browser. Licence checks go to Lemon Squeezy, and the Flow layout file comes from GitHub. Privacy policy: https://github.com/adck8888/reelbatch/blob/main/PRIVACY.md

Reelbatch is an independent tool and is not affiliated with or endorsed by Google or Replicate. Google and Flow are trademarks of Google LLC. You are responsible for following the terms of the services you use.

## Single purpose

Batch-generate images and videos from a list of prompts: in Google Flow through its web interface, or through the user's own AI provider API keys. Downloads the results with organised file names.

## Permission justifications

- **debugger:** Google Flow ignores synthetic (untrusted) clicks and key presses on its Generate button. Reelbatch attaches the Chrome DevTools protocol only to flow.google.com tabs, and only while a batch runs, to send the trusted input events a user would. It detaches when the run ends.
- **downloads:** saves each generated image or video with the user's file-name template and folder.
- **scripting:** injects the Flow driver into an already-open Flow tab after the extension is installed or updated, without a reload.
- **storage / unlimitedStorage:** queues, history thumbnails and reference images are kept locally in IndexedDB and can exceed the default quota.
- **sidePanel:** the main UI.
- **alarms:** scheduled runs and periodic licence checks.
- **notifications:** tells the user when a batch finishes or needs attention.
- **power:** keeps the computer from sleeping while a batch runs (released when it ends), so overnight runs finish.
- **offscreen:** builds ZIP archives, thumbnails and video frames (for chaining) from blobs, which a service worker cannot do.
- **Host flow.google.com, flow-content.google:** drive Flow and fetch the generated media the user created.
- **Host generativelanguage.googleapis.com, api.replicate.com, replicate.delivery:** call the providers with the user's own keys and fetch the results.
- **Host api.lemonsqueezy.com:** licence activation and validation.
- **Host raw.githubusercontent.com:** download the public selector configuration so a Flow layout change can be fixed without a store update. It is data only; no code is loaded remotely.
- **Host googleusercontent.com, storage.googleapis.com:** Flow and the Gemini API serve generated media (upscaled downloads, finished videos) from these hosts.
- **Optional docs.google.com:** requested only when the user imports a Google Sheet.

**Remote code:** No. All code is in the package; the remote file is JSON data (CSS selectors and text labels).

**Data usage disclosures:** tick **Authentication information** (the Pro licence key goes to Lemon Squeezy; optional Gemini/Replicate API keys go to those providers) and **Website content** (your prompts and reference images go to Google Flow, or to Gemini/Replicate in API mode). Everything else: not collected. Then tick all three certifications: data is used only for the extension's single purpose, not sold, not used for creditworthiness or lending.

## Assets to prepare
- Icon 128×128: public/icons/128.png
- Screenshots 1280×800, in this order: store/assets/screenshot-1.png (queue with the cost on Run), screenshot-2.png (run in progress), screenshot-3.png (Results gallery), screenshot-4.png (per-row settings), screenshot-5.png (safety settings). Made from a real test run on 2026-10-03.
- Small promo tile 440×280: store/assets/promo-small-440x280.png
- Marquee 1400×560: store/assets/promo-marquee-1400x560.png
