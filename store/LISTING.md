# Chrome Web Store listing

**Name:** Reelbatch — Bulk Veo & Nano Banana for Google Flow
**Category:** Productivity → Tools (alt: Art & Design)
**Language:** English (plus 7 localised names and descriptions in `_locales`)

## Summary (132 characters max)

Run hundreds of image and video prompts in Google Flow or with your own Gemini/Replicate key. Auto-download, characters, chaining.

## Description

Reelbatch turns Google Flow into a batch studio. Paste or import hundreds of prompts and press Run. Reelbatch submits them one by one, or several at once, and saves every image and video with the file names you choose.

**Built for people who generate at volume:** YouTube and TikTok channels, ad and UGC studios, storyboard artists, e-commerce teams and prompt testers.

### Bulk generation in Google Flow
• Queue unlimited prompts: paste them, or import from TXT, CSV, DOCX, Excel, JSON or Google Sheets
• Nano Banana 2, Nano Banana Pro, Veo 3.1 (Lite, Fast, Quality) and Omni 1.1 Flash
• Text-to-video, frames-to-video (start and end frame) and ingredients (reference images)
• Per-row overrides for model, aspect ratio, outputs, duration and resolution
• Auto-download with templates such as {n}_{prompt}_{model}, in folders per queue or per run
• Upscaled downloads (2K/4K images, 1080p video) when Flow offers them

### Your own API keys (optional)
• Gemini API: Veo 3.1 and Nano Banana via your Google AI key
• Replicate: Kling 3.0, Seedance 2.0, Hailuo 2.3, FLUX.2, GPT Image 2, Ideogram 3 and more
• You pay the provider directly at their prices. No markup, no middle server.

### Consistency and storytelling
• Characters: write @Mia in any prompt, and her reference images and description are attached automatically
• Chaining: each clip starts from the last frame of the previous one
• Image→video pipeline: generate a still, then animate it with a motion prompt
• Variations: "a {red|blue} car at {dawn|night}" expands into 4 prompts

### Safe, unattended runs
• Credit budget guard: stops before spending more Flow credits or dollars than you allow
• Smart retries, a cooldown when Flow reports unusual activity, and a pause when you run out of credits
• Human-like pacing and several Flow tabs in parallel
• Scheduler: start a queue overnight
• Resume after a browser restart

### And more
• AI prompt helper: idea → prompts, script → scenes, variations, improve, translate
• History with storyboard view, search, re-run and ZIP export
• CSV sidecar with prompt, model, seed and file name for every output
• 8 languages: English, Русский, Español, Português, Tiếng Việt, हिन्दी, Bahasa Indonesia, Türkçe

### Free and Pro
**Free:** Google Flow, 50 prompts a day, one at a time, auto-download, TXT/CSV/DOCX import.
**Pro ($9/month or $69 once):** unlimited prompts, parallel runs and several tabs, API engines, characters, chaining, image→video, upscaled downloads, scheduler, AI helper, Sheets/Excel/JSON import, ZIP export.
A 7-day Pro trial is included and needs no card.

### Privacy
Reelbatch has no server. Your prompts, files and keys stay in your browser. Privacy policy: https://github.com/adck8888/reelbatch/blob/main/PRIVACY.md

Reelbatch is an independent tool and is not affiliated with or endorsed by Google, Replicate or any model provider. You are responsible for following the terms of the services you use.

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
- **offscreen:** builds ZIP archives, thumbnails and video frames (for chaining) from blobs, which a service worker cannot do.
- **Host flow.google.com, flow-content.google:** drive Flow and fetch the generated media the user created.
- **Host generativelanguage.googleapis.com, api.replicate.com, replicate.delivery:** call the providers with the user's own keys and fetch the results.
- **Host api.lemonsqueezy.com:** licence activation and validation.
- **Host raw.githubusercontent.com:** download the public selector configuration so a Flow layout change can be fixed without a store update. It is data only; no code is loaded remotely.
- **Optional docs.google.com, googleusercontent.com, storage.googleapis.com:** requested only when the user imports a Google Sheet or a reference image from those hosts.

**Remote code:** No. All code is in the package; the remote file is JSON data (CSS selectors and text labels).

**Data usage disclosures:** collects none. Tick "I do not sell or transfer user data…" and all three certifications.

## Assets to prepare
- Icon 128×128: public/icons/128.png
- Screenshots 1280×800 (up to 5): queue with a running batch over Flow; import dialog with Sheets mapping; characters; history storyboard; settings and budget guard
- Small promo tile 440×280
