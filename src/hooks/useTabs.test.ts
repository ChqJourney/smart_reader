import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useTabs } from "./useTabs";

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../services/dialog", () => ({
  showMessage: vi.fn(),
}));

vi.mock("../services/logs", () => ({
  error: vi.fn(),
  info: vi.fn(),
}));

const { invoke } = await import("@tauri-apps/api/core");
const mockInvoke = invoke as ReturnType<typeof vi.fn>;

function setupMockInvoke() {
  mockInvoke.mockImplementation(
    (command: string, args?: Record<string, any>) => {
      switch (command) {
        case "authorizePdfPath":
        case "authorize_pdf_path":
          return Promise.resolve(undefined);
        case "get_pdf_hash":
          return Promise.resolve(`hash-${args?.filePath}`);
        default:
          return Promise.reject(
            new Error(`No mock handler for command: ${command}`)
          );
      }
    }
  );
}

describe("useTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupMockInvoke();
  });

  it("opens different PDFs as separate tabs", async () => {
    const { result } = renderHook(() => useTabs());

    await act(async () => {
      await result.current.openPdfByPath("/test/a.pdf", "a.pdf");
    });
    await act(async () => {
      await result.current.openPdfByPath("/test/b.pdf", "b.pdf");
    });

    expect(result.current.tabs).toHaveLength(2);
  });

  it("does not duplicate the same PDF when opened sequentially", async () => {
    const { result } = renderHook(() => useTabs());

    let firstTab: Awaited<
      ReturnType<typeof result.current.openPdfByPath>
    > | null = null;
    let secondTab: Awaited<
      ReturnType<typeof result.current.openPdfByPath>
    > | null = null;

    await act(async () => {
      firstTab = await result.current.openPdfByPath(
        "/test/file.pdf",
        "file.pdf"
      );
    });
    await act(async () => {
      secondTab = await result.current.openPdfByPath(
        "/test/file.pdf",
        "file.pdf"
      );
    });

    expect(result.current.tabs).toHaveLength(1);
    expect(secondTab).toEqual(firstTab);
  });

  it("deduplicates concurrent opens for the same path", async () => {
    const { result } = renderHook(() => useTabs());

    // Delay the backend so both calls overlap and must share the in-flight promise.
    let resolveHash: (value: string) => void;
    const hashPromise = new Promise<string>((resolve) => {
      resolveHash = resolve;
    });
    mockInvoke.mockImplementation(
      (command: string, args?: Record<string, any>) => {
        switch (command) {
          case "authorize_pdf_path":
            return Promise.resolve(undefined);
          case "get_pdf_hash":
            return hashPromise.then(() => `hash-${args?.filePath}`);
          default:
            return Promise.reject(
              new Error(`No mock handler for command: ${command}`)
            );
        }
      }
    );

    const [tab1, tab2] = await act(async () => {
      const p1 = result.current.openPdfByPath("/test/file.pdf", "file.pdf");
      const p2 = result.current.openPdfByPath("/test/file.pdf", "file.pdf");
      resolveHash!("done");
      return Promise.all([p1, p2]);
    });

    await waitFor(() => {
      expect(result.current.tabs).toHaveLength(1);
    });
    expect(tab1).toEqual(tab2);
    expect(mockInvoke).toHaveBeenCalledTimes(2); // authorize + hash only once each path
  });

  it("counts authorize and hash calls correctly for concurrent same-path opens", async () => {
    const { result } = renderHook(() => useTabs());

    let resolveHash: (value: string) => void;
    const hashPromise = new Promise<string>((resolve) => {
      resolveHash = resolve;
    });
    mockInvoke.mockImplementation(
      (command: string, args?: Record<string, any>) => {
        switch (command) {
          case "authorize_pdf_path":
            return Promise.resolve(undefined);
          case "get_pdf_hash":
            return hashPromise.then(() => `hash-${args?.filePath}`);
          default:
            return Promise.reject(
              new Error(`No mock handler for command: ${command}`)
            );
        }
      }
    );

    await act(async () => {
      const p1 = result.current.openPdfByPath("/test/file.pdf", "file.pdf");
      const p2 = result.current.openPdfByPath("/test/file.pdf", "file.pdf");
      resolveHash!("done");
      await Promise.all([p1, p2]);
    });

    const authorizeCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "authorize_pdf_path"
    );
    const hashCalls = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "get_pdf_hash"
    );
    expect(authorizeCalls).toHaveLength(1);
    expect(hashCalls).toHaveLength(1);
  });
});
