/**
 * Every harness we know how to install, in one place.
 *
 * This catalogue existed three times — twice in the node detail page after
 * its tabs were split out, and again on the unsandbox page — and the copies
 * had drifted. The container one had lost the third tag from all sixteen
 * entries, so the same search box matched different things depending on
 * which page you typed it into, and adding a seventeenth harness meant
 * editing three lists and remembering all three.
 *
 * Only one field genuinely varies by where the harness is going, and it is
 * named below rather than duplicated sixteen times.
 */

export interface Harness {
  id: string;
  name: string;
  desc: string;
  /** Shell to install it. Runs under bash -lc. */
  install: string;
  /** Shell that prints a version, and is the only proof it is there. */
  verify: string;
  /** Named so the UI can say what will be missing before anyone boots it. */
  requiresKey?: string;
  /** First two are shown; all of them are searched. */
  tags: string[];
}

/**
 * Where a harness is being installed.
 *
 * `node` is a machine we ssh to, which gives us a login shell and a real
 * $HOME. `container` is an unsandbox box running as root without one.
 */
export type HarnessContext = 'node' | 'container';

const HARNESSES: Harness[] = [
  // --- Coding agents ---
  {
    id: 'claude-code', name: 'Claude Code',
    desc: 'Anthropic CLI for Claude — agentic coding in the terminal',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
    verify: 'export PATH="$HOME/.local/bin:$PATH"; claude --version',
    tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'gemini-cli', name: 'Gemini CLI',
    desc: 'Google CLI for Gemini — agentic coding similar to Claude Code',
    install: 'npm install -g @anthropic-ai/gemini-cli',
    verify: 'gemini --version',
    requiresKey: 'GOOGLE_API_KEY', tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'openai-codex', name: 'OpenAI Codex CLI',
    desc: 'OpenAI CLI coding agent — GPT-4 powered terminal assistant',
    install: 'npm install -g @openai/codex',
    verify: 'codex --version',
    requiresKey: 'OPENAI_API_KEY', tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'open-code', name: 'Open Code',
    desc: 'Open source alternative to Claude Code — multi-provider',
    install: 'npm install -g opencode-ai',
    verify: 'opencode --version',
    requiresKey: 'ANTHROPIC_API_KEY or OPENAI_API_KEY', tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'aider', name: 'Aider',
    desc: 'ML pair programming in the terminal — many models',
    install: 'pip install aider-chat',
    verify: 'aider --version',
    requiresKey: 'ANTHROPIC_API_KEY or OPENAI_API_KEY', tags: ['ml', 'coding', 'python'],
  },
  {
    id: 'agnt', name: 'agnt',
    desc: 'Minimal terminal coding agent — lightweight alternative to Claude Code',
    install: 'npm install -g agnt',
    verify: 'agnt --version',
    requiresKey: 'ANTHROPIC_API_KEY', tags: ['ml', 'coding', 'cli'],
  },
  {
    id: 'cursor', name: 'Cursor',
    desc: 'ML-first code editor — fork of VS Code with built-in chat and autocomplete',
    install: 'curl -fsSL https://www.cursor.com/download/linux -o cursor.appimage && chmod +x cursor.appimage',
    verify: 'ls cursor.appimage',
    tags: ['ml', 'coding', 'editor'],
  },
  {
    id: 'continue-dev', name: 'Continue',
    desc: 'Open source ML code assistant — VS Code and JetBrains extension',
    install: 'pip install continue-sdk',
    verify: 'pip show continue-sdk',
    tags: ['ml', 'coding', 'extension'],
  },
  // --- Inference engines ---
  {
    id: 'ollama', name: 'Ollama',
    desc: 'Run open source LLMs locally — llama, mistral, codellama',
    install: 'curl -fsSL https://ollama.com/install.sh | sh',
    verify: 'ollama --version',
    tags: ['ml', 'local', 'inference'],
  },
  {
    id: 'llama-cpp', name: 'llama.cpp',
    desc: 'Bare-metal LLM inference in C/C++ — GGUF models, CPU and GPU',
    install: 'git clone https://github.com/ggerganov/llama.cpp && cd llama.cpp && make -j',
    verify: 'ls llama.cpp/llama-cli',
    tags: ['ml', 'local', 'inference'],
  },
  {
    id: 'vllm', name: 'vLLM',
    desc: 'High-throughput LLM serving engine — PagedAttention, continuous batching',
    install: 'pip install vllm',
    verify: 'python -c "import vllm; print(vllm.__version__)"',
    tags: ['ml', 'gpu', 'inference'],
  },
  {
    id: 'text-generation-webui', name: 'text-generation-webui',
    desc: 'Gradio web UI for LLMs — supports GGUF, GPTQ, AWQ, EXL2, llama.cpp, Transformers',
    install: 'git clone https://github.com/oobabooga/text-generation-webui && cd text-generation-webui && pip install -r requirements.txt',
    verify: 'ls text-generation-webui/server.py',
    tags: ['ml', 'web', 'inference'],
  },
  // --- Web UIs ---
  {
    id: 'open-webui', name: 'Open WebUI',
    desc: 'Self-hosted ChatGPT-like interface for Ollama and OpenAI APIs',
    install: 'pip install open-webui',
    verify: 'open-webui --version',
    tags: ['ml', 'web', 'self-hosted'],
  },
  // --- Agent frameworks ---
  {
    id: 'hermes-agent', name: 'Hermes Agent',
    desc: 'Autonomous agent framework — tool use, memory, planning with local or cloud LLMs',
    install: 'pip install hermes-agent',
    verify: 'pip show hermes-agent',
    tags: ['ml', 'agent', 'python'],
  },
  {
    id: 'fetch', name: 'Fetch',
    desc: 'HTTP harness for ML APIs — structured logging and replay',
    install: 'pip install fetch-cli',
    verify: 'fetch --version',
    tags: ['ml', 'api', 'cli'],
  },
  {
    id: 'uncloseai-cli', name: 'uncloseai-cli',
    desc: 'ReAct agent harness, microgpt, voxsplit — ML from seed on Unclose',
    install: 'pip install -r requirements.txt',
    verify: 'python -c "import uncloseai"',
    tags: ['ml', 'agent', 'python'],
  },
];

/**
 * The catalogue as one context runs it.
 *
 * claude's installer drops its binary in `$HOME/.local/bin`, which a login
 * shell finds and a root container's non-login shell does not — so that one
 * verify command is named absolutely there. Every other entry is the same
 * wherever it runs.
 */
const CONTAINER_VERIFY: Record<string, string> = {
  'claude-code': '/root/.local/bin/claude --version',
};

export function harnessesFor(context: HarnessContext): Harness[] {
  if (context === 'node') return HARNESSES;
  return HARNESSES.map((h) =>
    CONTAINER_VERIFY[h.id] ? { ...h, verify: CONTAINER_VERIFY[h.id] } : h,
  );
}

/** Look one up by the id our boot routes pass around. */
export function harnessById(id: string): Harness | undefined {
  return HARNESSES.find((h) => h.id === id);
}
