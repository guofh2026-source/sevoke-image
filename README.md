# Sevoke Image

这是一个 Codex skill，通过 OpenAI 兼容的 Images API 生成、编辑和局部重绘图片。

Sevoke 直接发起以下请求，不经过 Responses API，也不提交 Codex 外层模型：

- 新图片：`POST /images/generations`
- 编辑或局部重绘：`POST /images/edits`
- 默认请求模型：顶层字段 `model: "gpt-image-2.5-flare"`

## 安装

将下面的提示词发送给 Codex：

```text
请安装这个 Codex skill：
https://github.com/guofh2026-source/sevoke-image/tree/main/sevoke-image

安装完成后，请不要自动打开终端。请引导我自己完成配置：

1. 输出已安装技能的完整目录。
2. 输出该目录下 scripts/install-sevoke.mjs 的完整路径。
3. 输出一条带引号、可以直接复制的 node 安装命令。
4. 根据我的系统给出打开终端的快捷键：
   - Windows：Win + R，输入 powershell
   - macOS：Command + Space，搜索 Terminal
   - Linux：Ctrl + Alt + T
5. 告诉我打开终端后粘贴并执行安装命令。
6. 说明安装器会先询问 API URL，再隐藏输入 API key。
7. 不要让我在聊天中发送 API key，也不要把 key 放进命令行。
8. 配置完成后告诉我重启 Codex。
9. 重启后给出 generate-image.mjs 的 --dry-run 验证命令，并确认请求使用：
   - POST /images/generations
   - POST /images/edits
   - 顶层模型 gpt-image-2.5-flare
   - 配置的 API URL 和 API key
10. 不要使用 Responses API，也不要提交 Codex 外层模型。
```

技能安装完成后，用户自己打开终端执行安装器。快捷键如下：

- Windows：`Win + R`，输入 `powershell`，按回车
- macOS：`Command + Space`，搜索 `Terminal`，按回车
- Linux：`Ctrl + Alt + T`

安装器会先询问 API URL，再隐藏输入 API key，并将配置写入安装目录下的 `config.json`。它会输出完整技能目录和可复制的命令。配置完成后请重启 Codex。

## 配置优先级

API URL 按以下顺序选择：

1. `--base-url`
2. `SEVOKE_IMAGE_API_URL`
3. 安装目录 `config.json` 的 `apiUrl`
4. Codex `config.toml` 中当前 provider 的 `base_url`
5. `OPENAI_BASE_URL`
6. `https://api.openai.com/v1`

API key 按以下顺序选择：

1. `--api-key-env` 指定的环境变量，默认是 `SEVOKE_IMAGE_API_KEY`
2. 安装目录 `config.json` 的 `apiKey`
3. Codex `auth.json` 中的 `OPENAI_API_KEY`
4. `OPENAI_API_KEY`

不要把真实 API key 放进聊天、命令行参数、源代码或 Git。`--dry-run` 只显示是否找到 key 及其来源，不显示 key 值。`config.json` 含有密钥，不应提交；提交前只保留 `config.example.json`。

## 使用

Node.js 18+ 是首选运行时，Python 3 是备用运行时。两者都不需要安装第三方依赖。

生成图片：

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "A product photo of a matte black ceramic mug on a walnut desk" \
  --out outputs/mug.png \
  --size 1024x1024 \
  --quality high
```

编辑图片：

```bash
node <skill-dir>/scripts/generate-image.mjs \
  --prompt "Restyle this image as a polished editorial illustration while preserving the composition" \
  --image reference.png \
  --action edit \
  --input-fidelity high \
  --out outputs/reference-restyled.png
```

Windows PowerShell 可以使用：

```powershell
node "<技能完整目录>\scripts\generate-image.mjs" --prompt "A quick test image" --out outputs\test.png
```

Python 备用命令：

```bash
python3 <skill-dir>/scripts/generate-image.py --prompt "A quick test image" --out outputs/test.png
```

检查配置但不发起请求：

```bash
node <skill-dir>/scripts/generate-image.mjs --prompt "A quick test image" --dry-run
```

`--dry-run` 应显示 endpoint 以 `/images/generations` 结尾，并显示 `image_model: "gpt-image-2.5-flare"`。生成响应使用 `data[].b64_json`；编辑请求使用 multipart 表单上传 `image`，可选上传 `mask`。脚本也兼容返回已完成图片的 SSE 响应。

## 支持的参数

- `--action generate|edit|auto`
- `--image <path>`，可重复，用于编辑
- `--mask <path>`，用于局部重绘
- `--image-model <model>`，支持 canonical ID 或 `Flare`/`Sunburst` 展示名称，默认 `gpt-image-2.5-flare`
- `--size <size>`
- `--quality low|medium|high|auto`
- `--format png|webp|jpeg`
- `--background transparent|opaque|auto`
- `--input-fidelity high|low`
- `--moderation auto|low`
- `--output-compression <0-100>`
- `--api-key-env <name>`，只传环境变量名称
- `--no-progress`

生成任务可能需要较长时间。一次请求启动后应等待同一个命令结束，不要因为进度较慢就重复生成。

## 模型选择

默认使用接口返回的模型 ID `gpt-image-2.5-flare`。当用户在请求中明确指定图片模型时，技能会将模型名转换为 `--image-model <model>`，而不是把模型指令混入图片提示词；Node/Python 脚本也会对已知展示名称做兜底归一化。例如“使用 `GPT-Image-2.5 Sunburst` 生成”时，最终请求会使用 API 模型 ID `gpt-image-2.5-sunburst`，覆盖默认模型。
