#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_IMAGE_MODEL = "gpt-image-2";

const HELP = `
Usage:
  node scripts/generate-image.mjs --prompt "..." --out outputs/image.png [options]

Required:
  --prompt <text>             Image prompt. Use --prompt-file or stdin as alternatives.

Output:
  --out <path>                Output image path. Default: generated.png

Codex config:
  --codex-home <path>         Defaults to $CODEX_HOME or <home>/.codex on Linux, macOS, and Windows
  --config <path>              Sevoke config file. Default: <skill-dir>/config.json
  --base-url <url>            Explicit override. Defaults to config.json apiUrl.
  --api-key-env <name>        Environment variable override for the API key. Default: SEVOKE_IMAGE_API_KEY.

Sevoke environment:
  SEVOKE_IMAGE_API_URL        Request base URL override.
  SEVOKE_IMAGE_API_KEY        API key override.

Image generation options:
  --action <generate|edit|auto>
  --image <path>              Input image. Can be repeated.
  --mask <path>               Optional inpainting mask image.
  --image-model <model>        Defaults to gpt-image-2.
  --size <size>
  --quality <low|medium|high|auto>
  --format <png|webp|jpeg>
  --background <transparent|opaque|auto>
  --input-fidelity <high|low>
  --moderation <auto|low>
  --output-compression <0-100>
  --partial-images <0-3>

API protocol:
  POST /images/generations for new images.
  POST /images/edits for image edits and inpainting.

Other:
  --dry-run                   Print redacted config and request body without calling the API.
  --json                      Print machine-readable result summary.
  --no-progress               Disable progress messages on stderr while waiting for the API.
  --help

Runtime:
  Requires Node.js 18+ only. No npm packages are needed.
`;

function die(message, code = 1) {
  console.error(`Error: ${message}`);
  process.exit(code);
}

function progress(args, message) {
  if (!args["no-progress"]) {
    console.error(`[image-generation] ${message}`);
  }
}

function startProgress(args) {
  if (args["no-progress"]) return () => {};

  const startedAt = Date.now();
  progress(args, "Request sent. Image generation can take several minutes; wait for this command to finish before retrying.");
  const timer = setInterval(() => {
    const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
    progress(args, `Still waiting for image result (${elapsedSeconds}s elapsed). Do not start another generation for the same request unless this command fails.`);
  }, 15000);
  if (typeof timer.unref === "function") timer.unref();

  return () => clearInterval(timer);
}

function parseArgs(argv) {
  const args = { image: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      die(`unexpected argument: ${token}`);
    }

    const key = token.slice(2);
    if (key === "api-key") {
      die("--api-key was removed to avoid exposing secrets in command lines. Use Codex auth.json or --api-key-env <name>.");
    }
    if (key === "response-model") {
      die("--response-model is not used by the Images API flow. Use --image-model <model> instead.");
    }
    if (["help", "dry-run", "json", "no-progress"].includes(key)) {
      args[key] = true;
      continue;
    }

    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      die(`missing value for --${key}`);
    }
    i += 1;

    if (key === "image") {
      args.image.push(value);
    } else {
      args[key] = value;
    }
  }
  return args;
}

function parseTomlValue(raw) {
  const value = raw.trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

function parseTomlLite(text) {
  const root = {};
  const sections = {};
  let current = root;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1].replaceAll('"', "");
      sections[section] = sections[section] || {};
      current = sections[section];
      continue;
    }

    const keyValueMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!keyValueMatch) continue;
    const [, key, rawValue] = keyValueMatch;
    current[key] = parseTomlValue(rawValue);
  }

  return { root, sections };
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    die(`failed to parse ${filePath}: ${error.message}`);
  }
}

function envValue(name) {
  if (process.env[name] !== undefined) return process.env[name];
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(process.env)) {
    if (key.toLowerCase() === lowerName) return value;
  }
  return undefined;
}

