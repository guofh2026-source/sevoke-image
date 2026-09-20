#!/usr/bin/env python3

import argparse
import base64
import json
import mimetypes
import os
from pathlib import Path
import re
import sys
import threading
import time
import urllib.error
import urllib.request

DEFAULT_IMAGE_MODEL = "GPT-Image-2.5 Flare"


HELP = """Generate or edit images with the OpenAI-compatible Images API.

Runtime:
  Requires Python 3 only. No pip packages are needed.
"""


def die(message, code=1):
    print(f"Error: {message}", file=sys.stderr)
    raise SystemExit(code)


def progress(args, message):
    if not args.no_progress:
        print(f"[image-generation] {message}", file=sys.stderr, flush=True)


def start_progress(args):
    if args.no_progress:
        return lambda: None

    started_at = time.monotonic()
    stop_event = threading.Event()
    progress(args, "Request sent. Image generation can take several minutes; wait for this command to finish before retrying.")

    def loop():
        while not stop_event.wait(15):
            elapsed_seconds = round(time.monotonic() - started_at)
            progress(args, f"Still waiting for image result ({elapsed_seconds}s elapsed). Do not start another generation for the same request unless this command fails.")

    thread = threading.Thread(target=loop, daemon=True)
    thread.start()
    return stop_event.set


def parse_args():
    parser = argparse.ArgumentParser(description=HELP)
    parser.add_argument("--prompt")
    parser.add_argument("--prompt-file")
    parser.add_argument("--out", default="generated.png")
    parser.add_argument("--codex-home")
    parser.add_argument("--config")
    parser.add_argument("--base-url")
    parser.add_argument("--api-key", dest="deprecated_api_key", help=argparse.SUPPRESS)
    parser.add_argument("--api-key-env")
    parser.add_argument("--action", choices=["generate", "edit", "auto"])
    parser.add_argument("--image", action="append", default=[])
    parser.add_argument("--mask")
    parser.add_argument("--image-model", help=f"Image model (default: {DEFAULT_IMAGE_MODEL})")
    parser.add_argument("--size")
    parser.add_argument("--quality", choices=["low", "medium", "high", "auto"])
    parser.add_argument("--format", choices=["png", "webp", "jpeg"])
    parser.add_argument("--background", choices=["transparent", "opaque", "auto"])
    parser.add_argument("--input-fidelity", choices=["high", "low"])
    parser.add_argument("--moderation", choices=["auto", "low"])
    parser.add_argument("--output-compression", type=int)
    parser.add_argument("--partial-images", type=int)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--no-progress", action="store_true")
    args = parser.parse_args()
    if args.deprecated_api_key is not None:
        die("--api-key was removed to avoid exposing secrets in command lines. Use Codex auth.json or --api-key-env <name>.")
    return args


def parse_toml_value(raw):
    value = raw.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    if value == "true":
        return True
    if value == "false":
        return False
    if re.match(r"^-?\d+(\.\d+)?$", value):
        return float(value) if "." in value else int(value)
    return value


def parse_toml_lite(text):
    root = {}
    sections = {}
    current = root

    for line in text.splitlines():
        trimmed = line.strip()
        if not trimmed or trimmed.startswith("#"):
            continue

        section_match = re.match(r"^\[([^\]]+)\]$", trimmed)
        if section_match:
            section = section_match.group(1).replace('"', "")
            current = sections.setdefault(section, {})
            continue

        key_value_match = re.match(r"^([A-Za-z0-9_.-]+)\s*=\s*(.+)$", trimmed)
        if not key_value_match:
            continue
        key, raw_value = key_value_match.groups()
        current[key] = parse_toml_value(raw_value)

    return {"root": root, "sections": sections}


def read_json_if_exists(file_path):
    if not file_path.exists():
        return {}
    try:
        return json.loads(file_path.read_text(encoding="utf-8"))
    except Exception as error:
        die(f"failed to parse {file_path}: {error}")


def env_value(name):
    if name in os.environ:
        return os.environ[name]
    lower_name = name.lower()
    for key, value in os.environ.items():
        if key.lower() == lower_name:
            return value
    return None


def validate_env_name(name, option_name):
    if not re.match(r"^[A-Za-z_][A-Za-z0-9_]*$", name):
        die(f"{option_name} must be an environment variable name, not a secret value.")


def default_codex_home():
    return Path(env_value("CODEX_HOME") or Path.home() / ".codex").resolve()


