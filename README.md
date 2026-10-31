<div align="right">

[简体中文](README.zh-CN.md) · **English**

</div>

# AI Title

A SiYuan plugin that names your notes for you. Select one or more notes, and it asks your provider for a title for each one — over Chat Completions, the Responses API, Anthropic Messages or Gemini Interactions — then either writes them back or lets you review first.

## Why it exists

SiYuan names a new document `Untitled`. Renaming later is a manual chore, and doing it for a folder full of notes is tedious enough that most people never get around to it.

This plugin does the naming pass for you. It reads each note's content, asks a model for a title, and writes it back through the kernel's own title APIs so the document path, its child documents' paths and the search index all stay consistent.

## Features

- **Generate in bulk.** Select many notes in the document tree and title them in one action. Notes are split into batches and the batches run concurrently.
- **Review before writing.** Every title stays editable: untick what you don't want, edit any row, or regenerate a single row.
- **Four protocols.** Chat Completions, the Responses API, Anthropic Messages and Gemini Interactions. Point it at any compatible endpoint, or import a provider you already configured in SiYuan — the protocol comes along with it.
- **Use a provider configured in SiYuan directly.** What a fresh install starts on: the protocol, address, key and headers all come from that entry in SiYuan.
- **Set the thinking effort.** Pick a level from disabled up to maximum, or send nothing and leave it to the provider.
- **The API key is encrypted at rest.** It is sealed with SiYuan's own data repo key. Without one it is stored in plain text and the settings panel says so.

## Requirements

- SiYuan 3.8.3 or later.
- An endpoint speaking Chat Completions, the Responses API, Anthropic Messages or Gemini Interactions, along with its base URL and API key — **or** an AI provider already configured in SiYuan.

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

1. **Protocol** — defaults to **Use a SiYuan provider**: the protocol, base URL, API key and headers all come from the provider selected in SiYuan. Switch the dropdown to one of the four concrete protocols to fill those values in yourself. This one is stored per device and never synced.
2. **Provider** — shown only while **Use a SiYuan provider** is selected. Pick one of the providers already configured in SiYuan; an empty list means there are none yet.
3. **Base URL** — with a custom protocol, include the version segment your provider documents. For Messages, stop at `/v1` — the plugin appends `/messages` itself. For Interactions, stop at `/v1beta`; the plugin appends `/interactions`.
4. **API Key** — leave empty if your endpoint needs no key. It is encrypted with SiYuan's data repo key before saving; see below.
5. **Model** — type a name, click **Fetch models** to pick from the provider's list, or use **Import from SiYuan** to copy a provider you already configured there. With a SiYuan provider selected, clicking the field lists the models that provider registers.
6. Click **Test connection**. Any reply means the configuration works.

### Custom headers

Some providers insist on headers of their own. opencode, for one, wants a stable conversation id in `x-opencode-session` plus a client-specific `User-Agent`. Fill them in under **Custom headers** as a JSON object:

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

| Mode                   | Single note         | Several notes       |
| ---------------------- | ------------------- | ------------------- |
| **Disabled** (default) | Confirmation dialog | Confirmation dialog |
| **Single note only**   | Written directly    | Confirmation dialog |
| **Always**             | Written directly    | Written directly    |

Bulk-renaming documents is destructive and SiYuan's rename has no undo stack. **A failed batch still opens the dialog first**: some notes came back without a title, and that is worth seeing before applying the rest.

Titles may contain inline Markdown. On SiYuan 3.8.10 and later a title with inline Markdown is written as a rich-text title source, so bold, italic, code and links render as such; a plain-title document is upgraded to the rich format when that happens (older SiYuan clients may not read that document), and stays plain — a plain rename — when the title has no Markdown. Older SiYuan versions cannot store rich titles, so the markers are stripped before renaming there. When the generated text matches the current title text the title is left untouched; otherwise the whole title is replaced with the generated one.

## Usage

Four entry points, all doing the same thing:

- The **toolbar button** names the note you are currently editing.
- The **breadcrumb button** in the editor does the same.
- **Right-click notes in the document tree** to name one or many. This is the bulk path.
- The **command palette** has _Generate title with AI_.

## Troubleshooting

Enable **Debug mode** in the settings and open the console: it shows the full request body, the raw response and each pipeline decision.

| Symptom                                                           | Likely cause                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HTTP 404`                                                        | Wrong base URL. Messages wants the provider's Messages base (`https://api.anthropic.com/v1`; DeepSeek uses `https://api.deepseek.com/anthropic`), Interactions wants Gemini's version segment (e.g. `https://generativelanguage.googleapis.com/v1beta`). The plugin only appends `/v1`, `/messages`, `/v1beta` and `/interactions` when they are missing. |
| `HTTP 401`                                                        | Wrong or missing API key. Messages wants `x-api-key`; the plugin sends it for every host except OpenRouter.                                                                                                                                                                                                                                               |
| `HTTP 400` mentioning an unknown parameter                        | Your provider rejects `reasoning_effort`. Set **Thinking effort** to **Default**.                                                                                                                                                                                                                                                                         |
| `max_completion_tokens` in an error                               | Your provider only accepts `max_tokens`. The plugin retries under the right name; seeing it twice means the retry failed too.                                                                                                                                                                                                                             |
| A `SiYuan provider "…"` error                                     | The provider was deleted from SiYuan, the current role cannot read SiYuan's AI configuration, it has no base URL, or its protocol is not implemented. Fix it under **Settings → AI**, or pick another provider in the plugin.                                                                                                                             |
| `SiYuan has no default model …`                                   | A **Follow … default** option is selected but SiYuan has no default model in that spot. Set one under **Settings → AI**.                                                                                                                                                                                                                                  |
| A `{{vars.…}}` or `{{secrets.…}}` sent as-is in a request header  | The name does not exist, or the secret's allowed-hosts list does not contain the base URL's host.                                                                                                                                                                                                                                                         |
| `Anthropic thinking needs an output token limit of at least 2048` | A thinking level is on while **Max output tokens** is below 2048. Raise it, or set **Thinking effort** to **Default**.                                                                                                                                                                                                                                    |
| The model returns nothing                                         | Reasoning may have consumed the whole output budget. Raise **Max output tokens** or set **Thinking effort** to **Disabled**.                                                                                                                                                                                                                              |
| Titles not in the language you want                               | Change **Title language**. It defaults to your SiYuan interface language.                                                                                                                                                                                                                                                                                 |

## Bazaar Stats Graph

![Bazaar stats graph](https://siyuan-bazaar-stats-graph.sr1.cc.cd/api/chart/wmy2981/ai-title-siyuan?metrics=downloads,rating,ratings&range=all&area=true&lang=en)

## Development

```bash
npm run dev        # rebuild on change
npm run build      # production build + package.zip
npm run test       # unit tests (vitest)
npm run typecheck  # tsc --noEmit
npm run icon       # regenerate assets/icon.png and assets/preview.png
npm run preview    # re-shoot assets/preview.png from assets/preview.html
```

## License

[MIT](./LICENSE)
