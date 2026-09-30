### variant-A-2 (variant A, session `ses_f0c08e763ffeYa1gyOhXgJvp20`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 3.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | reasoning, text, shell×2 | 8903 | 0 | 8903 | 84 |
| 2 (`observer.jsonl:28`) | 1 | full, 9 items | full | input[4] message assistant: provider output "I’m about to run both requested echo commands in parallel." vs client "§2§ I’m about to run both requested echo commands in parallel." | text | 9018 | 8704 | 314 | 15 |
| 3 (`observer.jsonl:41`) | 2 | full, 11 items | full | input[9] message assistant: provider output "Both commands completed: `alpha` and `beta`." vs client "§5§ Both commands completed: `alpha` and `beta`." | reasoning, text, read×2 | 9086 | 8704 | 382 | 79 |
| 4 (`observer.jsonl:65`) | 2 | full, 17 items | full | input[12] message assistant: provider output "I’m about to read both requested files in parallel." vs client "§7§ I’m about to read both requested files in parallel." | text | 9238 | 8704 | 534 | 16 |
| 5 (`observer.jsonl:78`) | 3 | previous_response_id + 1-item delta | incremental | — | reasoning, shell | 9280 | 8704 | 576 | 30 |
| 6 (`observer.jsonl:91`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9325 | 8704 | 621 | 13 |
| 7 (`observer.jsonl:104`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9349 | 8704 | 645 | 8 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …2f3796 | commentary | 2 | `I’m about to run both requested echo commands in parallel.` | yes | `§2§ I’m about to run both requested echo commands in parallel.` | **no** |
| 1 | 2 | …e8abe7 | final_answer | 0 | `Both commands completed: \`alpha\` and \`beta\`.` | yes | `§5§ Both commands completed: \`alpha\` and \`beta\`.` | **no** |
| 2 | 3 | …206e1b | commentary | 2 | `I’m about to read both requested files in parallel.` | yes | `§7§ I’m about to read both requested files in parallel.` | **no** |
| 2 | 4 | …71b4eb | final_answer | 0 | `§10§ \`fixture.txt\` lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …52d919 | final_answer | 0 | `§13§ The command returned \`gamma\`.` | yes | same bytes | yes |
| 4 | 7 | …1738d4 | final_answer | 0 | `You’re welcome!` | yes | — (last reply, never replayed) | — |

