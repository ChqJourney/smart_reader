import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import MarkdownRenderer from "./MarkdownRenderer";
import type { ValidatedCitation } from "../services/citations";

const citations: ValidatedCitation[] = [
  {
    evidenceId: "src-1",
    status: "verified",
    evidence: {
      id: "src-1",
      fileHash: "hash-1",
      fileName: "standard.pdf",
      page: 23,
      pdfY: 120,
    },
  },
];

describe("MarkdownRenderer citations", () => {
  it("renders verified references and emits structured navigation", () => {
    const onCitationClick = vi.fn();
    render(
      <MarkdownRenderer
        content="Requirement[[cite:src-1]]"
        citations={citations}
        onCitationClick={onCitationClick}
      />
    );
    const link = screen.getByRole("link", { name: "[1]" });
    expect(link).toHaveClass("markdown-citation", "verified");
    fireEvent.click(link);
    expect(onCitationClick).toHaveBeenCalledWith({
      citationId: "src-1",
      fileHash: "hash-1",
      fileName: "standard.pdf",
      page: 23,
      pdfY: 120,
      reference: undefined,
      verified: true,
    });
  });

  it("makes explicit page and clause text clickable as unverified navigation", () => {
    const onCitationClick = vi.fn();
    render(
      <MarkdownRenderer
        content="See 第 24 页 and Clause 5.2.3."
        onCitationClick={onCitationClick}
      />
    );
    const page = screen.getByRole("link", { name: "第 24 页" });
    const clause = screen.getByRole("link", { name: "Clause 5.2.3" });
    expect(page).toHaveClass("unverified");
    expect(clause).toHaveClass("unverified");
    fireEvent.click(page);
    expect(onCitationClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 24, verified: false })
    );
    fireEvent.click(clause);
    expect(onCitationClick).toHaveBeenLastCalledWith(
      expect.objectContaining({
        reference: {
          kind: "clause",
          label: "Clause 5.2.3",
          normalizedId: "5.2.3",
        },
        verified: false,
      })
    );
  });

  it("makes clause, table and figure references clickable with normalized targets", () => {
    const onCitationClick = vi.fn();
    render(
      <MarkdownRenderer
        content="Clause 5, 第 A.1 条, Table 3, 表 3.1, Figure 2a, Fig. 2, 图 4"
        onCitationClick={onCitationClick}
      />
    );
    const expected = [
      ["Clause 5", "clause", "5"],
      ["第 A.1 条", "clause", "A.1"],
      ["Table 3", "table", "3"],
      ["表 3.1", "table", "3.1"],
      ["Figure 2a", "figure", "2A"],
      ["Fig. 2", "figure", "2"],
      ["图 4", "figure", "4"],
    ] as const;
    for (const [label, kind, normalizedId] of expected) {
      fireEvent.click(screen.getByRole("link", { name: label }));
      expect(onCitationClick).toHaveBeenLastCalledWith({
        citationId: undefined,
        page: undefined,
        printedPage: undefined,
        reference: { kind, label, normalizedId },
        verified: false,
      });
    }
  });

  it("uses the explicit physical page in compound and PDF-qualified references", () => {
    const onCitationClick = vi.fn();
    render(
      <MarkdownRenderer
        content="第 96 页（PDF 第 100 页），PDF 第 101 页，印刷第 ii 页，印刷第 1 页"
        onCitationClick={onCitationClick}
      />
    );
    fireEvent.click(
      screen.getByRole("link", { name: "第 96 页（PDF 第 100 页）" })
    );
    expect(onCitationClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 100, printedPage: undefined })
    );
    fireEvent.click(screen.getByRole("link", { name: "PDF 第 101 页" }));
    expect(onCitationClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 101 })
    );
    fireEvent.click(screen.getByRole("link", { name: "印刷第 ii 页" }));
    expect(onCitationClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: undefined, printedPage: "ii" })
    );
    fireEvent.click(screen.getByRole("link", { name: "印刷第 1 页" }));
    expect(onCitationClick).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: undefined, printedPage: "1" })
    );
  });

  it("keeps independent page references separate", () => {
    render(
      <MarkdownRenderer
        content="比较第 96 页和第 100 页"
        onCitationClick={vi.fn()}
      />
    );
    expect(screen.getByRole("link", { name: "第 96 页" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "第 100 页" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "第 96 页和第 100 页" })
    ).not.toBeInTheDocument();
  });

  it("marks unknown structured references invalid", () => {
    render(
      <MarkdownRenderer
        content="Claim[[cite:src-missing]]"
        citations={citations}
        onCitationClick={vi.fn()}
      />
    );
    expect(
      screen.getByRole("link", { name: "[[cite:src-missing]]" })
    ).toHaveClass("invalid");
  });

  it("does not link citations in code or when no click handler exists", () => {
    const { container, rerender } = render(
      <MarkdownRenderer content="`第 24 页`" onCitationClick={vi.fn()} />
    );
    expect(container.querySelector("a.markdown-citation")).toBeNull();
    rerender(<MarkdownRenderer content="第 24 页" />);
    expect(container.querySelector("a.markdown-citation")).toBeNull();
  });
});
