---
name: sevoke-image
description: Use this skill whenever the user asks to generate, edit, inpaint, restyle, or create bitmap images through an OpenAI-compatible Images API from Codex. This skill calls /images/generations or /images/edits directly with a configurable image model (gpt-image-2.5-flare by default), saves base64 image results to files, uses no npm or pip dependencies, works on Linux/macOS/Windows with either Node.js 18+ or Python 3, and uses Sevoke-specific API settings when configured before falling back to Codex settings.
---

# Sevoke Image

Use this skill to create or edit images through an OpenAI-compatible Images API. The bundled scripts directly call `POST /images/generations` for new images and `POST /images/edits` for edits or inpainting. The request model is `gpt-image-2.5-flare` by default and is sent as the top-level `model` field; there is no outer Responses API model or `image_generation` tool call. The scripts handle config discovery, API calls, base64 decoding, and output files consistently.

## Model Selection

- Use the API model ID `gpt-image-2.5-flare` by default.
- If the user's request explicitly provides a canonical API model ID, pass that exact identifier through `--image-model <model>` for both generation and editing.
- When the request says `2.5` or `Flare` without another variant, use `gpt-image-2.5-flare`. When it says `Sunburst`, use `gpt-image-2.5-sunburst`.
- Normalize display names such as `GPT-Image-2.5 Flare` and `GPT-Image-2.5 Sunburst` to their canonical API model IDs before passing `--image-model`.
- Preserve an explicitly provided canonical API model identifier exactly, including its capitalization and punctuation.
- Treat model selection as invocation metadata. Do not leave the model-selection instruction in the visual prompt sent to the Images API.
- Do not use the Codex top-level `model` or `--response-model` to select the image model.

## Runtime And Dependencies

- Preferred runtime: Node.js 18+ with `scripts/generate-image.mjs`.
- Fallback runtime: Python 3 with `scripts/generate-image.py` when Node is unavailable.
- The Node script uses only built-in modules: `fs`, `os`, and `path`, plus built-in `fetch`.
- The Python script uses only the standard library: `urllib`, `json`, `base64`, `pathlib`, and related built-ins.
- Does not require `npm install`, `pip install`, the OpenAI SDK, curl, jq, or base64 shell utilities.
- Works on Linux, macOS, and Windows when run as `node <skill-dir>/scripts/generate-image.mjs ...` or `python3 <skill-dir>/scripts/generate-image.py ...`.
- Do not rely on executable bits, shebang behavior, or Bash line continuations for Windows usage.
- The scripts print progress messages to stderr while waiting for the API; stdout remains reserved for the final file summary or `--json` output.

## Source Of Credentials

The default post-install flow uses a terminal opened by the user. Codex must not try to open a terminal automatically:

1. Print the absolute installed skill directory.
2. Print the absolute path to `scripts/install-sevoke.mjs` and a quoted, copyable command.
3. Based on the current OS, print the matching terminal shortcut: Windows `Win + R`, type `powershell`, Enter; macOS `Command + Space`, search `Terminal`, Enter; Linux `Ctrl + Alt + T`. Do not list unrelated platform shortcuts.
4. Ask the user to open the terminal with that shortcut and paste the command.
5. The installer asks for the API URL visibly and collects the API key through hidden local input.
6. Ask the user to fully restart Codex after the installer succeeds.
7. Never ask the user to send an API key in chat. Never print, log, commit, or summarize credential values.

When the user has just installed the skill and asks for setup help, guide them with this prompt:

```text
请引导我完成 Sevoke 图片生成技能配置。不要尝试替我自动打开终端，我会自己打开终端并执行命令：输出已安装技能的完整目录；输出 scripts/install-sevoke.mjs 的完整路径和带引号的可复制 node 命令；根据我的电脑系统给出打开终端的快捷键（Windows：Win + R 后输入 powershell；macOS：Command + Space 搜索 Terminal；Linux：Ctrl + Alt + T），只显示当前系统对应的方式；告诉我打开终端后粘贴命令；说明安装器会先询问 API URL，再隐藏输入 API key；不要让我在聊天中发送 API key；安装完成后告诉我重启 Codex，并给出 --dry-run 验证命令。
```

The bundled `scripts/install-sevoke.mjs` is the default setup method. Do not invoke it automatically from Codex; the user must run it in their own local interactive terminal so the API key can be entered locally. After the user confirms that the installer completed, use `generate-image.mjs --dry-run` when execution is available and report only redacted configuration status.

