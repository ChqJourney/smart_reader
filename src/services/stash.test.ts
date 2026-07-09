import { describe, it, expect } from "vitest";
import {
  StashItem,
  StashSource,
  createStashItem,
  addStash,
  removeStash,
  updateStash,
} from "./stash";

function makeSource(overrides: Partial<StashSource> = {}): StashSource {
  return {
    tabId: "tab-1",
    fileName: "file.pdf",
    filePath: "/path/to/file.pdf",
    fileHash: "hash-file",
    page: 3,
    pdfX: 100,
    pdfY: 200,
    ...overrides,
  };
}

describe("stash service", () => {
  describe("createStashItem", () => {
    it("creates a stash item with generated id and timestamp", () => {
      const source = makeSource();
      const item = createStashItem(source, "selected text");

      expect(item).toMatchObject({
        id: "test-uuid-0001",
        source,
        text: "selected text",
      });
      expect(item.createdAt).toBeGreaterThan(0);
    });
  });

  describe("addStash", () => {
    it("appends a new item to the list", () => {
      const existing: StashItem[] = [
        createStashItem(makeSource({ page: 1 }), "first"),
      ];
      const newItem = createStashItem(makeSource({ page: 2 }), "second");

      const result = addStash(existing, newItem);

      expect(result).toHaveLength(2);
      expect(result[1]).toEqual(newItem);
      expect(result).not.toBe(existing);
    });

    it("returns a new array without mutating the original", () => {
      const existing: StashItem[] = [];
      const newItem = createStashItem(makeSource(), "text");

      const result = addStash(existing, newItem);

      expect(existing).toHaveLength(0);
      expect(result).toHaveLength(1);
    });
  });

  describe("removeStash", () => {
    it("removes the item with matching id", () => {
      const item1: StashItem = { ...createStashItem(makeSource(), "first"), id: "stash-1" };
      const item2: StashItem = { ...createStashItem(makeSource(), "second"), id: "stash-2" };
      const stashes = [item1, item2];

      const result = removeStash(stashes, item1.id);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(item2.id);
      expect(result).not.toBe(stashes);
    });

    it("returns the same array when id is not found", () => {
      const item = createStashItem(makeSource(), "text");
      const stashes = [item];

      const result = removeStash(stashes, "non-existent");

      expect(result).toEqual(stashes);
    });
  });

  describe("updateStash", () => {
    it("updates the text of the matching stash", () => {
      const item1: StashItem = { ...createStashItem(makeSource(), "first"), id: "stash-1" };
      const item2: StashItem = { ...createStashItem(makeSource(), "second"), id: "stash-2" };
      const stashes = [item1, item2];

      const result = updateStash(stashes, item1.id, "updated");

      expect(result).toHaveLength(2);
      expect(result[0].text).toBe("updated");
      expect(result[1]).toEqual(item2);
      expect(result).not.toBe(stashes);
    });

    it("returns the same array when id is not found", () => {
      const item = createStashItem(makeSource(), "text");
      const stashes = [item];

      const result = updateStash(stashes, "non-existent", "updated");

      expect(result).toEqual(stashes);
    });
  });


});
