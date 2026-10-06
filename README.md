# Reelbatch

Bulk image and video generation for **Google Flow** (Veo 3.1, Nano Banana, Omni), plus bring-your-own-key generation through the **Gemini API** and **Replicate**. Reelbatch is a Chrome extension.

- Queue hundreds of prompts from text, CSV, DOCX, Excel, JSON or Google Sheets
- Auto-download with file-name templates and folders
- Characters (`@Mia`), chaining, image→video, variations `{a|b}`
- Credit budget guard, retries, cooldowns, scheduler, several tabs in parallel
- History with storyboard view and ZIP export

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/kifobjipkpmbmjnfodcoahbpomeebjhe)** · Free: 30 prompts a day · Pro: [$9/month](https://adcktools.lemonsqueezy.com/checkout/buy/52a55fe3-c97c-47d6-937d-e57a9755bdc4?enabled=2195723) or [$69 once](https://adcktools.lemonsqueezy.com/checkout/buy/632428be-3613-4f8c-b79b-14187472707f?enabled=2195724)

[Privacy policy](PRIVACY.md) · [Report a problem](https://github.com/adck8888/reelbatch/issues/new)

## Remote selector config

`config/flow.json` describes Flow's page layout: selectors, labels and step recipes. When Flow changes its UI, this file is updated and every installed copy picks it up within hours, with no store review. It holds data only, never code.

## Development

```bash
npm install
npm run build      # dist/ — load it via chrome://extensions → Load unpacked
npm test
npm run package    # reelbatch-<version>.zip for the Web Store
```

Translations: `node scripts/i18n-keys.mjs` lists the UI strings and reports which keys each `src/panel/locales/*.json` file is missing.
