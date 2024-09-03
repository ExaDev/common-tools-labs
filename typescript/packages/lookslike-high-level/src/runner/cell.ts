import { isAlias, isStreamAlias } from "../builder/types.js";
import { getValueAtPath, setValueAtPath, deepEqual } from "../builder/utils.js";
import {
  followCellReferences,
  followAliases,
  setNestedValue,
  pathAffected,
  transformToSimpleCells,
} from "./utils.js";
import { queueEvent } from "./scheduler.js";

/**
 * This is the regular Cell interface, generated by CellImpl.asSimpleCell().
 * This abstracts away the paths behind an interface that e.g. the UX code or
 * modules that prefer cell interfaces can use.
 *
 * @method get Returns the current value of the cell.
 * @returns {T}
 *
 * @method set Alias for `send`. Sets a new value for the cell.
 * @method send Sets a new value for the cell.
 * @param {T} value - The new value to set.
 * @returns {void}
 *
 * @method key Returns a new cell for the specified key path.
 * @param {K} valueKey - The key to access in the cell's value.
 * @returns {Cell<T[K]>}
 */
export interface Cell<T> {
  get(): T;
  set(value: T): void;
  send(value: T): void;
  sink(callback: (value: T) => void): () => void;
  key<K extends keyof T>(valueKey: K): Cell<T[K]>;
}

export interface ReactiveCell<T> {
  sink(callback: (value: T) => void): () => void;
}

export type CellImpl<T> = {
  get(): T;
  getAsProxy(path?: PropertyKey[], log?: ReactivityLog): T;
  asSimpleCell<Q = T>(path?: PropertyKey[], log?: ReactivityLog): Cell<Q>;
  send(value: T, log?: ReactivityLog): boolean;
  updates(callback: (value: T, path: PropertyKey[]) => void): () => void;
  sink(callback: (value: T, path: PropertyKey[]) => void): () => void;
  getAtPath(path: PropertyKey[]): T;
  setAtPath(path: PropertyKey[], newValue: any, log?: ReactivityLog): boolean;
  freeze(): void;
  isFrozen(): boolean;
  [isCellMarker]: true;
};

export type CellReference = {
  cell: CellImpl<any>;
  path: PropertyKey[];
};

export type CellProxy<T> = T & {
  [getCellReference]: [CellImpl<any>, PropertyKey[]];
};

export type ReactivityLog = {
  reads: CellReference[];
  writes: CellReference[];
};

