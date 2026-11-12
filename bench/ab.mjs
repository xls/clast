#!/usr/bin/env node
// A/B benchmark: the same questions answered by headless Claude Code sessions, once with the clast
// MCP server and once with only Read / Grep / Glob. One session per question, so every number is
// per question. Usage:
//   node bench/ab.mjs <repo-dir> <questions.json> [--runs 3] [--parallel 4] [--model <id>]
//                     [--arms clast,grep] [--only id1,id2] [--out results.json]
// Requires the `claude` CLI on PATH and an index that is already built (`clast-ai index`).
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : dflt;
};
const runs = Number(flag('runs', '1'));
const parallel = Number(flag('parallel', '4'));
const model = flag('model', '');
const arms = flag('arms', 'clast,grep').split(',');
const only = flag('only', '');
const out = flag('out', '');
const noDefer = args.includes('--no-defer') ? (args.splice(args.indexOf('--no-defer'), 1), true) : false;
const hint = flag('hint', '');
const alwaysLoad = args.includes('--always-load') ? (args.splice(args.indexOf('--always-load'), 1), true) : false;
const server = flag('server', join(here, '..', 'dist', 'cli.js'));
const [repoArg, questionsArg] = args;
if (!repoArg || !questionsArg) {
  console.error('usage: node bench/ab.mjs <repo-dir> <questions.json> [--runs n] [--parallel n] [--model id]');
  process.exit(2);
}
const repo = resolve(repoArg);
let questions = JSON.parse(readFileSync(questionsArg, 'utf8'));
if (only) questions = questions.filter(q => only.split(',').includes(q.id));

const work = join(tmpdir(), `clast-ab-${process.pid}`);
mkdirSync(work, { recursive: true });
const mcpClast = join(work, 'mcp-clast.json');
const mcpNone = join(work, 'mcp-none.json');
writeFileSync(mcpClast, JSON.stringify({ mcpServers: { clast: { command: process.execPath, args: [resolve(server)] } } }));
const mcpLoaded = join(work, 'mcp-loaded.json');
writeFileSync(mcpLoaded, JSON.stringify({ mcpServers: { clast: { command: process.execPath, args: [resolve(server)], alwaysLoad: true } } }));
writeFileSync(mcpNone, JSON.stringify({ mcpServers: {} }));

const BLOCKED = 'Bash,PowerShell,NotebookEdit,Agent,Task,WebSearch,WebFetch,Skill';
const PROMPT = q =>
  `Answer this question about the code in the current directory. Be brief: name the symbols and ` +
  `file paths, no long explanations. Do not modify anything.\n\n${q}`;
// Implementation tasks ({"task": true} in the questions file): the agent edits the checkout, the
// diff is scored against the expected strings, and the checkout is reset. Such runs must not share
// a checkout, so they are forced to run one at a time.
const TASK_PROMPT = q =>
  `Implement the following change in the repository in the current directory. Find the right place ` +
  `and the existing base classes, registries and conventions first, and follow them. Keep the change ` +
  `focused. You cannot build or run anything here, so do not try. Finish with a two-line summary of ` +
  `the files you changed.\n\n${q}`;
const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
function collectDiff() {
  git('add', '-A', '-N');
  return git('diff').stdout || '';
}
function resetRepo() {
  git('reset', '-q', '--hard', 'HEAD');
  git('clean', '-fdq');
}

