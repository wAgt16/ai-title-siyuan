<div align="right">

[简体中文](README.zh-CN.md) · **English**

</div>

# AI Title

A SiYuan plugin that names your notes for you. Select one or more notes, and it asks your provider for a title for each one — over Chat Completions, the Responses API or Anthropic Messages — then either writes them back or lets you review first.

## Why it exists

SiYuan names a new document `Untitled`. Renaming later is a manual chore, and doing it for a folder full of notes is tedious enough that most people never get around to it.

This plugin does the naming pass for you. It reads each note's content, asks a model for a title, and writes it back through the kernel's own rename path so the document path, its child documents' paths and the search index all stay consistent.

## Features

- **Generate in bulk.** Select many notes in the document tree and title them in one action. Notes are split into batches and the batches run concurrently.
- **Review before writing.** Every title stays editable. Untick what you don't want, edit any field, or regenerate a single row.
- **Your style, not the contract.** The system and user prompts are fixed because they carry the JSON contract the plugin parses. Put your own requirements in the `{{system}}` and `{{user}}` append slots; `{{content}}`, `{{language}}` and `{{style}}` are filled in per request.
- **Three protocols.** Chat Completions, the Responses API and Anthropic Messages. Point it at any compatible endpoint, or import a provider you already configured in SiYuan — the protocol comes along with it.
- **Use a provider configured in SiYuan directly.** What a fresh install starts on: the protocol, address, key and headers all come from SiYuan, and the plugin remembers only the protocol, the provider and the model name (each stored per device, never synced). Edits made in SiYuan apply immediately.
- **Set the thinking effort.** Pick a level from disabled up to maximum — it travels as `reasoning_effort`, `reasoning.effort` or Anthropic `thinking` depending on the protocol — or send nothing and leave it to the provider.
- **Custom request headers.** Fill in a JSON object of extra headers whose values may reference SiYuan variables (`{{vars.NAME}}`) and secrets (`{{secrets.NAME}}`), resolved before every request — which is what providers such as opencode need. Importing a provider from SiYuan brings its headers along.
- **The API key is encrypted at rest.** It is sealed with SiYuan's own data repo key. Without one it is stored in plain text and the settings panel says so.
- **Built for debugging.** Debug mode dumps the full request and response to the console.

## Requirements

- SiYuan 3.8.3 or later.
- An endpoint speaking Chat Completions, the Responses API or Anthropic Messages, along with its base URL and API key — **or** an AI provider already configured in SiYuan, which is what a fresh install uses.

## Install

