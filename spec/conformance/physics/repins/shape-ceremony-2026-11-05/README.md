# Receipt: shape-ceremony re-pin (2026-11-05)

These are the old fixture bytes the acknowledgement in `../../fixture-repins.json` hashes and replays.

The failure that made this directory necessary:

| | |
|---|---|
| red control | GitHub Actions run 42188931351 |
| failed head | `28d732e7c`, tested as GitHub's synthetic merge onto #22 |
| failure | `engine` red on Ubuntu, macOS and Windows: the acknowledgement depended on linear Git ancestry, so the current reader hit pre-rename old logs and threw Malformed `op` |
| repaired head | `f0c5d187b`: the old bytes travel here and are hash-checked before any replay |
| replacement run | 42192570187: Ubuntu, macOS and Windows 217/0/0 |

No test or semantic change; this file only records why the bytes are here.
