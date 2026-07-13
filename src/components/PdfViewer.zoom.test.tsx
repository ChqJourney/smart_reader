import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import PdfViewer from "./PdfViewer";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_SETTINGS } from "../services/settings";

// --- Mock pdfjs-dist worker URL import and module ---

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({
  default: "/mock-pdf-worker.js",
}));

const mockGetDocument = vi.hoisted(() => vi.fn());

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: mockGetDocument,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

// --- Component integration test setup ---

const SCALE = 1.5;
const PAGE_HEIGHTS = [200, 250, 300];
const NUM_PAGES = PAGE_HEIGHTS.length;

function createMockPdf() {
  return {
    numPages: NUM_PAGES,
    getOutline: vi.fn(() => Promise.resolve([])),
    getPage: vi.fn(async (pageNum: number) => {
      const height = PAGE_HEIGHTS[pageNum - 1] ?? 300;
      const viewport = {
        width: 200 * SCALE,
        height: height * SCALE,
        scale: SCALE,
        convertToViewportPoint: (x: number, y: number) => [
          x * SCALE,
          y * SCALE,
        ],
      };
      return {
        getViewport: () => viewport,
        render: () => ({ promise: Promise.resolve() }),
        getTextContent: () => Promise.resolve({ items: [] }),
        getAnnotations: () => Promise.resolve([]),
      };
    }),
  };
}

describe("PdfViewer zoom", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockResolvedValue([1, 2, 3]);
    mockGetDocument.mockReturnValue({
      promise: Promise.resolve(createMockPdf()),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function waitForScaleInput(): Promise<HTMLInputElement> {
    return waitFor<HTMLInputElement>(() => {
      const input = screen.getByLabelText("缩放比例") as HTMLInputElement;
      if (!input || input.disabled) {
        throw new Error("scale input not ready yet");
      }
      return input;
    });
  }

  function getCanvasContainer(container: HTMLElement): HTMLDivElement {
    return container.querySelector(
      ".pdf-canvas-container.continuous"
    ) as HTMLDivElement;
  }

  it("displays the initial scale in the scale input", async () => {
    render(<PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />);
    const scaleInput = await waitForScaleInput();
    expect(scaleInput.value).toBe("150%");
  });

  it("zooms in with Ctrl+wheel up", async () => {
    const { container } = render(
      <PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />
    );
    const scaleInput = await waitForScaleInput();
    const canvasContainer = getCanvasContainer(container);

    fireEvent.wheel(canvasContainer, { deltaY: -100, ctrlKey: true });

    await waitFor(() => {
      expect(scaleInput.value).toBe("165%");
    });
  });

  it("zooms out with Ctrl+wheel down", async () => {
    const { container } = render(
      <PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />
    );
    const scaleInput = await waitForScaleInput();
    const canvasContainer = getCanvasContainer(container);

    fireEvent.wheel(canvasContainer, { deltaY: 100, ctrlKey: true });

    await waitFor(() => {
      expect(scaleInput.value).toBe("135%");
    });
  });

  it("does not zoom on plain wheel events", async () => {
    const { container } = render(
      <PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />
    );
    const scaleInput = await waitForScaleInput();
    const canvasContainer = getCanvasContainer(container);

    fireEvent.wheel(canvasContainer, { deltaY: 100, ctrlKey: false });

    // The scale should remain unchanged; give any async effect time to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scaleInput.value).toBe("150%");
  });

  it("accumulates wheel delta and only applies one step per threshold", async () => {
    const { container } = render(
      <PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />
    );
    const scaleInput = await waitForScaleInput();
    const canvasContainer = getCanvasContainer(container);

    // Three small wheel events below the 100 threshold should not zoom.
    fireEvent.wheel(canvasContainer, { deltaY: -30, ctrlKey: true });
    fireEvent.wheel(canvasContainer, { deltaY: -30, ctrlKey: true });
    fireEvent.wheel(canvasContainer, { deltaY: -30, ctrlKey: true });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scaleInput.value).toBe("150%");

    // One more small event pushes the accumulator over the threshold.
    fireEvent.wheel(canvasContainer, { deltaY: -30, ctrlKey: true });

    await waitFor(() => {
      expect(scaleInput.value).toBe("165%");
    });
  });

  it("resets the accumulator when wheel direction reverses", async () => {
    const { container } = render(
      <PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />
    );
    const scaleInput = await waitForScaleInput();
    const canvasContainer = getCanvasContainer(container);

    // Nearly enough to zoom in, then reverse direction.
    fireEvent.wheel(canvasContainer, { deltaY: -80, ctrlKey: true });
    fireEvent.wheel(canvasContainer, { deltaY: 80, ctrlKey: true });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(scaleInput.value).toBe("150%");

    // Continue zooming out; the reversed accumulator should start fresh.
    fireEvent.wheel(canvasContainer, { deltaY: 100, ctrlKey: true });

    await waitFor(() => {
      expect(scaleInput.value).toBe("135%");
    });
  });

  it("applies a percentage value entered in the scale input", async () => {
    render(<PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />);
    const scaleInput = await waitForScaleInput();

    fireEvent.change(scaleInput, { target: { value: "200%" } });
    fireEvent.keyDown(scaleInput, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(scaleInput.value).toBe("200%");
    });
  });

  it("applies a raw scale value entered in the scale input", async () => {
    render(<PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />);
    const scaleInput = await waitForScaleInput();

    fireEvent.change(scaleInput, { target: { value: "2" } });
    fireEvent.keyDown(scaleInput, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(scaleInput.value).toBe("200%");
    });
  });

  it("clamps scale input to the allowed range", async () => {
    render(<PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />);
    const scaleInput = await waitForScaleInput();

    fireEvent.change(scaleInput, { target: { value: "800%" } });
    fireEvent.keyDown(scaleInput, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(scaleInput.value).toBe("500%");
    });

    fireEvent.change(scaleInput, { target: { value: "5%" } });
    fireEvent.keyDown(scaleInput, { key: "Enter", code: "Enter" });

    await waitFor(() => {
      expect(scaleInput.value).toBe("10%");
    });
  });

  it("reverts invalid scale input on blur", async () => {
    render(<PdfViewer filePath="/fake/test.pdf" settings={DEFAULT_SETTINGS} />);
    const scaleInput = await waitForScaleInput();

    fireEvent.change(scaleInput, { target: { value: "abc" } });
    fireEvent.blur(scaleInput);

    await waitFor(() => {
      expect(scaleInput.value).toBe("150%");
    });
  });
});
