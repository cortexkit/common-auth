### variant-C-2 (variant C, session `ses_f0c0879b6ffepyJ1qTqXr3PJ0a`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 0.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | reasoning, text, shell×2 | 9046 | 3584 | 5462 | 101 |
| 2 (`observer.jsonl:25`) | 1 | previous_response_id + 2-item delta | incremental | — | reasoning, text | 9175 | 8704 | 471 | 28 |
| 3 (`observer.jsonl:40`) | 2 | previous_response_id + 1-item delta | incremental | — | reasoning, text, read×2 | 9253 | 8704 | 549 | 83 |
| 4 (`observer.jsonl:64`) | 2 | previous_response_id + 2-item delta | incremental | — | text | 9406 | 8704 | 702 | 14 |
| 5 (`observer.jsonl:77`) | 3 | previous_response_id + 1-item delta | incremental | — | reasoning, shell | 9446 | 8704 | 742 | 30 |
| 6 (`observer.jsonl:90`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9491 | 8704 | 787 | 12 |
| 7 (`observer.jsonl:103`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9514 | 8704 | 810 | 11 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …49d663 | commentary | 2 | `§2§ I’m about to run both echo commands in parallel.` | yes | same bytes | yes |
| 1 | 2 | …a83a41 | final_answer | 0 | `§5§ Both commands completed successfully.` | yes | same bytes | yes |
| 2 | 3 | …c390bd | commentary | 2 | `§7§ I’m about to read both files in parallel.` | yes | same bytes | yes |
| 2 | 4 | …b10b6e | final_answer | 0 | `§10§ fixture.txt lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …a03a35 | final_answer | 0 | `§13§ The command completed successfully.` | yes | same bytes | yes |
| 4 | 7 | …e6adb5 | final_answer | 0 | `§15§ You’re welcome!` | yes | — (last reply, never replayed) | — |

