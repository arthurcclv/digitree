# ai/ — contributor and AI orientation

Orientation for the `taipei-3d` app. The **source of truth for any layer's
behaviour is that layer's `src/layers/<name>/specs/spec.md`**, not these files.
These explain the product, the structure, and the process around the specs.

| Doc | Read it when |
| --- | --- |
| [DESIGN.md](DESIGN.md) | you need to know what the app is for and what it refuses to be |
| [ARCHITECTURE.md](ARCHITECTURE.md) | you are adding a module, or wondering who is allowed to touch the map |
| [CONVENTIONS.md](CONVENTIONS.md) | you are writing code and want it to look like the rest |
| [DECISIONS.md](DECISIONS.md) | something looks wrong and you are about to "fix" it — newest entry at top |
| [WORKFLOWS.md](WORKFLOWS.md) | you are starting or finishing a change, or debugging a blank map |
| [STACK.md](STACK.md) | you are adding, removing, or upgrading a dependency |
| [VISUAL_DESIGN.md](VISUAL_DESIGN.md) | you are touching `src/styles.css` or building UI |

## Layer specs

| Layer | Spec |
| --- | --- |
| `basemaps` (extension — no layer record) | [`src/layers/basemaps/specs/spec.md`](../src/layers/basemaps/specs/spec.md) |
| `buildings` | [`src/layers/buildings/specs/spec.md`](../src/layers/buildings/specs/spec.md) |
| `tree` | [`src/layers/tree/specs/spec.md`](../src/layers/tree/specs/spec.md) |

## Keeping these honest

A change is incomplete if it invalidates one of these files and does not update
it in the same diff. Specifically: module structure → `ARCHITECTURE.md`; a new
or reversed technical decision → `DECISIONS.md` (append at top); a new coding
convention → `CONVENTIONS.md`; a dependency change → `STACK.md`; a colour, type,
spacing or component rule → `VISUAL_DESIGN.md`. Behaviour changes go through the
layer spec first, with approval, before implementation.
