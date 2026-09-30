### variant-C-1 (variant C, session `ses_f0c0942dfffeEawNdfmeZ3IUMx`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 0.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | reasoning, text, shell×2 | 9046 | 0 | 9046 | 91 |
| 2 (`observer.jsonl:28`) | 1 | previous_response_id + 2-item delta | incremental | — | reasoning, text | 9165 | 8704 | 461 | 24 |
| 3 (`observer.jsonl:46`) | 2 | previous_response_id + 1-item delta | incremental | — | reasoning, text, read×2 | 9239 | 8704 | 535 | 86 |
| 4 (`observer.jsonl:70`) | 2 | previous_response_id + 2-item delta | incremental | — | text | 9395 | 8704 | 691 | 14 |
| 5 (`observer.jsonl:83`) | 3 | previous_response_id + 1-item delta | incremental | — | reasoning, shell | 9435 | 0 | 9435 | 30 |
| 6 (`observer.jsonl:96`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9480 | 8704 | 776 | 12 |
| 7 (`observer.jsonl:109`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9503 | 8704 | 799 | 11 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …cc07b1 | commentary | 2 | `§2§ I’m about to run both requested echo commands in parallel.` | yes | same bytes | yes |
| 1 | 2 | …4d96cf | final_answer | 0 | `§5§ Both commands completed successfully.` | yes | same bytes | yes |
| 2 | 3 | …a2031b | commentary | 2 | `§7§ I’m about to read both files in parallel.` | yes | same bytes | yes |
| 2 | 4 | …0fff66 | final_answer | 0 | `§10§ fixture.txt lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …05216e | final_answer | 0 | `§13§ The command printed gamma.` | yes | same bytes | yes |
| 4 | 7 | …91e734 | final_answer | 0 | `§15§ You’re welcome!` | yes | — (last reply, never replayed) | — |

