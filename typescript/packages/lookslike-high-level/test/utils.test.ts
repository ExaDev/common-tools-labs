import { describe, it, expect } from "vitest";
import { isReference, isModule, isRecipe } from "../src/framework/types.js";
import {
  setValueAtPath,
  getValueAtPath,
  hasValueAtPath,
} from "../src/framework/utils.js";

describe("utility functions", () => {
  it("isReference correctly identifies references", () => {
    expect(isReference({ $ref: ["path", "to", "value"] })).toBe(true);
    expect(isReference({ notRef: "something" })).toBe(false);
  });

  it("isModule correctly identifies modules", () => {
    expect(isModule({ type: "javascript", implementation: () => {} })).toBe(
      true
    );
    expect(isModule({ notModule: "something" })).toBe(false);
  });

  it("isRecipe correctly identifies recipes", () => {
    expect(isRecipe({ schema: {}, initial: {}, nodes: [] })).toBe(true);
    expect(isRecipe({ notRecipe: "something" })).toBe(false);
  });
});

describe("Path operations", () => {
  describe("setValueAtPath", () => {
    it("should set a value at the specified path", () => {
      const obj = {};
      setValueAtPath(obj, ["a", "b", "c"], 42);
      expect(obj).toEqual({ a: { b: { c: 42 } } });
    });

    it("should create arrays when encountering numeric keys", () => {
      const obj = {};
      setValueAtPath(obj, ["a", 0, "b"], "test");
      expect(obj).toEqual({ a: [{ b: "test" }] });
    });

    it("should overwrite existing values", () => {
      const obj = { x: { y: 1 } };
      setValueAtPath(obj, ["x", "y"], 2);
      expect(obj).toEqual({ x: { y: 2 } });
    });
  });

  describe("getValueAtPath", () => {
    const obj = { a: { b: { c: 42 } }, x: [{ y: "test" }] };

    it("should retrieve a value at the specified path", () => {
      expect(getValueAtPath(obj, ["a", "b", "c"])).toBe(42);
    });

    it("should work with array indices", () => {
      expect(getValueAtPath(obj, ["x", 0, "y"])).toBe("test");
    });

    it("should return undefined for non-existent paths", () => {
      expect(getValueAtPath(obj, ["a", "b", "d"])).toBeUndefined();
    });
  });

  describe("hasValueAtPath", () => {
    const obj = { a: { b: { c: 42 } }, x: [{ y: "test" }] };

    it("should return true for existing paths", () => {
      expect(hasValueAtPath(obj, ["a", "b", "c"])).toBe(true);
    });

    it("should work with array indices", () => {
      expect(hasValueAtPath(obj, ["x", 0, "y"])).toBe(true);
    });

    it("should return false for non-existent paths", () => {
      expect(hasValueAtPath(obj, ["a", "b", "d"])).toBe(false);
    });

    it("should return false for partially existing paths", () => {
      expect(hasValueAtPath(obj, ["a", "b", "c", "d"])).toBe(false);
    });
  });

  describe("hasValueAtPath for default values", () => {
    const store = {
      defaultValue: undefined,
    };

    it("should return false if the default value is undefined", () => {
      expect(hasValueAtPath(store, ["defaultValue"])).toBe(false);
    });
  });
});
