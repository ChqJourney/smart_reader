import type {
  PdfReference,
  PdfReferenceKind,
  ValidatedCitation,
} from "../services/citations";

export interface CitationTextNode {
  type: "text";
  value: string;
}

export interface CitationElementNode {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children?: CitationNode[];
}

export interface CitationRootNode {
  type: "root" | "element";
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: CitationNode[];
}

export type CitationNode =
  CitationTextNode | CitationElementNode | CitationRootNode;

const REFERENCE_ID = String.raw`(?:[A-Z](?:\.\d+)+|\d+(?:\.\d+)*)(?:[A-Z])?`;
const COMPOUND_PAGE_PATTERN =
  /(?:印刷\s*)?第\s*(\d{1,5})\s*页\s*[（(]\s*PDF\s*第\s*(\d{1,5})\s*页\s*[）)]|\bPage\s+(\d{1,5})\s*\(\s*PDF\s+page\s+(\d{1,5})\s*\)/i;
const TOKEN_PATTERN = new RegExp(
  String.raw`(?:印刷\s*)?第\s*\d{1,5}\s*页\s*[（(]\s*PDF\s*第\s*\d{1,5}\s*页\s*[）)]|\bPage\s+\d{1,5}\s*\(\s*PDF\s+page\s+\d{1,5}\s*\)|\bPDF\s*第\s*\d{1,5}\s*页|\bPDF\s+page\s+\d{1,5}|印刷\s*第\s*[A-Za-z0-9.-]{1,20}\s*页|印刷页\s*[A-Za-z0-9.-]{1,20}|\bprinted\s+page\s+[A-Za-z0-9.-]{1,20}|\[\[cite:([A-Za-z0-9_-]+)\]\]|第\s*\d{1,5}\s*页|\bpp?\.\s*\d{1,5}(?:\s*[-–]\s*\d{1,5})?|(?:\b(?:Clause|Section)\s+${REFERENCE_ID}|第\s*${REFERENCE_ID}\s*条|\bTable\s+${REFERENCE_ID}|表\s*${REFERENCE_ID}|\b(?:Figure|Fig\.)\s*${REFERENCE_ID}|图\s*${REFERENCE_ID})`,
  "gi"
);
const SKIPPED_TAGS = new Set([
  "a",
  "code",
  "pre",
  "svg",
  "math",
  "annotation",
  "kbd",
]);

function text(value: string): CitationTextNode {
  return { type: "text", value };
}

function link(
  label: string,
  properties: Record<string, unknown>,
  status: "verified" | "invalid" | "unverified"
): CitationElementNode {
  return {
    type: "element",
    tagName: "a",
    properties: {
      href: "#",
      ...properties,
      className: ["markdown-citation", status],
    },
    children: [text(label)],
  };
}

function parsePhysicalPage(label: string): number | null {
  const compound = label.match(COMPOUND_PAGE_PATTERN);
  if (compound) return Number(compound[2] ?? compound[4]);
  if (parsePrintedPage(label)) return null;
  const explicit = label.match(
    /\bPDF\s*第\s*(\d{1,5})\s*页|\bPDF\s+page\s+(\d{1,5})/i
  );
  if (explicit) return Number(explicit[1] ?? explicit[2]);
  const normal = label.match(/第\s*(\d{1,5})\s*页|\bpp?\.\s*(\d{1,5})/i);
  if (normal) return Number(normal[1] ?? normal[2]);
  return null;
}

function parsePrintedPage(label: string): string | null {
  return (
    label.match(/印刷\s*第\s*([A-Za-z0-9.-]{1,20})\s*页/)?.[1] ??
    label.match(/印刷页\s*([A-Za-z0-9.-]{1,20})/)?.[1] ??
    label.match(/\bprinted\s+page\s+([A-Za-z0-9.-]{1,20})/i)?.[1] ??
    null
  );
}

function parseReference(label: string): PdfReference | null {
  let kind: PdfReferenceKind;
  if (/^(?:Clause|Section)\b|^第/i.test(label)) {
    kind = "clause";
  } else if (/^Table\b|^表/i.test(label)) {
    kind = "table";
  } else if (/^(?:Figure\b|Fig\.|图)/i.test(label)) {
    kind = "figure";
  } else {
    return null;
  }
  const id = label.match(/(?:[A-Z](?:\.\d+)+|\d+(?:\.\d+)*)(?:[A-Z])?/i)?.[0];
  if (!id) return null;
  return { kind, label, normalizedId: id.toUpperCase() };
}

export function citationTextNodes(
  value: string,
  citations: readonly ValidatedCitation[]
): CitationNode[] {
  const nodes: CitationNode[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(text(value.slice(lastIndex, index)));
    const label = match[0];
    const evidenceId = match[1];
    if (evidenceId) {
      const citationIndex = citations.findIndex(
        (citation) => citation.evidenceId === evidenceId
      );
      const citation =
        citationIndex >= 0 ? citations[citationIndex] : undefined;
      nodes.push(
        link(
          citation ? `[${citationIndex + 1}]` : label,
          { dataCitationId: evidenceId },
          citation?.status === "verified" ? "verified" : "invalid"
        )
      );
    } else {
      const page = parsePhysicalPage(label);
      if (page !== null && Number.isInteger(page) && page > 0) {
        nodes.push(link(label, { dataCitationPage: page }, "unverified"));
      } else {
        const printedPage = parsePrintedPage(label);
        if (printedPage) {
          nodes.push(
            link(label, { dataCitationPrintedPage: printedPage }, "unverified")
          );
          lastIndex = index + label.length;
          continue;
        }
        const reference = parseReference(label);
        if (reference) {
          nodes.push(
            link(
              label,
              {
                dataCitationKind: reference.kind,
                dataCitationReference: reference.label,
                dataCitationReferenceId: reference.normalizedId,
              },
              "unverified"
            )
          );
        } else {
          nodes.push(text(label));
        }
      }
    }
    lastIndex = index + label.length;
  }
  if (lastIndex < value.length) nodes.push(text(value.slice(lastIndex)));
  return nodes.length > 0 ? nodes : [text(value)];
}

function visit(
  node: CitationRootNode,
  citations: readonly ValidatedCitation[]
): void {
  if (!node.children) return;
  if (node.tagName && SKIPPED_TAGS.has(node.tagName)) return;
  const children: CitationNode[] = [];
  for (const child of node.children) {
    if (child.type === "text") {
      children.push(...citationTextNodes(child.value, citations));
    } else {
      visit(child as CitationRootNode, citations);
      children.push(child);
    }
  }
  node.children = children;
}

export function createCitationLinksPlugin(
  citations: readonly ValidatedCitation[],
  enabled = true
) {
  return () => (tree: CitationRootNode) => {
    if (enabled) visit(tree, citations);
  };
}
