# Owner market notes

Updated: 2026-11-11. Research only. An owner market note is a dated piece of market context that the owner sends: a reel, an article or plain text. Vertex stores the note in Postgres, shows it on `/markets` and gives it to the agents as context. A note never changes an order, the arm state, a size or a risk setting, and no procedure on this page has a broker client.

A note is a third-party opinion until its claims are checked. Each claim has its own status, and every surface that shows a note also shows the claim statuses.

## One line for the orchestrator

When the owner sends a link or a text as market context, run this on the rig:

```sh
vertex-market-note add "<url or text>" --owner-message "<link to the owner's message>"
```

Then check the claims (see [Verification](#verification)). The command prints the note id, the theme and the claims with their ids. A second run with the same source prints `already stored: <id>` and changes nothing. The as-of date is the upload date of a reel, or today. The default review date is 30 days after the day of intake; `--as-of` and `--review-by` set other dates.

## Data

Table `market_notes` (migration `0072_market_notes.sql`, repository `packages/db/src/server/market-notes.ts`, contract `packages/api/src/contracts/market-notes.ts`).

| Field | Meaning |
| --- | --- |
| `id` | Note id. |
| `receivedAt` | When the owner sent the note. |
| `asOf` | The market date the note speaks about. |
| `source` | `kind` (`reel`, `article` or `owner-text`), `url` and `author`. |
| `rawText` | The transcript or the text as received. Only `marketNotes.get` returns it. |
| `theme` | One line. |
| `claims` | 1 to 12 claims. Each claim has an id (`c1` to `c12`), a text and a status. |
| `affected` | Sectors, tickers and strategies or sleeves. |
| `stance` | `risk-on`, `risk-off` or `neutral`, with a confidence of `low`, `medium` or `high`. |
| `reviewBy` | The date by which someone must look at the note again. |
| `status` | `active`, `expired` or `retired`. |
| `ownerMessageUrl` | Link to the owner's message. |

Claim statuses:

| Status | Meaning |
| --- | --- |
| `unverified` | Nobody checked the claim. It has no evidence. |
| `supported` | Data agrees with the claim. The evidence text names the data. |
| `contradicted` | Data disagrees with the claim. The evidence text names the data. |
| `cannot-check` | The data that Vertex holds cannot decide the claim. The evidence text says what is missing. |

A checked claim always has evidence text and a check time. The contract does not accept a checked claim without evidence.

Note status:

- The table stores `active` or `retired` only.
- `expired` is derived: the review date is before today (UTC). No job has to change a column.
- An expired note shows as stale on `/markets` and is left out of agent context. `renew` sets a new review date, and the note is active again.
- `add` accepts a review date in the past (a backfill of an old note). The row is stored as `active`. The API reports the note as `expired` from the first read, and the intake prints a notice.
- `retired` is final. There is no delete: retire a note that is wrong or no longer useful.

One source gives one note. The unique key is the source URL with the scheme read as https, a lower-case host without a leading `www.`, no fragment, no tracking parameters (`utm_*` and `fbclid` on every host, `igsh` and `igshid` on Instagram, `si` on YouTube) and the other query parameters in sorted order. Plain owner text uses a hash of the text. Two link forms of one item on different hosts or paths (for example `youtu.be/<id>` and `youtube.com/watch?v=<id>`) count as two sources.

## API

All procedures are operator-only (`marketNotes.*`).

| Procedure | Access | Use |
| --- | --- | --- |
| `marketNotes.list` | Operator session, agent viewer or agent read key | Notes, newest first, without raw text. `scope: "active"` leaves out expired and retired notes. `scope: "all"` holds the newest 50 active notes and fills up to 100 rows with the newest notes of any status; `truncated` is true when older rows are left out. `sourceUrl` returns only the note for that source. |
| `marketNotes.get` | Same as `list` | One note with its raw text. |
| `marketNotes.add` | Operator agent write key only | Stores one note. All claims start as `unverified`. A second add of the same source returns the stored note with `created: false`. The review date must be within 366 days. |
| `marketNotes.recordChecks` | Operator agent write key only | Records a status and evidence for one or more claims. A second check of a claim replaces the first. A retired note takes no checks. |
| `marketNotes.review` | Operator agent write key only | `renew` sets a new review date (today or later, within 366 days). `retire` is final. |

A read key gets 403 on the write procedures, and so does a browser session.

## Intake on the rig

The intake is a Python CLI in `services/research/market_notes/` (`python -m market_notes.cli`). The rig wrapper `infra/market-notes/vertex-market-note` runs it from the runner checkout with the operator write key.

`add` does these steps:

1. For a URL, it asks `marketNotes.list` for that source. When the note exists, it stops.
2. Reel or video: it downloads the audio with yt-dlp. The link must be https. It passes `--ignore-config --no-cookies --no-cookies-from-browser --no-plugin-dirs`, a file size limit of 300 MB and a filter that refuses live streams and media longer than one hour. It never uses a browser or a cookie file. The child process gets a short allow-list of environment variables, so no key reaches it.
3. It transcribes the audio on the rig GPU with the external tool `transcribe.py` (faster-whisper large-v3). That tool takes its work directory from its own location, so the intake runs an unmodified copy in a work directory for this note. Before the run the intake parses the script and refuses it unless it has one `MIN_FREE_MIB` assignment of at least 4096 that the script compares against, and every `device=` argument is the constant `"cuda"`. There is no CPU path: when the GPU gate does not open before the timeout, the command fails. A stop signal to the command also stops the child process and removes the work directory.
4. Article: it fetches the page over https and reduces the HTML to text. It refuses a host that resolves to a private, loopback or link-local address. When the page gives too little text, pass the text with `--transcript-file`.
5. It extracts the theme, the claims, the affected area and the stance with Claude through the local OMP login (`agents/omp_claude.py`). The prompt marks the text as untrusted third-party data. The flags `--theme` and `--claim` supply the extraction by hand and skip the model.
6. It calls `marketNotes.add`.

Other commands:

| Command | Use |
| --- | --- |
| `vertex-market-note list [--scope active\|all] [--format text\|json]` | Prints the notes with each claim status. The default scope is `active`. The text form is the block for a report. |
| `vertex-market-note evidence <id> [--ticker T] [--quarters 8] [--format text\|json]` | Prints a data pack for the note's tickers from Financial Datasets: operating cash flow, capital expenditure, free cash flow, debt and equity issuance per quarter and for the last four quarters. No model call. One request per ticker. |
| `vertex-market-note check <id> --claim c1 --status supported --evidence "<text>"` | Records one claim check. |
| `vertex-market-note renew <id> --review-by <date>` | Sets a new review date. |
| `vertex-market-note retire <id>` | Retires the note. |

## Verification

A note does not count as fact until its claims are checked.

1. Run `vertex-market-note evidence <id>` and read the numbers. Use other data that Vertex holds when a claim needs it (prices, macro series).
2. For each claim, run `vertex-market-note check` with the status and an evidence text that names the source, the period and the numbers.
3. Use `cannot-check` when the data cannot decide the claim, and say what is missing. Do not mark a forecast or an opinion as `supported`.

The Financial Datasets rights mode is research-only. Evidence text holds a few derived figures and the source name, not the vendor payload.

## Where the notes are used

- `/markets` has the section "Owner market notes" (`apps/web/src/components/portal/owner-market-notes-card.tsx`): date, source, theme, stance, claim statuses and review date. A stale note has a visible label. Retired notes are hidden.
- The in-app assistant gets a block with the active notes in its system prompt (`marketNoteContextLines` in `packages/api/src/market-notes.ts`). Each note line has the date and the verification counts, and each claim line starts with its status. The block is absent when no note is active. The block holds the theme and the claims, never the raw text. It holds at most 5 notes and 8,000 characters, newest first, and it says how many active notes it left out. The newest active note is always in the block: when it is too long, the block holds the claims that fit and says how many claims it left out. Every field is reduced to one line of plain text before it enters the block.
- Research agents read the same block with the MCP tool `market_notes_list` on `/api/mcp`. The in-app assistant does not get this tool, because the recorded semantic-layer eval depends on the exact tool list.
- The allocation scripts `research/backtests/allocation/run.py` and `funded_pie.py` accept `--market-notes`. The flag adds the key `ownerMarketNotes` to the output document. The notes are reported as inputs with their status. No weight, gate, cap or size reads them.
- A consult or a regime report on the rig pastes the output of `vertex-market-note list --scope active` as its "owner market notes" input block.

## Rig setup

- Runner checkout: the same detached worktree that the breadth-90 tick uses (see `breadth-90.md`).
- Research interpreter: a Python 3.12 environment named `.venv` in the `services/research` folder of the runner checkout. In that folder run `uv venv --python 3.12 .venv`, then `VIRTUAL_ENV=.venv uv pip sync --require-hashes requirements-linux-py312.lock`. The wrapper exits 127 with this hint when the interpreter is missing.
- Wrapper: copy `infra/market-notes/vertex-market-note` to `~/.local/bin/` (mode 0755).
- Nonsecret settings: `~/.config/vertex/market-notes.env`. Write absolute paths. The file must belong to the current user, and the wrapper refuses a settings file that the group or others can write. When `VERTEX_API_URL` in the calling shell and `VERTEX_ORIGIN` in the file name different origins, the wrapper stops: the write key goes only to the configured origin.
- Write key: a file that only its owner can read (mode 0600). The wrapper refuses any other mode. The key is never printed.

| Variable | Default | Use |
| --- | --- | --- |
| `VERTEX_ORIGIN` | none | Portal origin (`VERTEX_API_URL` also works). |
| `MARKET_NOTES_KEY_FILE` | `~/.config/vertex/agent-write-key` | Path of the operator write key file. |
| `MARKET_NOTES_RUNNER_DIR` | `~/Github/trading/vertex-research-public-ticks-runner` | Runner checkout. |
| `MARKET_NOTES_PYTHON` | `.venv/bin/python` in the `services/research` folder of the runner checkout | Research interpreter. |
| `MARKET_NOTES_ENV_FILE` | `~/.config/vertex/market-notes.env` | Path of the settings file. Set it in the calling environment. |
| `VERTEX_MARKET_NOTE_YTDLP` | `yt-dlp` on `PATH` | yt-dlp binary. |
| `VERTEX_MARKET_NOTE_TRANSCRIBE` | `~/Github/tools/ig-kb-systemcracker/transcribe.py` | Path of `transcribe.py`. |
| `VERTEX_MARKET_NOTE_TRANSCRIBE_PYTHON` | `.venv/bin/python` beside `transcribe.py` | Interpreter for `transcribe.py`. |
| `VERTEX_OMP_BIN` | `~/.local/bin/omp` | The omp binary for the claim extraction. |
| `FINANCIAL_DATASETS_API_KEY` | none | Only for `evidence`. Set it in the calling environment, not in the settings file. |

## Rollback

- Web: remove `OwnerMarketNotesCard` from the markets page.
- API: remove `marketNotes` from `packages/api/src/contract.ts` and `packages/api/src/server/router.ts`, the `marketNotes.*` entries from `AGENT_API_KEY_PROCEDURE_PATHS` and `AGENT_API_KEY_READ_PROCEDURES`, the MCP tool and the assistant block; regenerate `packages/api/openapi.json`.
- Database: `packages/db/rollback/0072_market_notes.down.sql` drops the table. It refuses while the table has rows, so owner notes are never discarded without a decision.
