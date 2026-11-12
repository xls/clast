# Benchmarks

Three kinds of measurement: how an agent does with and without clast, how correct the answers are,
and how fast the index is. All were run on real open-source repositories.

## Clast against grep + read

Measured with real headless Claude Code sessions (`bench/ab.mjs`): every question runs in its own
fresh session, once with clast connected and once with only Read / Grep / Glob. Two large repositories:
vscode (TypeScript, 15.7k files) and OnAir (C++, 7.5k files, 1.6M lines). The index was fully built
before the first session. Answers are scored against facts verified in the source beforehand; an
implementation task is scored on its diff.

"Cost" is the API-price equivalent that Claude Code reports for the session. It weights fresh input and
output above cached prompt tokens, so it is the closest single number to "tokens that matter".

| Kind of work | Repo | Sessions per arm | Tool calls (clast / grep) | Wall time | Cost per question | Correct |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Multi-hop questions (call chains, transitive subclasses, impact) | vscode | 18 | 1.3 / 3.1 | 16.0 s / 19.8 s | $0.063 / $0.126 | 18 / 18 |
| Multi-hop questions | OnAir | 18 | 1.2 / 5.9 | 12.5 s / 25.8 s | $0.056 / $0.212 | 18 / 18 |
| Simple lookups (where is X, who calls X, what implements X) | vscode | 30 | 1.4 / 1.4 | 13.9 s / 13.9 s | $0.053 / $0.059 | 30 / 29 |
| Simple lookups | OnAir | 30 | 1.7 / 1.7 | 12.7 s / 14.3 s | $0.063 / $0.096 | 30 / 30 |
| Counting ("how many receiver classes under core/") | OnAir | 3 | 1.0 / 3.3 | 11 s / 34 s | about $0.02 / $0.29 | 3 / 2 |
| Small implementation tasks (new provider, new enum value, new subclass) | vscode | 6 | 7.5 / 8.5 | 30 s / 31 s | $0.29 / $0.24 | 6 / 6 |
| Small implementation tasks | OnAir | 6 | 11.5 / 12.8 | 39 s / 40 s | $0.58 / $0.56 | 6 / 6 |
| Cross-cutting refactors (rename a method in 28 files, add a parameter and update all callers) | vscode | 4 | 21.8 / 22.0 | 47 s / 48 s | $0.45 / $0.37 | 4 / 4 |
| Cross-cutting refactors | OnAir | 4 | 9.8 / 7.8 | 26 s / 25 s | $0.25 / $0.24 | 4 / 4 |
| Before a change (tests that reach a function, files to edit for a signature change, dead functions in a file) | vscode | 9 | 2.3 / 2.2 | 19.3 s / 19.8 s | $0.098 / $0.154 | 9 / 9 |
| Before a change | OnAir | 9 | 1.7 / 3.6 | 14.3 s / 17.4 s | $0.126 / $0.173 | 9 / 9 |
| Find dead code in a directory ("five unused functions under app/", answers checked by hand) | OnAir | 2 | 2.0 / 16.0 | 20 s / 124 s | $0.15 / $1.89 | 2 / 2 |
| Questions that describe behaviour without naming anything ("what takes out the spike in the middle of the spectrum") | OnAir | 12 | 1.8 / 4.2 | 12.0 s / 20.5 s | $0.068 / $0.197 | 12 / 12 |
| Questions that describe behaviour | vscode | 12 | 1.0 / 1.0 | 11.7 s / 11.8 s | $0.048 / $0.044 | 12 / 12 |

What this says:

- **Multi-hop questions are where clast pays off**: half the cost and 20% less time on vscode, a
  quarter of the cost and half the time on OnAir. One call returns a call chain or a full inheritance
  tree that grep needs three to twelve rounds for, and the agent reads 70-85% less tool output.
- **Simple lookups are a tie.** A current model with ripgrep answers them in one or two calls; clast
  does not make that faster, it only returns a little less text.
- **Counting is faster and exact** with `clast_stats`. With grep the agent tallied matches by hand and
  was off by one in one of three runs.
- **Finding dead code is the largest gap measured**: one `clast_unused` call and a confirming grep
  against 11-21 greps, a sixth of the time and a thirteenth of the cost. Every function either arm
  named was verified unused, and all ten the grep sessions found are in clast's list.
- **Describing behaviour instead of naming it** works on a repository the model has never seen
  (OnAir): search over names, comments and what function bodies mention finds the place in one or two
  calls where grep needs four rounds of guessing words. On vscode it is a tie at one call, because the
  model already knows where things are in vscode; that row measures the model's memory, not the tools.
- **Questions before a change are cheaper, not always faster.** With `clast_impact` and `clast_unused`
  the sessions cost 27-36% less because the agent reads less tool output. The clear win is "which
  tests reach this function when none names it": 1 call and 11 s against 5.7 calls and 22 s on OnAir.
  "Which files do I edit for a signature change" is one grep and stays a tie.
- **Implementation work showed no benefit**, neither small features nor cross-cutting refactors. Both
  arms made the same edits in the same files in the same time (refactors were also checked for
  completeness: nothing of the old name or call shape left). Finding every occurrence of one name is
  a single grep, and before editing the agent reads the neighbouring code either way. Clast costs a
  little more here because its tool definitions are in the prompt.
- **Refactors after a guidance change.** In the rows above the clast sessions made about three extra
  calls on "add a parameter" tasks: they looked the callers up in clast and then grepped anyway. The
  server instructions now say to skip clast for a rename or signature change of a distinctive name.
  Re-run on OnAir (4 sessions per arm): 8.3 calls against 8.3, 26.9 s against 25.9 s, $0.26 against
  $0.25, all correct, and no clast call in any session. What is left is the fixed prompt cost.
- **One of many same-named methods.** Four questions on OnAir of the form "which `reset` belongs to
  the Viterbi decoder" (the repository has 1,157 methods called `reset`, 373 called `push`), 12
  sessions per arm: clast 1.0 call and 11.2 s, grep 3.6 calls and 17.4 s, all answers correct. Median
  cost $0.06 against $0.13. The mean is $0.12 against $0.11, because the first two clast sessions
  wrote the whole prompt into the cache ($0.45 each, a one-off that the other ten reused). Search ranks the definitions of a common name by the context words:
  the container, the doc comment, the calls in the body.
- **Small samples.** Two repositories, three runs per question, questions written by the tool's
  author. The figures show the direction, not a precise ratio.

One result changed the server itself. Claude Code defers MCP tools behind its tool search by default,
and in that state the agent never called clast: 0 of 60 sessions, every question answered with Grep.
The navigation tools now ask the client to keep them loaded, after which the agent used clast in every
question session where it helped. The cost is about 5k tokens of tool definitions and instructions in
the cached prompt (measured with 13 tools: 23.7k against 19.3k prompt tokens for a session that calls
no tool; `clast_impact` and `clast_unused` add about 0.6k).

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