Use Sevoke-specific environment variables when available, then fall back to Codex's API configuration:

The installed config.json is used when the Sevoke environment variables are not set.

- `--base-url` is the highest-priority request URL override, followed by `SEVOKE_IMAGE_API_URL`.
- `--api-key-env` selects the highest-priority key environment variable; its default is `SEVOKE_IMAGE_API_KEY`.
- The installed `config.json` supplies `apiUrl` and `apiKey` when the corresponding explicit override is absent.
- Do not print, log, commit, or summarize either credential value.
- Do not put the key in the skill files, chat prompts, or command-line arguments.

- Read `$CODEX_HOME/config.toml` when `CODEX_HOME` is set.
- Otherwise read `<home>/.codex/config.toml`; this maps to `~/.codex` on Linux/macOS and `%USERPROFILE%\.codex` on Windows.
- Use the top-level `model_provider` and that provider's `[model_providers.<name>]` table.
- Use provider `base_url` as the API URL when `SEVOKE_IMAGE_API_URL` and the installed Sevoke `config.json` do not specify one.
- The image request uses `gpt-image-2.5-flare` as its top-level `model` by default. Do not use the Codex top-level `model` as an outer request model.
- Read `OPENAI_API_KEY` from the matching `auth.json` when no Sevoke key or config.json key is configured.
- Do not ask the user for an API key when Codex config is available.
- Do not print, log, commit, or summarize credential values.
- Do not read or display `auth.json` yourself during normal use; let the bundled script read it inside the child process.
- Do not pass secret values on the command line. The scripts intentionally reject `--api-key <value>`.

If the Codex config is unavailable, the script falls back to `OPENAI_BASE_URL` and `OPENAI_API_KEY`. Environment variable lookup is case-insensitive so Windows variants such as `sevoke_image_api_key` still resolve. Treat this as a fallback, not the normal path.

If the user keeps the key in a different environment variable, pass only the variable name:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "A quick test image" \
  --out outputs/test.png \
  --api-key-env MY_SEVOKE_IMAGE_API_KEY
```

PowerShell example for a current-session variable:

These examples use placeholders. Do not paste real API keys into agent chats, logs, or committed files.

```powershell
$env:OPENAI_API_KEY = "<your-api-key>"
node <skill-dir>\scripts\generate-image.mjs --prompt "A quick test image" --out outputs\test.png
```

`cmd.exe` example for a current-session variable:

```bat
set OPENAI_API_KEY=<your-api-key>
node <skill-dir>\scripts\generate-image.mjs --prompt "A quick test image" --out outputs\test.png
```

## Long-Running Behavior

Treat image generation and editing as long-running operations. A normal request can take several minutes, especially for high quality, image edits, multiple inputs, or slow compatible providers.

- Run exactly one generation command for a user request, then wait for that command to finish.
- Do not start a second generation just because the command has not returned quickly, has only printed progress messages, or appears idle.
- If your shell tool exposes a running session, poll or wait on the existing session instead of launching the same command again.
- Rerun only after the command exits with an error, the user explicitly asks for another variation, or you intentionally change the prompt/settings.
- Treat `[image-generation] Still waiting...` messages as healthy progress, not as a failure condition.
- Use `--no-progress` only when stderr must stay silent; otherwise leave progress enabled so long requests are visibly alive.

## Default Workflow

1. Clarify only missing creative requirements that materially affect the image, such as subject, style, aspect ratio, or output filename.
2. Prefer saving generated files under a local output directory such as `outputs/` unless the user named a path.
3. Run one bundled script once and wait for it to complete. Prefer Node when available:

   ```bash
   node <skill-dir>/scripts/generate-image.mjs \
     --prompt "A precise image prompt" \
     --out outputs/result.png \
     --size 1024x1024 \
     --quality high
   ```

   If Node is unavailable, use the Python fallback with the same options:

   ```bash
   python3 <skill-dir>/scripts/generate-image.py \
     --prompt "A precise image prompt" \
     --out outputs/result.png \
     --size 1024x1024 \
     --quality high
   ```

   On Windows, if `python3` is not available but the Python launcher is installed, use `py -3`:

   ```powershell
   py -3 <skill-dir>\scripts\generate-image.py `
     --prompt "A precise image prompt" `
     --out outputs\result.png `
     --size 1024x1024 `
     --quality high
   ```

4. If network access is restricted, request the narrowest command approval needed to run the script. Explain that the command calls the user's configured OpenAI-compatible API endpoint.
5. Report the created image path and key generation settings. Do not include raw response JSON unless debugging is needed.

For Windows PowerShell, use backticks for line continuation or put the command on one line:

```powershell
node <skill-dir>\scripts\generate-image.mjs `
  --prompt "A precise image prompt" `
  --out outputs\result.png `
  --size 1024x1024 `
  --quality high