function validateEnvName(name, optionName) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    die(`${optionName} must be an environment variable name, not a secret value.`);
  }
}

function defaultCodexHome() {
  return path.resolve(envValue("CODEX_HOME") || path.join(os.homedir(), ".codex"));
}

function resolveCodexConfig(args) {
  const codexHome = args["codex-home"] ? path.resolve(args["codex-home"]) : defaultCodexHome();
  const codexConfigPath = path.join(codexHome, "config.toml");
  const authPath = path.join(codexHome, "auth.json");

  let codexConfig = { root: {}, sections: {} };
  if (fs.existsSync(codexConfigPath)) {
    codexConfig = parseTomlLite(fs.readFileSync(codexConfigPath, "utf8"));
  }

  const providerName = codexConfig.root.model_provider || "OpenAI";
  const provider = codexConfig.sections[`model_providers.${providerName}`] || {};
  const auth = readJsonIfExists(authPath);
  const skillConfigPath = args.config ? path.resolve(args.config) : path.join(SKILL_ROOT, "config.json");
  const skillConfig = readJsonIfExists(skillConfigPath);
  const apiKeyEnvName = args["api-key-env"] || "SEVOKE_IMAGE_API_KEY";
  validateEnvName(apiKeyEnvName, "--api-key-env");
  const configBaseUrl = typeof skillConfig.apiUrl === "string" ? skillConfig.apiUrl : undefined;
  const configApiKey = typeof skillConfig.apiKey === "string" ? skillConfig.apiKey : undefined;
  const baseUrl = args["base-url"] || envValue("SEVOKE_IMAGE_API_URL") || configBaseUrl || provider.base_url || envValue("OPENAI_BASE_URL") || "https://api.openai.com/v1";
  const authApiKey = auth.OPENAI_API_KEY;
  const envApiKey = envValue(apiKeyEnvName);
  const fallbackEnvApiKey = envValue("OPENAI_API_KEY");
  const apiKey = envApiKey || configApiKey || authApiKey || fallbackEnvApiKey;
  const apiKeySource = envApiKey
    ? `env:${apiKeyEnvName}`
    : configApiKey
      ? "sevoke-config"
      : authApiKey
        ? "codex-auth"
        : fallbackEnvApiKey
          ? "env:OPENAI_API_KEY"
          : "none";

  if (!apiKey && !args["dry-run"]) {
    die(`no API key found. Set ${apiKeyEnvName}, run scripts/install-sevoke.mjs, or configure OPENAI_API_KEY in Codex auth.json.`);
  }

  return {
    codexHome,
    configPath: codexConfigPath,
    skillConfigPath,
    authPath,
    providerName,
    provider,
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    apiKeySource,
    hasApiKey: Boolean(apiKey),
  };
}

async function readPrompt(args) {
  if (args.prompt) return args.prompt;
  if (args["prompt-file"]) return fs.readFileSync(args["prompt-file"], "utf8").trim();
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const stdinPrompt = Buffer.concat(chunks).toString("utf8").trim();
    if (stdinPrompt) return stdinPrompt;
  }
  die("missing --prompt, --prompt-file, or stdin prompt.");
}

function mimeTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

function imageFileToDataUrl(filePath) {
  if (!fs.existsSync(filePath)) die(`image file not found: ${filePath}`);
  const data = fs.readFileSync(filePath).toString("base64");
  return `data:${mimeTypeFor(filePath)};base64,${data}`;
}

function resolveAction(args) {
  const hasImages = args.image.length > 0;
  const requested = args.action || "auto";
  const action = requested === "auto" ? (hasImages || args.mask ? "edit" : "generate") : requested;

  if (action === "generate" && hasImages) die("generate does not accept --image. Use --action edit.");
  if (action === "generate" && args.mask) die("generate does not accept --mask. Use --action edit.");
  if (action === "generate" && args["input-fidelity"]) die("generate does not accept --input-fidelity. Use --action edit.");
  if (action === "edit" && !hasImages) die("edit requires at least one --image <local-path>.");
  return action;
}

