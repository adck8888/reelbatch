# Reelbatch Privacy Policy

_Last updated: 2 October 2026_

Reelbatch is a Chrome extension that runs batches of image and video prompts in Google Flow, or through AI providers using your own API keys. This policy explains what data the extension handles and where that data goes.

## Summary

- Reelbatch has **no server**. We do not collect, receive, store, sell or share your prompts, images, videos, API keys or browsing data.
- Everything you create in Reelbatch stays in your browser's local extension storage: queues, characters, history, settings and keys.
- Network requests go only to the services listed below, and only to do what you asked.

## Data stored on your device

| Data | Purpose | Where |
| --- | --- | --- |
| Prompts, queues, characters, reference images | Running your batches | `chrome.storage.local` and IndexedDB in your browser |
| Generation history and thumbnails | The History tab and re-runs | IndexedDB in your browser |
| Gemini / Replicate API keys (optional) | Calling those APIs on your behalf | `chrome.storage.local` in your browser |
| Licence key and its status | Unlocking Pro | `chrome.storage.local` in your browser |
| Settings and daily usage counter | Preferences and the free daily limit | `chrome.storage.local` in your browser |
| Trial start date | Keeps the 7-day trial from restarting after a reinstall | `chrome.storage.sync`, synced to your Chrome profile by Google |

You can delete all of it at any time. Use **Settings → Diagnostics**, clear History, or remove the extension.

## Services Reelbatch talks to

- **Google Flow (flow.google.com, flow-content.google).** Reelbatch fills in and submits prompts in your open Flow tab, then downloads the results you generate. This happens under your own Google account, as if you were doing it by hand.
- **Google Gemini API (generativelanguage.googleapis.com).** Used only if you add your own Gemini key. Your prompts and reference images go to Google to generate media. Google's terms and privacy policy apply.
- **Replicate (api.replicate.com, replicate.delivery).** Used only if you add your own Replicate key. Your prompts and reference images go to Replicate. Replicate's terms and privacy policy apply.
- **Google Sheets (docs.google.com).** Used only when you import a sheet, and only after you grant that optional permission. Reelbatch downloads the sheet's CSV export.
- **Lemon Squeezy (api.lemonsqueezy.com).** Used when you activate a Pro licence. Your licence key and an instance name go to Lemon Squeezy to check the licence. Payments are handled entirely by Lemon Squeezy.
- **GitHub (raw.githubusercontent.com).** Reelbatch downloads a small public configuration file that describes Google Flow's page layout. No data about you is sent beyond a normal web request.

## Permissions

- **debugger:** sends real clicks and key presses to the Flow tab. Flow ignores synthetic page events. Chrome shows a "started debugging this browser" bar while this is active. Reelbatch uses this only on flow.google.com tabs during a run.
- **downloads:** saves generated files into the folders and with the names you choose.
- **scripting and content scripts on flow.google.com:** read and fill in the Flow editor.
- **storage, unlimitedStorage:** keep your queues, history and reference images locally.
- **power:** keeps the computer awake while a batch runs, released when the run ends.
- **sidePanel, alarms, notifications, offscreen:** the side panel UI, scheduled runs and licence checks, finish notifications, and in-browser ZIP and thumbnail creation.

## Analytics

Reelbatch contains no analytics, tracking pixels, advertising or third-party trackers.

## Children

Reelbatch is not directed at children under 13.

## Changes

If this policy changes, the new version will be published at this address with a new date.

## Contact

Open an issue at https://github.com/adck8888/reelbatch/issues