```

For `cmd.exe`, prefer one line:

```bat
node <skill-dir>\scripts\generate-image.mjs --prompt "A precise image prompt" --out outputs\result.png --size 1024x1024 --quality high
```

If Node is not installed on Windows but Python is available:

```bat
py -3 <skill-dir>\scripts\generate-image.py --prompt "A precise image prompt" --out outputs\result.png --size 1024x1024 --quality high
```

If neither Node nor Python is available, stop and tell the user one local runtime is required. Do not try to install one unless the user explicitly approves it.

## Common Commands

Generate a new image:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "A product photo of a matte black ceramic mug on a walnut desk, soft window light" \
  --out outputs/mug.png \
  --size 1024x1024 \
  --quality high
```

Same command with Python fallback:

```bash
python3 <skill-dir>/scripts/generate-image.py \
  --prompt "A product photo of a matte black ceramic mug on a walnut desk, soft window light" \
  --out outputs/mug.png \
  --size 1024x1024 \
  --quality high
```

Generate with transparent background:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "A clean app icon of a folded paper crane, centered, no text" \
  --out outputs/icon.png \
  --background transparent \
  --format png
```

Edit or restyle from an input image:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "Restyle this image as a polished editorial illustration while preserving the composition" \
  --image reference.png \
  --action edit \
  --input-fidelity high \
  --out outputs/restyled.png
```

Use a mask for inpainting when the API supports it:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "Replace the masked area with a glass vase of yellow flowers" \
  --image room.png \
  --mask mask.png \
  --action edit \
  --out outputs/inpainted.png
```

Preview the resolved config and request body without calling the API:

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "A quick test image" \
  --out outputs/test.png \
  --dry-run
```

## Supported Options

The script maps common OpenAI Images API options:

- `--action generate|edit|auto`
- `--image <path>` one or more input images for guided generation or editing
- `--mask <path>` optional inpainting mask
- `--image-model <model>` top-level Images API model; defaults to `gpt-image-2.5-flare`
- `--size <size>` such as `1024x1024`, `1024x1536`, `1536x1024`, or API-supported custom sizes
- `--quality low|medium|high|auto`
- `--format png|webp|jpeg`
- `--background transparent|opaque|auto`
- `--input-fidelity high|low`
- `--moderation auto|low`
- `--output-compression <0-100>`
- `--api-key-env <name>` explicit API key environment variable override; defaults to `SEVOKE_IMAGE_API_KEY`
- `--no-progress` disables progress messages on stderr while waiting for the API

For generation, the script sends JSON to `/images/generations`. For edits or inpainting, it sends multipart form data to `/images/edits` with one or more `image` files and an optional `mask`. The normal JSON response contains base64 images in `data[].b64_json`; compatible streaming providers may return the completed image in an SSE completion event.

## Quality Guidance

For better results, write prompts with concrete visual constraints:

- Subject, setting, medium, lighting, composition, aspect ratio, and any text that must appear.
- Negative constraints when helpful, such as "no watermark" or "no extra text".
- For edits, describe what must stay unchanged as clearly as what should change.
- For UI or product assets, specify background, transparency, icon padding, and output format.

## Failure Handling

If no image result is returned:

- Check whether the response contains a refusal, tool error, or policy message.
- Re-run with `--dry-run` to confirm config and request shape.
- Do not retry while the original generation command is still running. Wait for a success or failure exit first.
- Verify the configured provider supports the OpenAI-compatible Images API endpoints and the selected image model.
- Do not expose the API key while debugging. Redact request headers and auth fields.
- Do not use `cat`, `type`, `Get-Content`, or similar commands on `auth.json` for debugging. Use the script's `--dry-run`, which only reports `has_api_key` and `api_key_source`.