def resolve_codex_config(args):
    codex_home = Path(args.codex_home).resolve() if args.codex_home else default_codex_home()
    config_path = codex_home / "config.toml"
    auth_path = codex_home / "auth.json"
    skill_config_path = Path(args.config).resolve() if args.config else Path(__file__).resolve().parent.parent / "config.json"

    codex_config = {"root": {}, "sections": {}}
    if config_path.exists():
        codex_config = parse_toml_lite(config_path.read_text(encoding="utf-8"))

    provider_name = codex_config["root"].get("model_provider") or "OpenAI"
    provider = codex_config["sections"].get(f"model_providers.{provider_name}", {})
    auth = read_json_if_exists(auth_path)
    skill_config = read_json_if_exists(skill_config_path)
    api_key_env_name = args.api_key_env or "SEVOKE_IMAGE_API_KEY"
    validate_env_name(api_key_env_name, "--api-key-env")

    base_url = (
        args.base_url
        or env_value("SEVOKE_IMAGE_API_URL")
        or skill_config.get("apiUrl")
        or provider.get("base_url")
        or env_value("OPENAI_BASE_URL")
        or "https://api.openai.com/v1"
    ).rstrip("/")
    auth_api_key = auth.get("OPENAI_API_KEY")
    config_api_key = skill_config.get("apiKey")
    env_api_key = env_value(api_key_env_name)
    fallback_env_api_key = env_value("OPENAI_API_KEY")
    api_key = env_api_key or config_api_key or auth_api_key or fallback_env_api_key
    api_key_source = f"env:{api_key_env_name}" if env_api_key else "sevoke-config" if config_api_key else "codex-auth" if auth_api_key else "env:OPENAI_API_KEY" if fallback_env_api_key else "none"

    if not api_key and not args.dry_run:
        die(f"no API key found. Set {api_key_env_name}, run scripts/install-sevoke.mjs, or configure OPENAI_API_KEY in Codex auth.json.")

    return {
        "codex_home": str(codex_home),
        "config_path": str(config_path),
        "skill_config_path": str(skill_config_path),
        "auth_path": str(auth_path),
        "provider_name": provider_name,
        "base_url": base_url,
        "api_key": api_key,
        "api_key_source": api_key_source,
        "has_api_key": bool(api_key),
    }


def read_prompt(args):
    if args.prompt:
        return args.prompt
    if args.prompt_file:
        return Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if not sys.stdin.isatty():
        prompt = sys.stdin.read().strip()
        if prompt:
            return prompt
    die("missing --prompt, --prompt-file, or stdin prompt.")


def mime_type_for(file_path):
    guessed, _ = mimetypes.guess_type(str(file_path))
    return guessed or "image/png"


def image_file_to_data_url(file_path):
    path = Path(file_path)
    if not path.exists():
        die(f"image file not found: {file_path}")
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type_for(path)};base64,{data}"


def resolve_action(args):
    has_images = bool(args.image)
    requested = args.action or "auto"
    action = "edit" if requested == "auto" and (has_images or args.mask) else "generate" if requested == "auto" else requested

    if action == "generate" and has_images:
        die("generate does not accept --image. Use --action edit.")
    if action == "generate" and args.mask:
        die("generate does not accept --mask. Use --action edit.")
    if action == "generate" and args.input_fidelity:
        die("generate does not accept --input-fidelity. Use --action edit.")
    if action == "edit" and not has_images:
        die("edit requires at least one --image <local-path>.")
    return action


def validate_number(value, option_name, minimum, maximum):
    if value is None:
        return None
    if value < minimum or value > maximum:
        die(f"--{option_name} must be an integer between {minimum} and {maximum}")
    return value


def build_payload(prompt, args, action):
    payload = {
        "model": args.image_model or DEFAULT_IMAGE_MODEL,
        "prompt": prompt,
        "n": 1,
        "quality": args.quality or "auto",
        "size": args.size or ("1024x1024" if action == "generate" else "auto"),
        "output_format": args.format or "png",
        "background": args.background or "auto",
        "moderation": args.moderation or "auto",
        "stream": True,
        "partial_images": validate_number(args.partial_images if args.partial_images is not None else 0, "partial-images", 0, 3),
    }
    if action == "edit" and args.input_fidelity is not None:
        payload["input_fidelity"] = args.input_fidelity
    if args.output_compression is not None:
        payload["output_compression"] = validate_number(args.output_compression, "output-compression", 0, 100)
    return payload


def escape_multipart_header(value):
    return str(value).replace("\r", "_").replace("\n", "_").replace('"', "_")


def multipart_text_part(boundary, key, value):
    return (
        f'--{boundary}\r\nContent-Disposition: form-data; name="{escape_multipart_header(key)}"\r\n\r\n{value}\r\n'
    ).encode("utf-8")


def multipart_file_part(boundary, key, file_path):
    path = Path(file_path)
    if not path.is_file():
        die(f"image file not found: {file_path}")
    filename = escape_multipart_header(path.name)
    header = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="{escape_multipart_header(key)}"; '
        f'filename="{filename}"\r\nContent-Type: {mime_type_for(path)}\r\n\r\n'
    ).encode("utf-8")
    return [header, path.read_bytes(), b"\r\n"]


def build_request_body(payload, args, action):
    if action == "generate":
        return json.dumps(payload).encode("utf-8"), "application/json", payload

    boundary = f"----sevoke-image-generation-{os.getpid()}"
    chunks = [multipart_text_part(boundary, key, value) for key, value in payload.items()]
    for image_path in args.image:
        chunks.extend(multipart_file_part(boundary, "image", image_path))
    if args.mask:
        chunks.extend(multipart_file_part(boundary, "mask", args.mask))
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    preview = dict(payload)
    preview["image_files"] = args.image
    if args.mask:
        preview["mask_file"] = args.mask
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}", preview