function runOne(question, arm) {
  return new Promise(done => {
    const cli = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--strict-mcp-config', '--mcp-config', arm === 'clast' ? mcpClast : arm === 'clast-loaded' ? mcpLoaded : mcpNone,
      '--allowedTools',
      (question.task ? 'Read,Grep,Glob,Edit,Write' : 'Read,Grep,Glob') + (arm === 'grep' ? '' : ',mcp__clast'),
      '--disallowedTools', question.task ? BLOCKED : `${BLOCKED},Edit,Write`,
      '--max-turns', question.task ? '150' : '60',
    ];
    if (model) cli.push('--model', model);
    if (hint && arm !== 'grep') cli.push('--append-system-prompt', JSON.stringify(hint));
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (/^CLAUDE_?CODE|^CLAUDECODE/i.test(k)) delete env[k];
    if (noDefer) env.ENABLE_TOOL_SEARCH = 'false';
    const started = Date.now();
    const child = spawn('claude', cli, { cwd: repo, env, shell: process.platform === 'win32' });
    let buf = '';
    let err = '';
    const rec = { id: question.id, arm, tools: {}, toolCalls: 0, resultChars: 0, mcpOk: null };
    const raw = process.env.AB_RAW ? [] : null;
    const onLine = line => {
      if (!line.trim()) return;
      if (raw) raw.push(line);
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.type === 'system' && msg.subtype === 'init') {
        rec.model = msg.model;
        const s = (msg.mcp_servers || []).find(x => x.name === 'clast');
        rec.mcpOk = s ? s.status : null;
      } else if (msg.type === 'assistant') {
        for (const part of msg.message?.content || []) {
          if (part.type === 'tool_use') {
            rec.toolCalls++;
            const name = part.name.replace(/^mcp__clast__/, '');
            rec.tools[name] = (rec.tools[name] || 0) + 1;
          }
        }
      } else if (msg.type === 'user') {
        for (const part of msg.message?.content || []) {
          if (part.type !== 'tool_result') continue;
          const c = part.content;
          rec.resultChars += typeof c === 'string' ? c.length : JSON.stringify(c ?? '').length;
        }
      } else if (msg.type === 'result') {
        const u = msg.usage || {};
        rec.answer = msg.result || '';
        rec.error = msg.is_error ? msg.subtype : undefined;
        rec.turns = msg.num_turns;
        rec.apiMs = msg.duration_api_ms;
        rec.cost = msg.total_cost_usd;
        rec.inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
        rec.freshInput = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        rec.outputTokens = u.output_tokens || 0;
      }
    };
    child.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on('data', d => { err += d; });
    child.stdin.end(question.task ? TASK_PROMPT(question.q) : PROMPT(question.q));
    child.on('close', code => {
      onLine(buf);
      rec.wallMs = Date.now() - started;
      if (raw) writeFileSync(join(process.env.AB_RAW, `${question.id}-${arm}-${started}.jsonl`), raw.join('\n'));
      if (rec.answer === undefined) rec.error = `exit ${code}: ${err.slice(-300)}`;
      if (question.task) {
        rec.diff = collectDiff();
        rec.diffLines = rec.diff.split('\n').filter(l => /^[+-][^+-]/.test(l)).length;
        rec.files = [...rec.diff.matchAll(/^diff --git a\/(\S+)/gm)].map(m => m[1]);
        resetRepo();
      }
      const answer = (question.task ? rec.diff : rec.answer || '').toLowerCase().replaceAll('\\', '/');
      const hits = question.expect.filter(e => answer.includes(e.toLowerCase()));
      rec.score = hits.length / question.expect.length;
      rec.missing = question.expect.filter(e => !hits.includes(e));
      done(rec);
    });
  });
}

const jobs = [];
for (let r = 0; r < runs; r++) for (const q of questions) for (const arm of arms) jobs.push({ q, arm, r });
const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const rec = await runOne(job.q, job.arm);
    rec.run = job.r;
    results.push(rec);
    console.error(
      `[${results.length}/${jobs.length}] ${rec.arm.padEnd(12)} ${rec.id.padEnd(30)} calls ${String(rec.toolCalls).padStart(3)} ` +
      `in ${String(rec.inputTokens ?? '?').padStart(8)} out ${String(rec.outputTokens ?? '?').padStart(6)} ` +
      `${(rec.wallMs / 1000).toFixed(0).padStart(4)} s  score ${rec.score.toFixed(2)}${rec.error ? '  ERROR ' + rec.error : ''}`
    );
  }
}
const lanes = questions.some(q => q.task) ? 1 : Math.min(parallel, jobs.length);
if (questions.some(q => q.task)) {
  if (git('status', '--porcelain').stdout.trim()) {
    console.error(`task runs reset the checkout after every session; ${repo} has uncommitted changes, refusing.`);
    process.exit(2);
  }
}
await Promise.all(Array.from({ length: lanes }, worker));

const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const summary = {};
for (const arm of arms) {
  const rows = results.filter(r => r.arm === arm && !r.error);
  const n = rows.length || 1;
  summary[arm] = {
    sessions: rows.length,
    errors: results.filter(r => r.arm === arm && r.error).length,
    toolCalls: +(sum(rows, r => r.toolCalls) / n).toFixed(1),
    toolResultChars: Math.round(sum(rows, r => r.resultChars) / n),
    inputTokens: Math.round(sum(rows, r => r.inputTokens) / n),
    freshInputTokens: Math.round(sum(rows, r => r.freshInput) / n),
    outputTokens: Math.round(sum(rows, r => r.outputTokens) / n),
    costUsd: +(sum(rows, r => r.cost) / n).toFixed(4),
    wallSecMean: +(sum(rows, r => r.wallMs) / n / 1000).toFixed(1),
    wallSecMedian: +(median(rows.map(r => r.wallMs)) / 1000).toFixed(1),
    score: +(sum(rows, r => r.score) / n).toFixed(3),
    fullyCorrect: rows.filter(r => r.score === 1).length,
  };
}
console.log(JSON.stringify({ repo, model: results[0]?.model, runs, questions: questions.length, summary }, null, 2));
if (out) writeFileSync(out, JSON.stringify({ repo, runs, summary, results }, null, 2));
