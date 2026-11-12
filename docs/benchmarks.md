# Benchmarks

Three kinds of measurement: how an agent does with and without clast, how correct the answers are,
and how fast the index is. All were run on real open-source repositories.

## Clast against grep + read

### Repositories the model has never seen

Two public repositories created after the model's training data ends. Every expected answer was
confirmed with grep before the run; three runs per question (two for the refactor tasks). Each cell
reads clast / grep.

**[yetone/magpie](https://github.com/yetone/magpie)** - Go, 7,750 files, 1.5 million lines.

| Kind of work | Sessions per side | Tool calls (clast / grep) | Time | Tokens in | Tokens out | Correct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Multi-hop questions (call chains, implementers, tests that reach a function) | 15 | 1.9 / 5.7 | 14 s / 24 s | 124k / 223k | 0.5k / 1.1k | 15 / 15 |
| Code described by behaviour | 9 | 1.8 / 2.8 | 13 s / 16 s | 126k / 155k | 0.3k / 0.5k | 9 / 9 |
| One of many same-named methods | 9 | 2.0 / 2.7 | 16 s / 15 s | 157k / 146k | 0.4k / 0.5k | 9 / 9 |
| Counting | 6 | 1.5 / 1.5 | 14 s / 14 s | 112k / 105k | 0.6k / 0.7k | 6 / 6 |
| Dead code | 6 | 2.0 / 4.8 | 18 s / 33 s | 168k / 266k | 0.3k / 1.8k | 6 / 5 |
| Simple lookups (where is X, who calls X, what extends X) | 9 | 1.0 / 2.6 | 11 s / 15 s | 112k / 158k | 0.2k / 0.4k | 9 / 9 |
| Refactors (rename everywhere, add a parameter) | 4 | 8.5 / 9.3 | 27 s / 26 s | 188k / 178k | 1.5k / 1.7k | 4 / 4 |
| **All questions (refactors not counted)** | 54 | 1.7 / 3.6 | 14 s / 20 s | 132k / 180k | 0.4k / 0.8k | 54 / 53 |

**[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)** - TypeScript, 7,633 files, 1.6 million lines.

| Kind of work | Sessions per side | Tool calls (clast / grep) | Time | Tokens in | Tokens out | Correct |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Multi-hop questions (call chains, implementers, tests that reach a function) | 12 | 1.1 / 3.8 | 12 s / 20 s | 48k / 73k | 0.3k / 0.7k | 12 / 12 |
| Code described by behaviour | 6 | 1.2 / 2.3 | 11 s / 15 s | 49k / 66k | 0.2k / 0.4k | 6 / 6 |
| One of many same-named methods | 9 | 1.4 / 3.8 | 14 s / 20 s | 61k / 82k | 0.3k / 0.7k | 9 / 9 |
| Counting | 6 | 1.5 / 1.0 | 15 s / 19 s | 60k / 42k | 0.6k / 1.2k | 6 / 6 |
| Dead code | 6 | 2.0 / 3.3 | 18 s / 22 s | 64k / 89k | 0.3k / 0.7k | 6 / 6 |
| Simple lookups (where is X, who calls X, what extends X) | 12 | 1.0 / 2.8 | 11 s / 17 s | 47k / 65k | 0.3k / 0.5k | 12 / 12 |
| Refactors (rename everywhere, add a parameter) | 2 | 15.0 / 18.5 | 38 s / 51 s | 112k / 130k | 3.0k / 4.1k | 2 / 2 |
| **All questions (refactors not counted)** | 51 | 1.3 / 3.0 | 13 s / 19 s | 54k / 70k | 0.3k / 0.7k | 51 / 51 |

Across the 105 question sessions per side: 54% fewer tool calls, 30% less time, 26% fewer input
tokens.

Preparing these runs found errors in clast that no earlier repository had shown; all but one are
fixed in 0.4.0 (imports by package name in a monorepo, index re-exports, Go interfaces satisfied
through an embedded struct, an embedded struct reported as dead code, a library base class bound to
a same-named test class, four kinds of wrong dead-code reports in framework-style TypeScript). Not
fixed: a call through a TypeScript interface is not attributed to a class that matches the interface
by shape only, without an `implements` clause.

### One C++ application

Measured with real headless Claude Code sessions (`bench/ab.mjs`): every question runs in its own
fresh session, once with clast connected and once with only Read / Grep / Glob, on OnAir (C++, 7.5k
files, 1.6M lines). An earlier version of this page also had rows for vscode. They were removed: the
model knows vscode from its training and answers many questions about it from memory, so those rows
measured the model, not the tool. The index was fully built
before the first session. Answers are scored against facts verified in the source beforehand; an
implementation task is scored on its diff.

"Tokens in" is everything sent to the model over the session, "tokens out" what it wrote; both are
means per question. The fixed prompt goes out again on every turn, so fewer turns means fewer tokens
in. Price is not shown: it depends on how much of the prompt was already cached when a session
started, which varied between sessions of the same arm by a factor of twenty.

| Kind of work | Repo | Sessions per arm | Tool calls (clast / grep) | Wall time | Tokens in | Tokens out | Correct |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Multi-hop questions (call chains, transitive subclasses, impact) | OnAir | 18 | 1.2 / 5.9 | 12.5 s / 25.8 s | 50k / 118k | 0.5k / 1.2k | 18 / 18 |
| Simple lookups (where is X, who calls X, what implements X) | OnAir | 30 | 1.7 / 1.7 | 12.7 s / 14.3 s | 62k / 50k | 0.4k / 0.5k | 30 / 30 |
| Counting ("how many receiver classes under core/") | OnAir | 3 | 1.0 / 3.3 | 11 s / 34 s | 52k / 91k | 0.3k / 2.5k | 3 / 2 |
| Small implementation tasks (new provider, new enum value, new subclass) | OnAir | 6 | 11.5 / 12.8 | 39 s / 40 s | 185k / 172k | 2.5k / 2.7k | 6 / 6 |
| Cross-cutting refactors (rename a method, add a parameter and update all callers) | OnAir | 4 | 9.8 / 7.8 | 26 s / 25 s | 93k / 79k | 1.8k / 1.7k | 4 / 4 |
| Before a change (tests that reach a function, files to edit for a signature change, dead functions in a file) | OnAir | 9 | 1.7 / 3.6 | 14.3 s / 17.4 s | 59k / 73k | 0.4k / 0.8k | 9 / 9 |
| Find dead code in a directory ("five unused functions under app/", answers checked by hand) | OnAir | 2 | 2.0 / 16.0 | 20 s / 124 s | 82k / 928k | 0.6k / 9.5k | 2 / 2 |
| Questions that describe behaviour without naming anything ("what takes out the spike in the middle of the spectrum") | OnAir | 12 | 1.8 / 4.2 | 12.0 s / 20.5 s | 69k / 100k | 0.3k / 0.8k | 12 / 12 |
| One of many same-named methods ("which `reset` belongs to the Viterbi decoder") | OnAir | 12 | 1.0 / 3.6 | 11.2 s / 17.4 s | 53k / 68k | 0.2k / 0.6k | 12 / 12 |

What this says:

- **Multi-hop questions are where clast pays off**: half the time and less than half the tokens. One call returns a call chain or a full inheritance
  tree that grep needs three to twelve rounds for, and the agent reads 70-85% less tool output.
- **Simple lookups are a tie.** A current model with ripgrep answers them in one or two calls; clast
  does not make that faster, it only returns a little less text.
- **Counting is faster and exact** with `clast_stats`. With grep the agent tallied matches by hand and
  was off by one in one of three runs.
- **Finding dead code is the largest gap measured**: one `clast_unused` call and a confirming grep
  against 11-21 greps, a sixth of the time and a ninth of the tokens. Every function either arm
  named was verified unused, and all ten the grep sessions found are in clast's list.
- **Describing behaviour instead of naming it** works on a repository the model has never seen
  (OnAir): search over names, comments and what function bodies mention finds the place in one or two
  calls where grep needs four rounds of guessing words.
- **Questions before a change take fewer tokens, not always less time.** With `clast_impact` and
  `clast_unused` the agent reads less tool output and writes less. The clear win is "which
  tests reach this function when none names it": 1 call and 11 s against 5.7 calls and 22 s on OnAir.
  "Which files do I edit for a signature change" is one grep and stays a tie.
- **Implementation work showed no benefit**, neither small features nor cross-cutting refactors. Both
  arms made the same edits in the same files in the same time (refactors were also checked for
  completeness: nothing of the old name or call shape left). Finding every occurrence of one name is
  a single grep, and before editing the agent reads the neighbouring code either way. Clast sends
  more tokens here because its tool definitions are in the prompt on every turn.
- **Refactors after a guidance change.** In the rows above the clast sessions made about three extra
  calls on "add a parameter" tasks: they looked the callers up in clast and then grepped anyway. The
  server instructions now say to skip clast for a rename or signature change of a distinctive name.
  Re-run on OnAir (4 sessions per arm): 8.3 calls against 8.3, 26.9 s against 25.9 s, 104k tokens in
  against 81k, all correct, and no clast call in any session. What is left is the fixed prompt size.
- **One of many same-named methods.** Four questions on OnAir of the form "which `reset` belongs to
  the Viterbi decoder" (the repository has 1,157 methods called `reset`, 373 called `push`), 12
  sessions per arm: clast 1.0 call and 11.2 s, grep 3.6 calls and 17.4 s, all answers correct. Search
  ranks the definitions of a common name by the context words: the container, the doc comment, the
  calls in the body.
- **Small samples.** Two repositories, three runs per question, questions written by the tool's
  author. The figures show the direction, not a precise ratio.

One result changed the server itself. Claude Code defers MCP tools behind its tool search by default,
and in that state the agent never called clast: 0 of 60 sessions, every question answered with Grep.
The navigation tools now ask the client to keep them loaded, after which the agent used clast in every
question session where it helped.

The price of that is the size of the tool definitions in the prompt, sent again on every turn.
Measured with one trivial request and the same built-in tools each time:

| Setup | Prompt tokens | Added by clast |
| --- | ---: | ---: |
| No clast | 34,327 | |
| clast off for the project (no `.clast` folder) | 34,784 | 457 |
| clast on, six tools kept loaded (0.3.0) | 37,791 | 3,464 |
| clast on, eleven tools kept loaded (0.2.x) | 39,613 | 5,286 |

Six tools hold the behaviour. On a ten-question set (dead code, tests that reach a function,
same-named methods, behaviour descriptions, inheritance, call chains, counting; 20 sessions) the
six-tool server needed 1.2 calls and 12.2 s with 20 of 20 correct, against 1.4 calls and 12.7 s
with eleven tools loaded, and 4.5 calls and 22.3 s for plain grep (19 of 20). The multi-hop sets
stayed at 12 of 12 on both repositories.

A mode with no tools in the prompt at all (a skill plus a `clast` shell command, about 0.4k
tokens) was tried on the same set. Without a hint at session start the agent never ran the
command. With the hint it matched the tool mode on nine of ten question types, 2 to 4 s slower
each, but on counting it fell back to shell grep and hand tallies (6 to 14 calls). The tool
descriptions are what makes the agent choose the index; removing them removes the choice.

Reproduce with `node bench/ab.mjs <repo> bench/ab/<set>.json --runs 3`. The question sets are in
`bench/ab/`.

### Answer quality

Reviewer agents asked deliberately hard questions on 17 real repositories and checked every answer
against the source. Over the last five rounds the share of first answers judged correct rose from
roughly 45-60% to 65-78%, with new questions each round.

Two further audits read the cited source lines for call edges that clast shows as certain (no `?`):

| Repo | Language | Wrong | Checked |
| --- | --- | ---: | ---: |
| kafka | Java | 0 | 57 |
| tokio | Rust | 0 | 17 |
| laravel | PHP | 0 | 19 |
| vscode | TypeScript | 1 | 45 |
| django | Python | 1 | 39 |
| aspnetcore | C# | 1 | 58 |
| hugo | Go | 1 | 19 |
| rails | Ruby | 4 | 18 |

The vscode and aspnetcore errors were fixed afterwards; the django, hugo and rails ones are open (see
Known limitations).

## Speed and size

Measured with `npm run bench` (Node 24, Windows 11, Ryzen 9950X3D, up to 12 parser workers). Cold index is a first run on an
empty index; warm rescan is a restart with nothing changed.

<!-- BENCH:START -->
| repo | files | symbols | cold index | warm rescan | db size | search (name) | search (words) | symbol + callers/callees | callers depth 2 | references |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| vscode | 15726 | 461365 | 26.1 s | 1895 ms | 357 MB | 168 ms | 42 ms | 28 ms | 38 ms | 11 ms |
| aspnetcore | 11470 | 145271 | 10.2 s | 1382 ms | 135 MB | 9.3 ms | 86 ms | 33 ms | 38 ms | 6.6 ms |
| kafka | 6481 | 126393 | 9.5 s | 863 ms | 144 MB | 26 ms | 33 ms | 25 ms | 962 ms | 5.6 ms |
| rails | 3580 | 61549 | 3.8 s | 352 ms | 52 MB | 8.7 ms | 15 ms | 22 ms | 35 ms | 3.0 ms |
| framework | 3180 | 44124 | 3.0 s | 337 ms | 38 MB | 1.4 ms | 46 ms | 23 ms | 23 ms | 2.2 ms |
| django | 2987 | 60131 | 3.1 s | 522 ms | 42 MB | 29 ms | 41 ms | 21 ms | 48 ms | 2.5 ms |
| fastapi | 1224 | 10049 | 0.8 s | 161 ms | 7 MB | 5.0 ms | 17 ms | 5.7 ms | 48 ms | 2.4 ms |
| hugo | 939 | 16896 | 1.1 s | 127 ms | 11 MB | 7.2 ms | 38 ms | 18 ms | 18 ms | 2.4 ms |
| redis | 919 | 35752 | 1.9 s | 103 ms | 23 MB | 5.7 ms | 16 ms | 7.0 ms | 26 ms | 2.2 ms |
| tokio | 816 | 12341 | 1.1 s | 85 ms | 11 MB | 3.9 ms | 17 ms | 2.0 ms | 4.2 ms | 1.4 ms |
| http | 362 | 3947 | 0.7 s | 75 ms | 3 MB | 1.3 ms | 9.6 ms | 3.5 ms | 1.6 ms | 5.3 ms |
| express | 142 | 439 | 0.4 s | 20 ms | 1 MB | 0.4 ms | 1.0 ms | 0.8 ms | 0.5 ms | 1.6 ms |
| leveldb | 133 | 3456 | 0.6 s | 14 ms | 2 MB | 2.2 ms | 15 ms | 3.3 ms | 1.8 ms | 2.5 ms |
| Alamofire | 107 | 4085 | 1.5 s | 23 ms | 4 MB | 2.4 ms | 7.1 ms | 1.5 ms | 530 ms | 1.3 ms |
| ripgrep | 103 | 4496 | 0.6 s | 13 ms | 3 MB | 1.3 ms | 13 ms | 1.3 ms | 1.4 ms | 0.5 ms |
| gin | 99 | 2157 | 0.4 s | 12 ms | 2 MB | 1.5 ms | 7.7 ms | 2.2 ms | 4.3 ms | 0.7 ms |
| spring-petclinic | 50 | 323 | 0.2 s | 11 ms | 1 MB | 0.8 ms | 0.7 ms | 0.6 ms | 0.6 ms | 1.3 ms |

Node v24.7.0, win32 x64. Query times are medians of 5 in-process runs on the most-called function of each repo.
<!-- BENCH:END -->

Worst case measured: `callers IDisposable.dispose` on vscode (10.7k call sites, 4.7k definitions of
`dispose`) takes 5-6 s. Scoped with `within` it is fast.
