# mini-Pi

mini-Pi is a deliberately small, read-only terminal agent for exploring a TypeScript or JavaScript project. It uses OpenAI-compatible tool calling to scan a project, read bounded text files, and inspect static import dependencies.

## Install

Requires Node.js 22 or newer.

```sh
npm install
npm run build
```

Set one provider key in your shell; mini-Pi reads keys from the environment only (it does not load or accept keys as CLI arguments):

```sh
export OPENAI_API_KEY="..."
# or
export DEEPSEEK_API_KEY="..."
```

`.env.example` is a reminder of the expected variable names; do not commit a real `.env` file.

## Use

Interactive mode asks for a provider and model:

```sh
npm run dev -- ../my-project
```

One-shot mode requires an explicit provider and model:

```sh
npm run dev -- ../my-project --provider openai --model gpt-4.1-mini --prompt "Where are the main entry points?"
```

Options: `mini-pi [project]`, `--provider openai|deepseek`, `--model MODEL`, `--prompt TEXT`, `--help`/`-h`, and `--version`/`-v`. In interactive mode, enter a single-line question or use `/help`, `/reset`, and `/exit`. A question is processed to completion before another input is accepted.

## Scope and safety

The included tools are read-only and constrain file access to the chosen project root. They ignore common build directories, reject traversal/symlink escapes, cap scan and read output, and perform static dependency analysis only. mini-Pi does not edit files, run project code, execute shell commands, or send API keys other than to the selected provider SDK.

Provider requests require a key and can incur cost or transmit tool-visible project text to the provider. Review the target project and provider policies before use.

## Verification

`npm test`, `npm run check`, and `npm run build` verify the local behavior. Provider adapters are covered with fake clients; live OpenAI and DeepSeek calls are intentionally **not** verified by this repository's automated tests, because they require user credentials and may incur charges.