export function cell<T>(value?: T): CellImpl<T> {
  const callbacks = new Set<(value: T, path: PropertyKey[]) => void>();
  let readOnly = false;

  const self: CellImpl<T> = {
    get: () => value as T,
    getAsProxy: (path: PropertyKey[] = [], log?: ReactivityLog) =>
      createValueProxy(self, path, log),
    asSimpleCell: <Q = T>(path: PropertyKey[] = [], log?: ReactivityLog) =>
      simpleCell<Q>(self, path, log),
    send: (newValue: T, log?: ReactivityLog) =>
      self.setAtPath([], newValue, log),
    updates: (callback: (value: T, path: PropertyKey[]) => void) => {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    sink: (callback: (value: T, path: PropertyKey[]) => void) => {
      callback(value as T, []);
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
    getAtPath: (path: PropertyKey[]) => getValueAtPath(value, path),
    setAtPath: (path: PropertyKey[], newValue: any, log?: ReactivityLog) => {
      if (readOnly) throw new Error("Cell is read-only");
      let changed = false;
      if (path.length > 0) {
        changed = setValueAtPath(value, path, newValue);
      } else if (!deepEqual(value, newValue)) {
        changed = true;
        value = newValue;
      }
      if (changed) {
        log?.writes.push({ cell: self, path });
        for (const callback of callbacks) callback(value as T, path);
      }
      return changed;
    },
    freeze: () => {
      readOnly = true;
      /* NOTE: Can't freeze actual object, since otherwise JS throws type errors
      for the cases where the proxy returns different values than what is
      proxied, e.g. for aliases. TODO: Consider changing proxy here. */
    },
    isFrozen: () => readOnly,
    [isCellMarker]: true,
  };

  return self;
}

function simpleCell<T>(
  self: CellImpl<any>,
  path: PropertyKey[],
  log?: ReactivityLog
): Cell<T> {
  if (isStreamAlias(self.getAtPath(path)))
    return {
      // Implementing just Sendable<T>
      send: (event: T) => {
        log?.writes.push({ cell: self, path });
        queueEvent({ cell: self, path }, event);
      },
    } as Cell<T>;
  else
    return {
      get: () => transformToSimpleCells(self, self.getAtPath(path), log) as T,
      set: (newValue: T) => self.setAtPath(path, newValue, log),
      send: (newValue: T) => self.setAtPath(path, newValue, log),
      sink: (callback: (value: T) => void) => {
        return self.sink(
          (value, changedPath) =>
            pathAffected(changedPath, path) &&
            callback(
              transformToSimpleCells(self, getValueAtPath(value, path), log)
            )
        );
      },
      key: <K extends keyof T>(key: K) =>
        self.asSimpleCell([...path, key], log) as Cell<T[K]>,
    } satisfies Cell<T>;
}

// Array.prototype's entries, and whether they modify the array
const arrayMethods: { [key: string]: boolean } = {
  at: false,
  concat: false,
  entries: false,
  every: false,
  fill: true,
  filter: false,
  find: false,
  findIndex: false,
  findLast: false,
  findLastIndex: false,
  includes: false,
  indexOf: false,
  join: false,
  keys: false,
  lastIndexOf: false,
  map: false,
  pop: true,
  push: true,
  reduce: false,
  reduceRight: false,
  reverse: true,
  shift: true,
  slice: false,
  some: false,
  sort: true,
  splice: true,
  toLocaleString: false,
  toString: false,
  unshift: true,
  values: false,
  with: false,
};

export function createValueProxy<T>(
  cell: CellImpl<T>,
  path: PropertyKey[],
  log?: ReactivityLog
): T {
  log?.reads.push({ cell, path });

  // Follow path, following aliases and cells, so might end up on different cell
  let target = cell.get() as any;
  const keys = [...path];
  path = [];
  while (keys.length) {
    const key = keys.shift()!;
    if (isAlias(target)) {
      const ref = followAliases(target, cell, log);
      cell = ref.cell;
      path = ref.path;
    } else if (isCell(target)) {
      cell = target;
      path = [];
      log?.reads.push({ cell, path });
      target = target.get();
    } else if (isCellReference(target)) {
      const ref = followCellReferences(target, log);
      cell = ref.cell;
      path = ref.path;
    }
    path.push(key);
    if (typeof target === "object" && target !== null) {
      target = target[key as keyof typeof target];
    } else {
      target = undefined;
    }
  }

  // Now target is the end of the path. It might still be a cell, alias or cell
  // reference, so we follow these as well.
  if (isCell(target)) return createValueProxy(target, [], log);
  else if (isAlias(target)) {
    const ref = followAliases(target, cell, log);
    return createValueProxy(ref.cell, ref.path, log);
  } else if (isCellReference(target)) {
    const ref = followCellReferences(target, log);
    return createValueProxy(ref.cell, ref.path, log);
  } else if (typeof target !== "object" || target === null) return target;

  return new Proxy(target as object, {
    get: (_target, prop) => {
      if (prop === getCellReference)
        return { cell, path } satisfies CellReference;

      if (Array.isArray(target) && prop in arrayMethods)
        return arrayMethods[prop as keyof typeof arrayMethods] == false
          ? (...args: any[]) => {
              return Array.prototype[
                prop as keyof typeof Array.prototype
              ].apply(target, args);
            }
          : (...args: any[]) => {
              const copy = [...target];
              const result = Array.prototype[
                prop as keyof typeof Array.prototype
              ].apply(copy, args);
              setNestedValue(cell, path, copy, log);
              return result;
            };

      return createValueProxy(cell, [...path, prop], log);
    },
    set: (_target, prop, value) => {
      if (isCellProxy(value)) value = value[getCellReference];

      return setNestedValue(cell, [...path, prop], value, log);
    },
  }) as T;
}

export function getCellReferenceOrValue(value: any): CellReference {
  if (isCellProxy(value)) return value[getCellReference];
  else return value;
}

const isCellMarker = Symbol("isCell");
export function isCell(value: any): value is CellImpl<any> {
  return typeof value === "object" && value[isCellMarker] === true;
}

export function isCellReference(value: any): value is CellReference {
  return (
    typeof value === "object" && isCell(value.cell) && Array.isArray(value.path)
  );
}

const getCellReference = Symbol("isCellProxy");
export function isCellProxy(value: any): value is CellProxy<any> {
  return typeof value === "object" && value[getCellReference] !== undefined;
}

export const isReactive = <T = any>(
  value: ReactiveCell<T>
): value is ReactiveCell<T> => {
  return (
    typeof value === "object" &&
    "sink" in value &&
    typeof value.sink === "function"
  );
};
