#!/usr/bin/env node
/**
 * SWE-bench Pro evaluation CLI.
 *
 * Usage:
 *   nexus-eval-swebench-pro [run] [options]
 *   nexus-eval-swebench-pro --version
 *   nexus-eval-swebench-pro --help
 *
 * Constructs an OpenAI-compatible IModelAdapter from env vars
 * (OPENAI_API_KEY, optional OPENAI_BASE_URL, MODEL_ID). Operators
 * who need a different adapter shape can compose SweBenchProAdapter
 * directly via the library API.
 *
 * @module cli
 */

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runBenchmark, createOpenAIAdapter } from 'nexus-agents';
import { SweBenchProAdapter } from './adapter.js';
import type { SweBenchProInstance } from './adapter.js';

const require = createRequire(import.meta.url);
const packageJson = require('../package.json') as { version: string };
export const VERSION = packageJson.version;

type RepoLanguage = SweBenchProInstance['repoLanguage'];
const VALID_LANGUAGES: readonly RepoLanguage[] = ['python', 'javascript', 'typescript', 'go'];

const HELP = `nexus-eval-swebench-pro — SWE-bench Pro evaluation harness

Usage:
  nexus-eval-swebench-pro [run] [options]
  nexus-eval-swebench-pro --version
  nexus-eval-swebench-pro --help

Options:
  --model-id <id>             Model identifier passed to the OpenAI-compat
                              endpoint. Default: env MODEL_ID or 'gpt-4o'.
  --dataset <huggingface|fixture|path>
                              Dataset source. Default: huggingface.
                              'fixture' loads the bundled minimal fixture
                              (4 stub instances, one per language) for
                              smoke testing without network.
  --languages <comma-list>    Filter by language (python,javascript,
                              typescript,go). Default: all.
  --cache-dir <dir>           Cache dir for HF downloads.
  --limit <n>                 Limit instances. Default: all.
  --concurrency <n>           Max parallel solver calls. Default: 1.
  --timeout <ms>              Per-instance timeout. Default: 300000.
  --json                      JSON summary instead of human text.
  --help, -h                  Show this help.
  --version, -v               Show version.

Environment:
  OPENAI_API_KEY      (required) auth for the OpenAI-compat endpoint.
  OPENAI_BASE_URL     (optional) override base URL.
  MODEL_ID            (optional) default model — overridden by --model-id.

Notes:
  v0.2 is a model-only baseline — sends each instance's problem_statement
  + requirements + interface to the model and parses a unified diff +
  prefix out of the response. Pass/fail reflects "did the model produce
  a non-empty patch", NOT test-based resolution. For test-based pass/fail,
  run the upstream Pro Docker harness on the emitted predictions file
  (out of MVP scope).
`;

function parseLanguages(input: string | undefined): RepoLanguage[] | undefined {
  if (input === undefined || input === '') return undefined;
  const parts = input.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const p of parts) {
    if (!VALID_LANGUAGES.includes(p as RepoLanguage)) {
      throw new Error(
        `Invalid --languages value '${p}'. Must be one of: ${VALID_LANGUAGES.join(', ')}`
      );
    }
  }
  return parts as RepoLanguage[];
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`nexus-eval-swebench-pro ${VERSION}\n`);
    return 0;
  }

  const parsed = parseArgs({
    args: args[0] === 'run' ? args.slice(1) : args,
    options: {
      'model-id': { type: 'string' },
      dataset: { type: 'string' },
      languages: { type: 'string' },
      'cache-dir': { type: 'string' },
      limit: { type: 'string' },
      concurrency: { type: 'string', default: '1' },
      timeout: { type: 'string', default: '300000' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  const apiKey = process.env['OPENAI_API_KEY']?.trim();
  if (apiKey === undefined || apiKey === '') {
    process.stderr.write(
      'Error: OPENAI_API_KEY is not set. Set it to the auth token for your\n' +
        'OpenAI-compat endpoint (real OpenAI, a workspace proxy, vLLM, etc.).\n'
    );
    return 2;
  }

  const modelId =
    parsed.values['model-id'] ?? process.env['MODEL_ID'] ?? 'gpt-4o';
  const baseUrl = process.env['OPENAI_BASE_URL'];
  const limit =
    parsed.values.limit !== undefined ? Number(parsed.values.limit) : undefined;
  const concurrency = Number(parsed.values.concurrency ?? '1');
  const timeoutMs = Number(parsed.values.timeout ?? '300000');
  const languages = parseLanguages(parsed.values.languages);

  const modelAdapter = createOpenAIAdapter({
    apiKey,
    modelId,
    ...(baseUrl !== undefined && baseUrl !== '' && { baseUrl }),
  });

  const adapter = new SweBenchProAdapter(modelAdapter, {
    ...(parsed.values.dataset !== undefined && { dataset: parsed.values.dataset }),
    ...(languages !== undefined && { languages }),
    ...(parsed.values['cache-dir'] !== undefined && {
      cacheDir: parsed.values['cache-dir'],
    }),
  });

  const summary = await runBenchmark(adapter, {}, {
    concurrency,
    instanceTimeoutMs: timeoutMs,
    ...(limit !== undefined ? { limit } : {}),
    onProgress: (done: number, total: number): void => {
      if (!parsed.values.json) {
        process.stderr.write(`[${String(done)}/${String(total)}]\r`);
      }
    },
  });

  if (parsed.values.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write('\n');
    process.stdout.write(`${adapter.name} (model=${modelId})\n`);
    process.stdout.write(
      `  generated:  ${String(summary.passed)} / ${String(summary.total)} non-empty patches\n`
    );
    process.stdout.write(`  rate:       ${(summary.passRate * 100).toFixed(1)}%\n`);
    process.stdout.write(`  runtime:    ${(summary.runTimeMs / 1000).toFixed(1)}s\n`);
    const meta = summary.metadata as { byLanguage?: Record<string, { total: number; passed: number; passRate: number }> };
    if (meta.byLanguage !== undefined) {
      process.stdout.write('  by language:\n');
      for (const [lang, stats] of Object.entries(meta.byLanguage)) {
        process.stdout.write(
          `    ${lang.padEnd(11)}  ${String(stats.passed)}/${String(stats.total)} ` +
            `(${(stats.passRate * 100).toFixed(1)}%)\n`
        );
      }
    }
  }

  return summary.passed === summary.total ? 0 : 1;
}

function isDirectExecution(argvPath: string | undefined): boolean {
  return argvPath !== undefined && import.meta.url === pathToFileURL(resolve(argvPath)).href;
}

if (isDirectExecution(process.argv[1])) {
  main(process.argv)
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`Fatal: ${msg}\n`);
      process.exit(2);
    });
}
