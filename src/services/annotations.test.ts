import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Annotation,
  PdfData,
  createAnnotation,
  deleteAnnotation,
  loadPdfData,
  savePdfData,
  updateAnnotation,
} from "../services/annotations";

const mockInvoke = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mockInvoke,
}));

describe("annotations service", () => {
  beforeEach(() => {
    mockInvoke.mockReset();
  });

  describe("loadPdfData", () => {
    it("returns empty data when filePath is empty", async () => {
      const result = await loadPdfData("");
      expect(result).toEqual({ annotations: [], sessionIds: [] });
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("returns loaded PDF data from backend", async () => {
      const data: PdfData = {
        annotations: [
          {
            id: "1",
            type: "explain",
            text: "test",
            position: { page: 1, x: 10, y: 20 },
            content: "content",
            isStreaming: false,
            createdAt: 123,
          },
        ],
        sessionIds: ["session-1"],
      };
      mockInvoke.mockResolvedValue(data);

      const result = await loadPdfData("/path/to/file.pdf");

      expect(mockInvoke).toHaveBeenCalledWith("load_pdf_data", {
        filePath: "/path/to/file.pdf",
      });
      expect(result).toEqual(data);
    });

    it("maps camelCase fields returned by the backend", async () => {
      const backendResponse = {
        annotations: [
          {
            id: "1",
            type: "explain",
            text: "test",
            position: { page: 1, x: 10, y: 20 },
            content: "content",
            isStreaming: true,
            hidden: false,
            createdAt: 123,
            sessionId: "session-1",
            stashId: "stash-1",
            interpretedGroupSize: 2,
            interpretedIndex: 1,
          },
        ],
        sessionIds: ["session-1", "session-2"],
      };
      mockInvoke.mockResolvedValue(backendResponse);

      const result = await loadPdfData("/path/to/file.pdf");

      expect(result.annotations[0].sessionId).toBe("session-1");
      expect(result.annotations[0].stashId).toBe("stash-1");
      expect(result.annotations[0].interpretedGroupSize).toBe(2);
      expect(result.annotations[0].interpretedIndex).toBe(1);
      expect(result.annotations[0].createdAt).toBe(123);
      expect(result.sessionIds).toEqual(["session-1", "session-2"]);
    });

    it("returns empty data when backend throws", async () => {
      mockInvoke.mockRejectedValue(new Error("fail"));

      const result = await loadPdfData("/path/to/file.pdf");

      expect(result).toEqual({ annotations: [], sessionIds: [] });
    });
  });

  describe("savePdfData", () => {
    it("does nothing when filePath is empty", async () => {
      await savePdfData("", { annotations: [], sessionIds: [] });
      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("invokes save_pdf_data with filePath and data", async () => {
      const data: PdfData = {
        annotations: [
          {
            id: "1",
            type: "translate",
            text: "hello",
            position: { page: 1, x: 0, y: 0 },
            content: "你好",
            isStreaming: false,
            hidden: false,
            createdAt: 456,
          },
        ],
        sessionIds: ["session-1"],
      };
      mockInvoke.mockResolvedValue(undefined);

      await savePdfData("/path/to/file.pdf", data);

      expect(mockInvoke).toHaveBeenCalledWith("save_pdf_data", {
        filePath: "/path/to/file.pdf",
        data,
      });
    });

    it("swallows backend errors", async () => {
      mockInvoke.mockRejectedValue(new Error("fail"));

      await expect(
        savePdfData("/path/to/file.pdf", { annotations: [], sessionIds: [] })
      ).resolves.toBeUndefined();
    });
  });

  describe("createAnnotation", () => {
    it("creates an explain annotation with correct defaults", () => {
      const annotation = createAnnotation("explain", "text", 2, 100, 200);

      expect(annotation).toMatchObject({
        id: "test-uuid-0001",
        type: "explain",
        text: "text",
        position: { page: 2, x: 100, y: 200 },
        content: "",
        isStreaming: true,
      });
      expect(annotation.createdAt).toBeGreaterThan(0);
      expect(annotation.hidden).toBeUndefined();
    });

    it("creates a translate annotation with hidden false", () => {
      const annotation = createAnnotation("translate", "text", 1, 0, 0);

      expect(annotation.type).toBe("translate");
      expect(annotation.hidden).toBe(false);
    });

    it("creates a stash annotation with optional stashId", () => {
      const annotation = createAnnotation("stash", "text", 2, 100, 200, {
        stashId: "stash-1",
      });

      expect(annotation.type).toBe("stash");
      expect(annotation.hidden).toBeUndefined();
      expect(annotation.stashId).toBe("stash-1");
    });
  });

  describe("updateAnnotation", () => {
    it("updates matching annotation by id", () => {
      const annotations: Annotation[] = [
        {
          id: "1",
          type: "explain",
          text: "a",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
        },
        {
          id: "2",
          type: "explain",
          text: "b",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 2,
        },
      ];

      const result = updateAnnotation(annotations, "1", { text: "updated" });

      expect(result[0].text).toBe("updated");
      expect(result[1]).toEqual(annotations[1]);
    });

    it("returns new array without mutating original", () => {
      const annotations: Annotation[] = [
        {
          id: "1",
          type: "explain",
          text: "a",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
        },
      ];

      const result = updateAnnotation(annotations, "1", { text: "updated" });

      expect(result).not.toBe(annotations);
      expect(annotations[0].text).toBe("a");
    });
  });

  describe("deleteAnnotation", () => {
    it("removes annotation by id", () => {
      const annotations: Annotation[] = [
        {
          id: "1",
          type: "explain",
          text: "a",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 1,
        },
        {
          id: "2",
          type: "explain",
          text: "b",
          position: { page: 1, x: 0, y: 0 },
          content: "",
          isStreaming: false,
          createdAt: 2,
        },
      ];

      const result = deleteAnnotation(annotations, "1");

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("2");
    });
  });
});
