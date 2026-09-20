#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function fail(message, code = 1) {
  console.error("Error: " + message);
  process.exit(code);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
      continue;
    }
    if (token === "--api-key") {
      fail("--api-key is not supported. Enter the key through hidden local input.");
    }
    if (token === "--url" || token === "--config") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(token + " requires a value.");
      args[token.slice(2)] = value;
      index += 1;
      continue;
    }
    fail("Unexpected argument: " + token);
  }
  return args;
}

function normalizeUrl(value) {
  const url = String(value || "").trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail("API URL must be a valid http or https URL.");
  }
  if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) {
    fail("API URL must use http or https.");
  }
  return url;
}

async function promptLine(message) {
  const input = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await input.question(message);
  } finally {
    input.close();
  }
}

function promptSecret(message) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    fail("Hidden API key input requires an interactive terminal.");
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const input = process.stdin;

    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
    };
    const finish = () => {
      cleanup();
      process.stdout.write("\n");
      if (!value) reject(new Error("API key is required."));
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const byte of Buffer.from(chunk)) {
        if (byte === 3) {
          cleanup();
          reject(new Error("API key input cancelled."));
          return;
        }
        if (byte === 13 || byte === 10) {
          finish();
          return;
        }
        if (byte === 8 || byte === 127) {
          value = value.slice(0, -1);
          continue;
        }
        if (byte >= 32) value += String.fromCharCode(byte);
      }
    };

    process.stdout.write(message);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

function readConfig(configPath) {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    fail("Could not parse " + configPath + ": " + error.message);
  }
}

function writeConfig(configPath, config) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const temporaryPath = configPath + "." + process.pid + ".tmp";
  fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    if (fs.existsSync(configPath)) fs.rmSync(configPath, { force: true });
    fs.renameSync(temporaryPath, configPath);
    fs.chmodSync(configPath, 0o600);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

function printHelp() {
  console.log([
    "Sevoke Image Generation installer",
    "",
    "Usage:",
    "  node scripts/install-sevoke.mjs [--url <url>] [--config <path>]",
    "",
    "The API key is always collected through hidden interactive input.",
  ].join("\n"));
}

function printInstallPaths() {
  const installerPath = path.join(skillRoot, "scripts", "install-sevoke.mjs");
  console.log("Sevoke skill directory: " + skillRoot);
  console.log("Installer path: " + installerPath);
  console.log('Copyable command: node "' + installerPath + '"');
  console.log("");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  printInstallPaths();
  const configPath = path.resolve(args.config || path.join(skillRoot, "config.json"));
  const existing = readConfig(configPath);
  const urlInput = args.url || await promptLine("Sevoke API base URL: ");
  const apiUrl = normalizeUrl(urlInput);
  let apiKey;
  try {
    apiKey = await promptSecret("Sevoke API key (hidden): ");
  } catch (error) {
    fail(error.message);
  }

  try {
    writeConfig(configPath, {
      ...existing,
      apiUrl,
      apiKey,
    });
  } catch (error) {
    fail("Could not save " + configPath + ": " + error.message);
  }

  console.log("Sevoke configuration saved to " + configPath + ".");
  console.log("Restart Codex after installation. The API key was not printed.");
  console.log("");
  console.log("Next step: after restarting Codex, paste this prompt to verify setup:");
  console.log("请检查 Sevoke 图片生成技能的配置，用 --dry-run 验证配置并告诉我最小图片生成测试命令。");
  console.log("不要在聊天中显示或索要 API key，也不要把密钥放进命令行、日志或 Git。");
}

main().catch((error) => fail(error.stack || error.message || String(error)));
