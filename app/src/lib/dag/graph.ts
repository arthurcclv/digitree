/**
 * The derived-layer DAG: which layer outputs feed which, what is current, and
 * what is wanted. Pure — no three.js, no MapLibre. See `specs/spec.md`.
 */

export type GraphEvent =
  | { kind: "upstream"; from: string }
  | { kind: "demand"; demanded: boolean };

export type GraphListener = (event: GraphEvent) => void;

export interface Graph {
  add(id: string, deps: readonly string[]): void;
  publish<T>(id: string, value: T): void;
  clear(id: string): void;
  value<T>(id: string): T | null;
  version(id: string): number;
  setState(id: string, state: string): void;
  state<S extends string = string>(id: string): S;
  setOwnDemand(id: string, on: boolean): void;
  demanded(id: string): boolean;
  subscribe(id: string, listener: GraphListener): () => void;
}

interface Node {
  deps: readonly string[];
  dependents: string[];
  value: unknown;
  version: number;
  state: string;
  ownDemand: boolean;
  demanded: boolean;
  listeners: Set<GraphListener>;
}

export function createGraph(): Graph {
  const nodes = new Map<string, Node>();
  // Insertion order. Every dep exists before its dependent is added, so this
  // is a topological order.
  const order: string[] = [];
  let notifying = 0;

  const node = (id: string): Node => {
    const n = nodes.get(id);
    if (!n) throw new Error(`dag: unknown node "${id}"`);
    return n;
  };

  const emit = (n: Node, event: GraphEvent) => {
    notifying++;
    try {
      for (const l of [...n.listeners]) l(event);
    } finally {
      notifying--;
    }
  };

  /** Every node downstream of `id`, each once, in topological order. */
  const dependentsOf = (id: string): string[] => {
    const seen = new Set<string>();
    const stack = [...node(id).dependents];
    while (stack.length) {
      const d = stack.pop()!;
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...node(d).dependents);
    }
    return order.filter((o) => seen.has(o));
  };

  /** Is `target` reachable from `from` along deps? */
  const reaches = (from: string, target: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const d = stack.pop()!;
      if (d === target) return true;
      if (seen.has(d)) continue;
      seen.add(d);
      stack.push(...(nodes.get(d)?.deps ?? []));
    }
    return false;
  };

  const changed = (id: string, value: unknown) => {
    const n = node(id);
    n.value = value;
    n.version++;
    for (const d of dependentsOf(id)) emit(node(d), { kind: "upstream", from: id });
  };

  return {
    add(id, deps) {
      if (nodes.has(id)) throw new Error(`dag: node "${id}" already exists`);
      if (deps.some((d) => d === id || reaches(d, id))) throw new Error(`dag: "${id}" would close a cycle`);
      for (const d of deps) if (!nodes.has(d)) throw new Error(`dag: "${id}" depends on unknown "${d}"`);
      nodes.set(id, {
        deps: [...deps],
        dependents: [],
        value: null,
        version: 0,
        state: "off",
        ownDemand: false,
        demanded: false,
        listeners: new Set(),
      });
      for (const d of deps) node(d).dependents.push(id);
      order.push(id);
    },

    publish(id, value) {
      if (notifying) throw new Error(`dag: "${id}" published from inside a notification`);
      changed(id, value);
    },

    clear(id) {
      changed(id, null);
    },

    value<T>(id: string) {
      return node(id).value as T | null;
    },

    version(id) {
      return node(id).version;
    },

    setState(id, state) {
      const n = node(id);
      if (n.state === state) return;
      n.state = state;
      // Allowed inside a notification, as `clear` is: a layer's state changes
      // inside its own demand listener.
      for (const d of dependentsOf(id)) emit(node(d), { kind: "upstream", from: id });
    },

    state<S extends string = string>(id: string) {
      return node(id).state as S;
    },

    setOwnDemand(id, on) {
      node(id).ownDemand = on;
      // Downstream first, so each node sees its dependents' new demand.
      const flipped: Node[] = [];
      for (let i = order.length - 1; i >= 0; i--) {
        const n = node(order[i]);
        const demanded = n.ownDemand || n.dependents.some((d) => node(d).demanded);
        if (demanded !== n.demanded) {
          n.demanded = demanded;
          flipped.push(n);
        }
      }
      for (const n of flipped) emit(n, { kind: "demand", demanded: n.demanded });
    },

    demanded(id) {
      return node(id).demanded;
    },

    subscribe(id, listener) {
      const n = node(id);
      n.listeners.add(listener);
      return () => n.listeners.delete(listener);
    },
  };
}
