import { describe, it, expect, vi, afterEach } from "vitest";
import { copyToClipboard } from "./clipboard";

describe("copyToClipboard", () => {
  const originalClipboard = navigator.clipboard;
  const originalIsSecureContext = window.isSecureContext;

  function setSecureContext(value: boolean) {
    Object.defineProperty(window, "isSecureContext", {
      value,
      configurable: true,
    });
  }

  function setClipboard(writeText: (text: string) => Promise<void>) {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
  }

  function mockExecCommand(result: boolean) {
    // jsdom leaves `document.execCommand` undefined, so we install a mock via
    // defineProperty instead of vi.spyOn (which requires an existing function).
    Object.defineProperty(document, "execCommand", {
      value: vi.fn(() => result),
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    Object.defineProperty(window, "isSecureContext", {
      value: originalIsSecureContext,
      configurable: true,
    });
    Object.defineProperty(navigator, "clipboard", {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
    // Remove any execCommand mock we installed; jsdom leaves it undefined.
    delete (document as { execCommand?: unknown }).execCommand;
  });

  it("uses the async Clipboard API in a secure context", async () => {
    setSecureContext(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);

    await copyToClipboard("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when the async API rejects", async () => {
    setSecureContext(true);
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    mockExecCommand(true);

    await copyToClipboard("hello");

    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to execCommand in a non-secure context", async () => {
    setSecureContext(false);
    mockExecCommand(true);

    await copyToClipboard("hello");

    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("throws when execCommand returns false", async () => {
    setSecureContext(false);
    mockExecCommand(false);

    await expect(copyToClipboard("hello")).rejects.toThrow();
  });
});