function numberOption(args, name, { min, max } = {}) {
  if (args[name] === undefined) return undefined;
  const value = Number(args[name]);
  if (!Number.isInteger(value) || (min !== undefined && value < min) || (max !== undefined && value > max)) {
    die(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function buildPayload(prompt, args, action) {
  const payload = {
    model: args["image-model"] || DEFAULT_IMAGE_MODEL,
    prompt,
    n: 1,
    quality: args.quality || "auto",
    size: args.size || (action === "generate" ? "1024x1024" : "auto"),
    output_format: args.format || "png",
    background: args.background || "auto",
    moderation: args.moderation || "auto",
    stream: true,
    partial_images: args["partial-images"] === undefined ? 0 : numberOption(args, "partial-images", { min: 0, max: 3 }),
  };

  if (action === "edit" && args["input-fidelity"] !== undefined) {
    payload.input_fidelity = args["input-fidelity"];
  }
  if (args["output-compression"] !== undefined) {
    payload.output_compression = numberOption(args, "output-compression", { min: 0, max: 100 });
  }
  return payload;
}

function escapeMultipartHeaderValue(value) {
  return String(value).replace(/[\r\n"]/g, "_");
}

function multipartTextPart(boundary, key, value) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartHeaderValue(key)}"\r\n\r\n${String(value)}\r\n`,
    "utf8",
  );
}

function multipartFilePart(boundary, key, filePath) {
  if (!fs.existsSync(filePath)) die(`image file not found: ${filePath}`);
  const filename = path.basename(filePath);
  return [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${escapeMultipartHeaderValue(key)}"; filename="${escapeMultipartHeaderValue(filename)}"\r\nContent-Type: ${mimeTypeFor(filePath)}\r\n\r\n`,
      "utf8",
    ),
    fs.readFileSync(filePath),
    Buffer.from("\r\n", "utf8"),
  ];
}

function buildRequestBody(payload, args, action) {
  if (action === "generate") {
    return {
      body: JSON.stringify(payload),
      contentType: "application/json",
      preview: payload,
    };
  }

  const boundary = `----sevoke-image-generation-${process.pid}-${Date.now()}`;
  const chunks = [];
  for (const [key, value] of Object.entries(payload)) {
    chunks.push(multipartTextPart(boundary, key, value));
  }
  for (const imagePath of args.image) {
    chunks.push(...multipartFilePart(boundary, "image", imagePath));
  }
  if (args.mask) chunks.push(...multipartFilePart(boundary, "mask", args.mask));
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
    preview: {
      ...payload,
      image_files: args.image,
      mask_file: args.mask || undefined,
    },
  };
}

function outputPathFor(basePath, index, count, format) {
  if (count === 1) return basePath;
  const parsed = path.parse(basePath);
  const ext = parsed.ext || `.${format || "png"}`;
  return path.join(parsed.dir, `${parsed.name}-${index + 1}${ext}`);
}

function redactRequest(body) {
  return JSON.parse(JSON.stringify(body));
}

function extractImageResults(value) {
  const results = [];
  const visit = (candidate) => {
    if (!candidate) return;
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (typeof candidate !== "object") return;
    if (typeof candidate.b64_json === "string" && candidate.b64_json.length > 0) {
      results.push(candidate.b64_json);
      return;
    }
    for (const key of ["data", "images", "output", "result"]) {
      if (candidate[key] !== undefined) visit(candidate[key]);
    }
  };
  visit(value);
  return results;
}

function responseErrorMessage(text, status) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || JSON.stringify(parsed).slice(0, 1000);
  } catch {
    return text.trim().slice(0, 1000) || `Image API returned HTTP ${status}.`;
  }
}

