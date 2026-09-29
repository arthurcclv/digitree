# Derived-layer DAG — spec

Source of truth for how one layer's computed output feeds another's. Behaviour
changes here require this file to change first.

Module: `src/lib/dag/` — `graph.ts` (the graph) and `graph.test.ts`. It is pure
TypeScript: no three.js, no MapLibre, no React.

## Purpose

Some layers compute a field that other layers derive from. The first edge is
direct sun → temperature: the temperature layer's PET is a function of the
sunlight layer's LPI. The graph makes those dependencies explicit so that:

- a change upstream (a new sun time, new tiles, a new light pass) reaches every
  layer downstream of it, however deep, without either layer knowing the other;
- a layer that nothing displays does no work, and a layer that is hidden but
  feeds a displayed one does its work anyway;
- adding a third derived layer is a new node and an edge, not new wiring in the
  engine.

It does not schedule GPU work. Each layer still does its work in its own
`prerender`, as today. The graph only says **what is current** and **what is
wanted**.

## Nodes

A node is one computed output, named `<layer>.<output>`:

| node | produced by | depends on | value |
| --- | --- | --- | --- |
| `sunlight.lpi` | the sunlight layer | — | `LpiField` (see the sunlight spec, *The LPI node*) |
| `temperature.pet` | the temperature layer | `sunlight.lpi` | `PetField` (see the temperature spec, *The PET node*) |

Each node has:
- `id`, and `deps`, its upstream node ids, fixed when it is added;
- `value`, the last published output, or `null` when there is none;
- `version`, a counter bumped on every publish and every clear;
- `state`, its layer's state as a string (`"off"` until the layer sets one).
  It says **why** there is no value (`zoom`, `low-sun`, `waiting`, …), which a
  dependent needs in order to report its own state;
- `ownDemand`, whether its own layer displays it (its overlay is on).

## Operations

`createGraph()` returns an empty graph with:

- **`add(id, deps)`**. It throws if `id` exists, if a dep is unknown, or if the
  edge would close a cycle. Because every dep must already exist, nodes are
  added in topological order and a cycle cannot form; the check is kept anyway,
  and tested.
- **`publish(id, value)`**. Sets the value, bumps the version, and notifies
  every **transitive dependent**, each once, in topological order.
- **`clear(id)`**. Sets the value to `null` (the node has no current result:
  it went `off`, `zoom`, `low-sun`, …), bumps the version, and notifies
  dependents as `publish` does.
- **`value(id)`**, **`version(id)`**. Read the current output.
- **`setState(id, state)`**. Sets the node's state. When the state actually
  changes, every transitive dependent is notified as `publish` does; the
  version is not bumped. It is allowed inside a notification, as `clear` is,
  because a layer's state changes inside its own demand listener.
- **`state(id)`**. Reads the current state.
- **`setOwnDemand(id, on)`**. Sets `ownDemand`, then recomputes `demanded` for
  that node and every node upstream of it, and notifies each node whose
  `demanded` changed.
- **`demanded(id)`**. True when `ownDemand` is set, or any direct dependent is
  demanded. A node that is not demanded is not computed.
- **`subscribe(id, listener)`**. The listener is called with
  `{ kind: "upstream", from }` when an upstream node publishes, clears or
  changes state, and
  with `{ kind: "demand", demanded }` when `demanded(id)` changes. It returns
  an unsubscribe function.

Notifications are synchronous. A listener must not publish from inside a
notification; it marks its layer dirty and publishes from its own `prerender`.
`publish` from inside a listener throws, so a re-entrant loop cannot hide.

## Ownership

- The host (`useMapEngine.ts`) creates the one graph and passes it to every
  layer mount (`src/lib/mount/specs/spec.md`). Nothing else creates a graph.
- Each layer's **mount adds its own node**, with its deps. Mount order is
  therefore topological order: a dependent mounted before its upstream throws
  on `add`. The host never names a node.
- A layer publishes, clears and sets the state of only **its own** node, and
  reads only the nodes it declared as deps. **Everything a dependent needs
  from upstream arrives through the graph**, value and state alike. No host
  wiring forwards one layer's status to another.
- A layer's overlay visibility sets its node's `ownDemand`. The mount sets
  it directly (`setVisibility`) in its `update`, not through GeoLibre's paint
  bridge. Its **compute** is gated on `demanded`, its
  **drawing** on its own visibility. The two differ exactly when a hidden
  layer feeds a shown one.
- A layer's GeoLibre record is **visible while its node is demanded**, so
  MapLibre keeps running its `prerender` (MapLibre skips hidden layers). The
  host applies every update before any `prepareSync`, so each record reads
  the final demand.

## Invariants

All asserted by vitest.

1. `add` rejects a duplicate id, an unknown dep, and a cycle.
2. `publish` on a node notifies each transitive dependent exactly once, in
   topological order, and bumps only that node's version.
3. `clear` notifies dependents as `publish` does, and leaves `value` `null`.
4. `demanded` is true for a node with `ownDemand`, for every node upstream of
   one, and false otherwise. Turning a downstream `ownDemand` off makes an
   upstream node undemanded unless it has its own demand or another demanded
   dependent.
5. A demand listener fires only when `demanded` actually changes.
6. `publish` from inside a listener throws.
7. `state` is `"off"` for a new node. `setState` notifies each transitive
   dependent once when the state changes and not at all when it is unchanged,
   leaves `version` alone, and is allowed inside a notification.

## Out of scope

- Scheduling or ordering GPU work across layers.
- Caching values by input hash; a node's value is simply its last publish.
- Nodes with no layer (pure computations). Every node belongs to a layer
  today; a layerless node is a later change to this spec.
