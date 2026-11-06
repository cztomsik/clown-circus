# Clown-Circus — Remote (ssh://) sessions: known limitations & TODOs

Known, accepted-for-now gaps in remote (`ssh://`) sessions — the working
directory lives on the remote host, reached over ssh (`server/remote.ts`;
design in SPEC §7.2/§9/§12/§14). Everything here works as documented today;
this list tracks what is deliberately missing so it isn't lost.

## Remote sessions have no project context file or skills

A remote session's system prompt omits the **skills** section and the
`AGENTS.md` context file entirely (SPEC §9; `buildSystemPrompt`
in `server/prompt.ts` takes the `REMOTE` tail). Skill discovery and the
context file are read from the **local** filesystem, but a remote session's
directory is on the far side of ssh — there is no code path to fetch them
there.

Consequence: a remote session cannot pick up project instructions from an
`AGENTS.md` on the remote host, and no skills are listed in its
prompt (the prompt instead carries a short "Remote Session" section).

Possible follow-up: fetch `AGENTS.md` from the remote dir over ssh
(one-shot, like `readFile`) and include them in the prompt; optionally
discover remote skills (`<dir>/.agents/skills/`) the same way. Deferred for
the PoC.

## Remote file ops assume GNU `base64`

The remote scripts decode base64 with `base64 -d` (GNU coreutils) —
`server/remote.ts` (`validate`, `readFile`, `writeFile`, `reap`, window
launch). BSD `base64` (macOS) uses `-D` instead, so on a macOS remote the
decode fails and every file op and the create-time validation misreport: an
existing dir reads as missing (`404 not_found`) and `create: true` fails
(`500 internal`).

Possible follow-up: either document remote sessions as Linux-only, or add a
decode fallback (try `base64 -d`, fall back to `base64 -D` — or detect once
in `validate()` and pick the flag for the session's lifetime).
