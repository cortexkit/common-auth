### variant-A-3 (variant A, session `ses_f0c08116bffek3EIqOSNUqJE2l`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 3.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | reasoning, text, shell×2 | 8903 | 0 | 8903 | 85 |
| 2 (`observer.jsonl:25`) | 1 | full, 9 items | full | input[4] message assistant: provider output "I’m about to run the two requested echo commands in parallel." vs client "§2§ I’m about to run the two requested echo commands in parallel." | text | 9019 | 8704 | 315 | 16 |
| 3 (`observer.jsonl:38`) | 2 | full, 11 items | full | input[9] message assistant: provider output "Both commands completed successfully: `alpha` and `beta`." vs client "§5§ Both commands completed successfully: `alpha` and `beta`." | reasoning, text, read×2 | 9088 | 8704 | 384 | 78 |
| 4 (`observer.jsonl:59`) | 2 | full, 17 items | full | input[12] message assistant: provider output "I’m about to read both requested files in parallel." vs client "§7§ I’m about to read both requested files in parallel." | text | 9239 | 8704 | 535 | 14 |
| 5 (`observer.jsonl:72`) | 3 | previous_response_id + 1-item delta | incremental | — | shell | 9279 | 0 | 9279 | 18 |
| 6 (`observer.jsonl:83`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9312 | 8704 | 608 | 14 |
| 7 (`observer.jsonl:96`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9337 | 8704 | 633 | 8 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …309119 | commentary | 2 | `I’m about to run the two requested echo commands in parallel.` | yes | `§2§ I’m about to run the two requested echo commands in parallel.` | **no** |
| 1 | 2 | …cedfc5 | final_answer | 0 | `Both commands completed successfully: \`alpha\` and \`beta\`.` | yes | `§5§ Both commands completed successfully: \`alpha\` and \`beta\`.` | **no** |
| 2 | 3 | …7b8bd7 | commentary | 2 | `I’m about to read both requested files in parallel.` | yes | `§7§ I’m about to read both requested files in parallel.` | **no** |
| 2 | 4 | …20271a | final_answer | 0 | `§10§ fixture.txt lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …b6fbf6 | final_answer | 0 | `§13§ \`echo gamma\` completed successfully.` | yes | same bytes | yes |
| 4 | 7 | …4a1a64 | final_answer | 0 | `You’re welcome!` | yes | — (last reply, never replayed) | — |

