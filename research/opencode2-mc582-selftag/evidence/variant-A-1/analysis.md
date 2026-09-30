### variant-A-1 (variant A, session `ses_f0c09b40cffeqZbkt0EBvUNRUq`)

Model calls: 7 `response.create` frames on the WebSocket + 1 HTTP (title) = 8. Open files under the real opencode/cortexkit directories (lsof): lsof-during-turn-1.txt: 0, lsof-end.txt: 0. Replayed texts that also went on the wire (because the next request was a full resend) and equal the text in capture.jsonl: 3.

Model requests (WebSocket `response.create` frames):

| req | turn | sent as | host log | first differing item (full resends after request 1) | response items | input | cached | uncached | output |
|---|---|---|---|---|---|---|---|---|---|
| 1 (`observer.jsonl:3`) | 1 | full, 3 items | full | (first request) | text, shell×2 | 8903 | 0 | 8903 | 68 |
| 2 (`observer.jsonl:23`) | 1 | full, 8 items | full | input[3] message assistant: provider output "I’m about to run the two requested echo commands in parallel." vs client "§2§ I’m about to run the two requested echo commands in parallel." | text | 9002 | 8704 | 298 | 9 |
| 3 (`observer.jsonl:36`) | 2 | full, 10 items | full | input[8] message assistant: provider output "Both commands completed successfully." vs client "§5§ Both commands completed successfully." | reasoning, text, read×2 | 9064 | 0 | 9064 | 83 |
| 4 (`observer.jsonl:60`) | 2 | full, 16 items | full | input[11] message assistant: provider output "I’m about to read both requested files in parallel." vs client "§7§ I’m about to read both requested files in parallel." | text | 9220 | 8704 | 516 | 14 |
| 5 (`observer.jsonl:73`) | 3 | previous_response_id + 1-item delta | incremental | — | shell | 9260 | 8704 | 556 | 18 |
| 6 (`observer.jsonl:84`) | 3 | previous_response_id + 1-item delta | incremental | — | text | 9293 | 8704 | 589 | 12 |
| 7 (`observer.jsonl:97`) | 4 | previous_response_id + 1-item delta | incremental | — | text | 9316 | 8704 | 612 | 11 |

Assistant text items: raw model output, the host's stored copy, and the copy the client replayed in the next request:

| turn | req | item | phase | calls in same reply | raw model text | stored == raw | replayed by the client (after Magic Context) | replayed == raw |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | …3641b8 | commentary | 2 | `I’m about to run the two requested echo commands in parallel.` | yes | `§2§ I’m about to run the two requested echo commands in parallel.` | **no** |
| 1 | 2 | …6e0719 | final_answer | 0 | `Both commands completed successfully.` | yes | `§5§ Both commands completed successfully.` | **no** |
| 2 | 3 | …1ab7e5 | commentary | 2 | `I’m about to read both requested files in parallel.` | yes | `§7§ I’m about to read both requested files in parallel.` | **no** |
| 2 | 4 | …48ae12 | final_answer | 0 | `§10§ fixture.txt lists 3 apples.` | yes | same bytes | yes |
| 3 | 6 | …841513 | final_answer | 0 | `§13§ The command completed successfully.` | yes | same bytes | yes |
| 4 | 7 | …fdb481 | final_answer | 0 | `§15§ You’re welcome.` | yes | — (last reply, never replayed) | — |