async function consumeSse(response, args) {
  if (!response.body) die("Image API returned an empty response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = "";
  let eventType = null;
  let dataLines = [];

  const flushFrame = () => {
    if (dataLines.length === 0) return null;
    const payload = dataLines.join("\n");
    dataLines = [];
    const frameType = eventType;
    eventType = null;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      die("Image API returned invalid SSE JSON.");
    }
    if (/error/i.test(frameType || parsed?.type || "") || parsed?.error) {
      die(responseErrorMessage(payload, response.status));
    }
    const images = extractImageResults(parsed);
    const isCompleted = /completed|complete/i.test(frameType || parsed?.type || "") || (!frameType && !parsed?.type);
    if (isCompleted && images.length > 0) return images;
    if (/partial/i.test(frameType || parsed?.type || "")) {
      progress(args, "Received an image preview. Waiting for the completed image.");
    }
    return null;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });
    let newlineIndex;
    while ((newlineIndex = pending.indexOf("\n")) !== -1) {
      const rawLine = pending.slice(0, newlineIndex);
      pending = pending.slice(newlineIndex + 1);
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        const images = flushFrame();
        if (images) return images;
      } else if (line.startsWith("event:")) {
        eventType = line.slice(6).trim() || null;
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
  }

  pending += decoder.decode();
  if (pending) {
    const line = pending.endsWith("\r") ? pending.slice(0, -1) : pending;
    if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  const images = flushFrame();
  if (images) return images;
  die("Image API stream ended before a completed image was returned.");
}

async function readImageResponse(response, args) {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.toLowerCase().includes("text/event-stream")) {
    return consumeSse(response, args);
  }

  const text = await response.text();
  if (!response.ok) die(`Image API request failed with status ${response.status}: ${responseErrorMessage(text, response.status)}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    die(`Image API returned non-JSON response with status ${response.status}: ${text.slice(0, 500)}`);
  }
  const images = extractImageResults(parsed);
  if (images.length === 0) die("Image API response did not contain data[].b64_json.");
  return images;
}

async function main() {
  if (typeof fetch !== "function") {
    die("Node.js 18+ is required because this script uses the built-in fetch API.");
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP.trim());
    return;
  }

  const prompt = await readPrompt(args);
  const config = resolveCodexConfig(args);
  const action = resolveAction(args);
  const outputPath = args.out || "generated.png";
  const payload = buildPayload(prompt, args, action);
  const request = buildRequestBody(payload, args, action);
  const endpoint = `${config.baseUrl}/images/${action === "generate" ? "generations" : "edits"}`;

  if (args["dry-run"]) {
    console.log(JSON.stringify({
      skill_config_path: config.skillConfigPath,
      provider: config.providerName,
      base_url: config.baseUrl,
      endpoint,
      method: "POST",
      action,
      image_model: payload.model,
      has_api_key: config.hasApiKey,
      api_key_source: config.apiKeySource,
      content_type: request.contentType,
      request: redactRequest(request.preview),
    }, null, 2));
    return;
  }

  const stopProgress = startProgress(args);
  let response;
  let imageResults;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": request.contentType,
      },
      body: request.body,
    });
    imageResults = await readImageResponse(response, args);
  } finally {
    stopProgress();
  }
  progress(args, "Response received. Decoding image data.");

  const outputFormat = payload.output_format || path.extname(outputPath).replace(".", "") || "png";
  const written = [];
  for (let i = 0; i < imageResults.length; i += 1) {
    const target = outputPathFor(outputPath, i, imageResults.length, outputFormat);
    fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    fs.writeFileSync(target, Buffer.from(imageResults[i], "base64"));
    written.push(target);
  }

  const summary = {
    endpoint,
    action,
    provider: config.providerName,
    base_url: config.baseUrl,
    image_model: payload.model,
    outputs: written,
  };

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    for (const filePath of written) {
      console.log(`Wrote ${filePath}`);
    }
  }
}

main().catch((error) => {
  die(error.stack || error.message || String(error));
});