1. Search for `ai-title-siyuan` in the SiYuan marketplace and install it from there.
2. Or download `package.zip` from the [latest release](https://github.com/wmy2981/ai-title-siyuan/releases/latest), then in SiYuan open **Settings → Marketplace → Downloaded**, click **Install from package**, and pick that zip. Enable the plugin afterwards.

To build it yourself:

```bash
git clone https://github.com/wmy2981/ai-title-siyuan.git
cd ai-title-siyuan
npm ci
npm run build
```

That writes `package.zip` in the repository root.

## Setup

Open **Settings → Marketplace → Downloaded → AI Title → Settings**.

1. **Protocol** — defaults to **Use a SiYuan provider**: the protocol, base URL, API key and headers all come from the provider selected in SiYuan. Switch the dropdown to one of the three concrete protocols to fill those values in yourself. This one is stored per device and never synced.
2. **Provider** — shown only while **Use a SiYuan provider** is selected. Pick one of the providers already configured in SiYuan; an empty list means there are none yet. This choice and the model name are stored per device.
3. **Base URL** — with a custom protocol, include the version segment your provider documents. For Messages, stop at `/v1` — the plugin appends `/messages` itself.
4. **API Key** — leave empty if your endpoint needs no key. It is encrypted with SiYuan's data repo key before being written to disk; see below.
5. **Model** — type a name, click **Fetch models** to pick from the provider's list, or use **Import from SiYuan** to copy a provider you already configured there. With a SiYuan provider selected, clicking the field lists the models that provider registers.
6. Click **Test connection**. Any reply means the configuration works.

### Settings reference

| Group | Setting | Default | Notes |
| --- | --- | --- | --- |
| API | Protocol | Use a SiYuan provider | Protocol, base URL, API key and headers come from the provider selected in SiYuan. Switch to one of the three concrete protocols to fill the fields below in yourself. Stored per device, never synced. |
| API | Provider | *empty* | Shown only while the protocol is **Use a SiYuan provider**. Pick one of the providers configured in SiYuan; changing it also switches the model to the one that provider has enabled. The provider and model are stored per device. |
| API | Thinking effort | Default | Sent as `reasoning_effort` on Chat Completions, `reasoning.effort` on Responses, and mapped to `thinking` on Messages. **Default** sends nothing and leaves it to the provider; **Disabled** asks the model not to reason. Strict endpoints reject the parameter with a 400. |
| API | Temperature | `1.0` | `0`–`2`. Lower is more deterministic. Messages accepts `0`–`1` only, and drops the field when thinking is on. |
| API | Top P | `0.8` | Leave empty to omit from the request. Messages drops it when thinking is on. |
| API | Top K | *empty* | Omitted when empty. The official OpenAI API rejects unknown body parameters with a 400, and the Responses protocol has no such field, so only fill this in for providers that accept it. Messages takes an integer. |
| API | Max output tokens | `512` | Sent as `max_completion_tokens`, falling back to `max_tokens` if the provider rejects that name. Responses sends `max_output_tokens`; Messages sends `max_tokens` and its thinking budget comes out of it. |
| API | Custom headers | *empty* | A JSON object of extra request headers. Values may reference SiYuan variables and secrets; see below. Taken over by SiYuan and hidden on this page while the protocol is **Use a SiYuan provider**. |
| Behaviour | Timeout | `10000` ms | Per request. Batches are concurrent, so this is not a shared budget. |
| Behaviour | Retries | `1` | Only for rate limits, server errors, timeouts and network failures. |
| Behaviour | Note body limit | `1000` characters | Counts the body only: the note id and its outline are never cut. |
| Behaviour | Over-long notes | Keep the beginning | Keep the beginning, the end, both ends (split by the share below), or always send the whole body. |
| Behaviour | Beginning share | `0.5` | Shown for **Keep both ends** only: the fraction of the budget the beginning gets. |
| Behaviour | Links, images and custom blocks | Short placeholder | Replace them with tokens such as `[image]`, `[file(.pdf)]` and `[button]`, drop them, or keep them as they are. |
| Behaviour | Include the current title | On | Sends the title the note already has together with the body and the outline. |
| Behaviour | Send the note outline | Only when the body is truncated | Never, when the body was cut short, or always. The outline itself is never truncated. |
| Behaviour | Notes per request | `3` | Selecting more splits the work into batches. |
| Behaviour | Max concurrent requests | `3` | Lower it if your provider rate limits. |
| Behaviour | Apply titles automatically | Disabled | See below. |
| Behaviour | Title language | Follows the SiYuan interface language | Filled into `{{language}}`. |
| Behaviour | Title style | `简洁准确，拒绝套话` | Filled into `{{style}}`. |
| Behaviour | Ignore injected instructions | On | Adds a line to the system prompt telling the model to ignore any text in the notes that tries to interfere with, decide or influence the titles. |
| Behaviour | Extra system instructions | *empty* | Appended to the fixed system prompt through `{{system}}`. |
| Behaviour | Extra user instructions | *empty* | Appended to the fixed user prompt through `{{user}}`. |
| Interface | Toolbar button | On | |
| Interface | Breadcrumb button | Off | |
| Interface | Document tree menu | On | |
| Interface | Debug mode | Off | Logs the complete request and response bodies, and every pipeline decision. |

### Using a provider from SiYuan

A fresh install starts here: SiYuan **Settings → AI → Providers** already holds the protocol, address, key and headers, so the plugin uses that configuration instead of asking you to copy it.

- The plugin remembers only the protocol, the selected provider and the model name; the address, key and headers are read from SiYuan before every request, so edits made there apply immediately.
- **The protocol, the provider and the model name are stored per device and never synced.** SiYuan does not sync its own AI configuration, so a protocol or provider id synced from another device has nothing to point at here.
- The provider's own headers are used as well, and `{{vars.NAME}}` / `{{secrets.NAME}}` inside them follow the same rules as the plugin's custom headers.
- Temperature, thinking effort, max output tokens and the rest stay in this plugin.
- While this mode is active, **Base URL**, **API Key**, **Custom headers** and **Import from SiYuan** are hidden because SiYuan owns those values. To freeze one configuration as the plugin's own copy, switch **Protocol** to one of the three concrete protocols and use **Import from SiYuan** once.

### Custom headers

Some providers insist on headers of their own. opencode, for one, wants a stable conversation id in `x-opencode-session` plus a client-specific `User-Agent`. Fill them in as a JSON object:

```json
{
  "x-opencode-session": "{{vars.OPENCODE_GO_SESSION}}",
  "User-Agent": "my-agent/1.0"
}
```

- `{{vars.NAME}}` reads a variable and `{{secrets.NAME}}` a secret from **Settings → Secrets and variables**. Both are resolved **before every request**: the plugin stores only the reference, because another plugin may rewrite the variable per conversation.
- A secret is subject to its own allowed-hosts list. When the target host is not on it the placeholder stays as it is, so the secret is never sent to an endpoint that was not granted it. Variables carry no such restriction.
- A name that cannot be found is left as it is. Seeing `{{vars.…}}` in a provider error means the variable is misspelled or not configured.
- A header written here overrides the one the plugin sends itself — `Authorization`, for instance — so **API Key** can stay empty when the header carries the credential.
- Names must be valid header names and values must be strings; a name may not repeat case-insensitively. A malformed object is reported when you save the settings.
- **Import from SiYuan** copies the provider's headers too (the button only appears with a custom protocol). SiYuan added that field in 3.8.4, so on an older version the imported headers are simply empty.

### How the API key is stored

**The API key is encrypted with SiYuan's own data repo key before it reaches the plugin's data directory.**

- The key material comes from **Settings → Data repo key**; the plugin encrypts locally with AES-256-GCM and never writes the plain text to disk.
- **With no data repo key there is nothing to encrypt with** (SiYuan never generates one on its own), so the key is stored in plain text and the **API Key** row says so.
- **Resetting or replacing the data repo key makes old ciphertext undecryptable**: the plugin clears the stored key and tells you once, and you enter it again.
- Opening SiYuan in a browser through `http://<lan-ip>:6806` leaves no encryption available: the ciphertext is kept as it is, but you have to enter the key once more there and it is written in plain text.
- A plain-text key stored by an older version is turned into ciphertext when the plugin loads; there is nothing to do by hand.
- **Custom headers are not encrypted**; if you need a credential in there, reference SiYuan's secret store as `{{secrets.NAME}}`.

### Applying titles

| Mode | Single note | Several notes |
| --- | --- | --- |
| **Disabled** (default) | Confirmation dialog | Confirmation dialog |
| **Single note only** | Written directly | Confirmation dialog |
| **Always** | Written directly | Written directly |

Bulk-renaming documents is destructive and SiYuan's rename has no undo stack. **A failed batch still opens the dialog first**: some notes came back without a title, and that is worth seeing before applying the rest.

### Thinking effort

The **Thinking effort** setting travels differently per protocol: as `reasoning_effort` on Chat Completions, as `reasoning.effort` on Responses, and as `thinking` on Anthropic Messages. **Default** sends nothing and lets the provider decide, **Disabled** asks for no reasoning at all, and `low` through `max` ask for progressively more.

On Messages the levels map onto Anthropic's own thinking controls. Models up to Claude 4.6 get `thinking: {type: "enabled", budget_tokens: N}`, with the budget capped at half the output limit; newer models get `thinking: {type: "adaptive"}` plus `output_config.effort`, because the two generations do not accept each other's spelling. The smallest budget the API takes is 1024 tokens and it comes out of **Max output tokens**, so keep that at 2048 or more when you pick a level — below that the plugin stops with an explanation rather than sending a request the API would reject. Thinking and the sampling parameters are mutually exclusive, so **Temperature**, **Top P** and **Top K** are left out while thinking is on, and the current-generation Claude models reject them even when thinking is off.

On Chat Completions the field is part of the protocol rather than invented by a vendor: `reasoning_effort` is an OpenAI Chat Completions parameter, and DeepSeek, Ollama, Gemini 2.5, GLM, qwen3.8-max and OpenRouter all read `none` as "do not reason". The level names follow the spelling SiYuan's own AI settings use.

It is not universal, and two cases cannot be turned off at all:

- Models that always reason have no off setting (Gemini 2.5 Pro, Gemini 3, thinking-only Qwen models).
- Strict endpoints reject unknown parameters with a 400 — OpenAI's own API does, and GPT-6 Astra refuses even `none`.

You are told when it did not work. When the effort is **Disabled** and the model reasoned anyway — the response carried `reasoning_content`, or `usage` reported reasoning tokens — the run ends with a "disable thinking had no effect" notice.

That notice matters because this failure is otherwise **silent**: the request succeeds, and you keep paying tokens and latency for a reasoning trace you never asked for.

## Usage

Four entry points, all doing the same thing:

- The **toolbar button** names the note you are currently editing.
- The **breadcrumb button** in the editor does the same.
- **Right-click notes in the document tree** to name one or many. This is the bulk path.
- The **command palette** has *Generate title with AI*.

## Notes and limits

- **Content is read with `/api/export/exportMdContent`**, not from the editor buffer. Exporting produces clean Markdown without the block attribute lines that the kramdown API appends.
- **Plugin custom blocks go through the same setting.** They reach the export as a `;;;plugin-name/block-type` fence, and the short placeholder keeps the block type alone — `[button]` for a button block. Both the placeholder and the drop mode keep the block content, a whole JSON payload for a button, out of the request.
- **A note with no content is skipped** rather than sent, so the model cannot invent a title for an empty document.
- **A note the model does not return a title for is reported as a failure.** The plugin never guesses a mapping or falls back to a positional match, because that would write a title onto an unrelated note.
- **`reasoning_content` is read as a fallback** when `content` comes back empty, since some models put the entire answer there.
- **The publish service is not supported.** Publish visitors carry a read-only role, and the kernel endpoint the plugin uses requires an administrator role. `disabledInPublish` is set accordingly.
- **Encrypting the API key depends on SiYuan's data repo key.** Without one it is stored in plain text, the settings panel says so, and initializing the key switches it to encrypted storage automatically.
- **Using a SiYuan provider stores neither its address nor its key.** The plugin remembers the protocol, the provider and the model name and reads the rest per request; all three are stored per device, so deleting that provider in SiYuan — or moving to another device — asks you to pick one again.

## Troubleshooting

Enable **Debug mode** in the settings and open the console. It prints the full request body, the raw response and each pipeline decision.

| Symptom | Likely cause |
| --- | --- |
| `HTTP 404` | Wrong base URL. Check the version segment against your provider's documentation. |
| `HTTP 404` on Messages | The base URL must be the provider's *Messages* base — `https://api.anthropic.com/v1`, or `https://api.deepseek.com/anthropic` for DeepSeek. The plugin appends `/v1` and `/messages` only when they are missing, so an OpenAI-style base such as `https://api.deepseek.com` lands on `/v1/messages`, which does not exist there. `HTTP 404` alone (no body) is exactly this case. |
| `HTTP 401` | Wrong or missing API key. Messages wants `x-api-key`; the plugin sends it for every host except OpenRouter. |
| `max_completion_tokens` in an error (Chat Completions) | Your provider only accepts `max_tokens`. The plugin retries with the right name automatically; seeing this twice means the retry also failed. |
| `HTTP 400` mentioning an unknown parameter | Your provider rejects `reasoning_effort`. Set **Thinking effort** to **Default**. |
| `SiYuan provider "…" was not found` | That provider was deleted from SiYuan settings, or the current role cannot read SiYuan's AI configuration. Pick a provider again in the plugin settings. |
| `SiYuan provider "…" uses the protocol "…", which this plugin does not implement` | The provider speaks a protocol the plugin does not implement (only Chat Completions, the Responses API and Anthropic Messages are). Switch to a custom protocol and fill the address in yourself, or use another provider. |
| `SiYuan provider "…" has no base URL` | That provider has no base URL in SiYuan. Fill it in under **Settings → AI → Providers**. |
| A `{{vars.…}}` or `{{secrets.…}}` sent as-is in a custom header | The name does not exist, or the secret's allowed-hosts list does not contain the base URL's host. Secrets are substituted only on their allowed hosts. |
| `Anthropic thinking needs an output token limit of at least 2048` | A thinking level is selected while **Max output tokens** is too small. Raise it, or set **Thinking effort** to **Default**. |
| The model returns nothing | Reasoning may have consumed the whole output budget. Raise **Max output tokens** or set **Thinking effort** to **Disabled**. |
| Titles not in the language you want | Change **Title language**. It defaults to your SiYuan interface language. |

## Development

```bash
npm run dev        # rebuild on change
npm run build      # production build + package.zip
npm run test       # unit tests (vitest)
npm run typecheck  # tsc --noEmit
npm run icon       # regenerate assets/icon.png and assets/preview.png
npm run preview    # re-shoot assets/preview.png from assets/preview.html
```

`npm run icon` and `npm run preview` shoot the preview with Playwright, so run `npm install` followed by `npx playwright install chromium` once before the first preview build. Every other script works without it.

The unit tests cover what runs outside SiYuan: protocol request bodies and response parsing, body truncation, prompt rendering, settings merging and the i18n tables. Everything that needs the kernel — exporting a note, renaming a document, the settings panel — is verified by loading the plugin in SiYuan. `.github/workflows/ci.yml` runs typecheck, tests and the packaging step on every push and pull request.

## License

MIT — see [LICENSE](LICENSE).