def output_path_for(base_path, index, count, output_format):
    path = Path(base_path)
    if count == 1:
        return path
    suffix = path.suffix or f".{output_format or 'png'}"
    return path.with_name(f"{path.stem}-{index + 1}{suffix}")


def redact_request(body):
    return body


def extract_image_results(value):
    results = []
    if isinstance(value, list):
        for item in value:
            results.extend(extract_image_results(item))
    elif isinstance(value, dict):
        if isinstance(value.get("b64_json"), str) and value["b64_json"]:
            results.append(value["b64_json"])
        else:
            for key in ("data", "images", "output", "result"):
                if key in value:
                    results.extend(extract_image_results(value[key]))
    return results


def response_error_message(text, status):
    try:
        parsed = json.loads(text)
        return parsed.get("error", {}).get("message") or parsed.get("message") or json.dumps(parsed)[:1000]
    except Exception:
        return text.strip()[:1000] or f"Image API returned HTTP {status}."


def consume_sse(response, args):
    event_type = None
    data_lines = []

    def flush_frame():
        nonlocal event_type, data_lines
        if not data_lines:
            return None
        payload = "\n".join(data_lines)
        frame_type = event_type
        event_type = None
        data_lines = []
        try:
            parsed = json.loads(payload)
        except Exception:
            die("Image API returned invalid SSE JSON.")
        parsed_type = parsed.get("type", "") if isinstance(parsed, dict) else ""
        effective_type = frame_type or parsed_type
        if "error" in effective_type.lower() or (isinstance(parsed, dict) and parsed.get("error")):
            die(response_error_message(payload, response.status))
        images = extract_image_results(parsed)
        completed = "complete" in effective_type.lower() or (not frame_type and not parsed_type)
        if completed and images:
            return images
        if "partial" in effective_type.lower():
            progress(args, "Received an image preview. Waiting for the completed image.")
        return None

    for raw_line in response:
        line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
        if line == "":
            images = flush_frame()
            if images:
                return images
        elif line.startswith("event:"):
            event_type = line[6:].strip() or None
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip(" "))

    images = flush_frame()
    if images:
        return images
    die("Image API stream ended before a completed image was returned.")


def read_image_response(response, args):
    status = response.status
    content_type = response.headers.get("Content-Type", "")
    if status < 200 or status >= 300:
        text = response.read().decode("utf-8", errors="replace")
        die(f"Image API request failed with status {status}: {response_error_message(text, status)}")
    if "text/event-stream" in content_type.lower():
        return consume_sse(response, args)

    text = response.read().decode("utf-8", errors="replace")
    try:
        parsed = json.loads(text)
    except Exception:
        die(f"Image API returned non-JSON response with status {status}: {text[:500]}")
    images = extract_image_results(parsed)
    if not images:
        die("Image API response did not contain data[].b64_json.")
    return images


def post_image_request(endpoint, api_key, body, content_type, args):
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": content_type,
        },
    )
    try:
        with urllib.request.urlopen(request) as response:
            return read_image_response(response, args)
    except urllib.error.HTTPError as error:
        read_image_response(error, args)
    except urllib.error.URLError as error:
        die(f"Image API connection error: {error.reason}")


def main():
    args = parse_args()
    prompt = read_prompt(args)
    config = resolve_codex_config(args)
    action = resolve_action(args)
    payload = build_payload(prompt, args, action)
    request_body, content_type, request_preview = build_request_body(payload, args, action)
    endpoint = f"{config['base_url']}/images/{'generations' if action == 'generate' else 'edits'}"

    if args.dry_run:
        print(json.dumps({
            "codex_home": config["codex_home"],
            "config_path": config["config_path"],
            "skill_config_path": config["skill_config_path"],
            "auth_path": config["auth_path"],
            "provider": config["provider_name"],
            "base_url": config["base_url"],
            "endpoint": endpoint,
            "method": "POST",
            "action": action,
            "image_model": payload["model"],
            "has_api_key": config["has_api_key"],
            "api_key_source": config["api_key_source"],
            "content_type": content_type,
            "request": redact_request(request_preview),
        }, indent=2))
        return

    stop_progress = start_progress(args)
    try:
        image_results = post_image_request(endpoint, config["api_key"], request_body, content_type, args)
    finally:
        stop_progress()
    progress(args, "Response received. Decoding image data.")

    output_format = payload.get("output_format") or Path(args.out).suffix.lstrip(".") or "png"
    written = []
    for index, image_base64 in enumerate(image_results):
        target = output_path_for(args.out, index, len(image_results), output_format)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(base64.b64decode(image_base64))
        written.append(str(target))

    summary = {
        "provider": config["provider_name"],
        "base_url": config["base_url"],
        "endpoint": endpoint,
        "action": action,
        "image_model": payload["model"],
        "outputs": written,
    }

    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        for file_path in written:
            print(f"Wrote {file_path}")


if __name__ == "__main__":
    main()
