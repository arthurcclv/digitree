# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository. It covers the rules that apply to **every** package.
Each package carries its own `CLAUDE.md` with the rules specific to it — read
that one too before touching its code.

## Repo layout

Two packages, side by side. Not a monorepo: there are no workspaces and no root
`package.json`, so each package is entered and run on its own.

```
app/      the Vite + React map application — has its own CLAUDE.md
infra/    the local data stack and the raw extracts it loads
```

| package | what it is | entry point |
| --- | --- | --- |
| `app/` | A 3D map of Taipei on GeoLibre 3.0.0 over MapLibre, with a three.js custom layer. | `cd app && npm install && npm run dev` |
| `infra/` | Raw open-data extracts under `infra/data/` (gitignored), and the local PostGIS + Martin stack that serves them. | see `infra/` |

`app/` never imports from `infra/`. It reaches the data over HTTP like any other
tile source, so the app runs (minus those layers) with nothing else running.

## Workflow rules

These govern every package. `app/CLAUDE.md` adds the ones specific to layers.

- **Update the spec first, and get approval before implementing.** For any
  behavior change, write the spec or schema edit describing the new behavior and
  present it to the user for approval before writing implementation code. Don't
  code ahead of an approved spec change.
- **Keep the spec consistent with the implementation.** The two must never drift
  — a diff that changes behavior without a corresponding (approved) spec update
  is incomplete. When the two disagree, the spec wins.
- **Add tests for every new change.** New functionality or bug fixes need a
  corresponding test; don't rely on manual verification alone.
- **Keep the contributor docs current.** Each package's documentation set is
  orientation, not folklore — it must track the code same as the spec does. A
  change that alters module structure, adds or reverses a technical decision,
  introduces a new coding convention, or changes a dependency is incomplete
  until the matching doc is updated in the same change. New decisions append to
  the package's `DECISIONS.md` (newest at top); don't let a doc silently go
  stale.
