import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ReferenceCandidatesModal from "./ReferenceCandidatesModal";
import type { PdfReferenceTarget } from "../services/pdfReferences";

const candidates: PdfReferenceTarget[] = [
  {
    kind: "table",
    label: "Table 3",
    normalizedId: "3",
    page: 8,
    pdfY: 120,
    caption: "Table 3 — Test conditions",
  },
  {
    kind: "table",
    label: "Table 3",
    normalizedId: "3",
    page: 19,
    pdfY: 240,
    caption: "Table 3 — Alternative conditions",
  },
];

describe("ReferenceCandidatesModal", () => {
  it("shows page and caption candidates and emits the selected target", () => {
    const onSelect = vi.fn();
    render(
      <ReferenceCandidatesModal
        candidates={candidates}
        onSelect={onSelect}
        onClose={vi.fn()}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: /Alternative conditions/ })
    );
    expect(onSelect).toHaveBeenCalledWith(candidates[1]);
  });

  it("closes from the close button", () => {
    const onClose = vi.fn();
    render(
      <ReferenceCandidatesModal
        candidates={candidates}
        onSelect={vi.fn()}
        onClose={onClose}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
