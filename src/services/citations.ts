import type { InterpretationMessage, InterpretationSession } from "./sessions";
import type { StashItem } from "./stash";

export interface SourceEvidence {
  id: string;
  fileHash: string;
  fileName: string;
  page: number;
  clause?: string;
  quote?: string;
  pdfY?: number;
  toolCallId?: string;
}

export interface CitationRef {
  evidenceId: string;
  label?: string;
}

export type CitationValidationStatus = "verified" | "invalid";

export interface ValidatedCitation extends CitationRef {
  evidence?: SourceEvidence;
  status: CitationValidationStatus;
}

export type PdfReferenceKind = "page" | "clause" | "table" | "figure";

export interface PdfReference {
  kind: PdfReferenceKind;
  label: string;
  normalizedId: string;
}

export interface CitationNavigation {
  citationId?: string;
  fileHash?: string;
  fileName?: string;
  page?: number;
  printedPage?: string;
  pdfY?: number;
  reference?: PdfReference;
  verified: boolean;
}

const MARKER_PATTERN = /\[\[cite:([A-Za-z0-9_-]+)\]\]/g;

export function createEvidenceId(): string {
  return `src-${crypto.randomUUID()}`;
}

export function evidenceFromStash(item: StashItem): SourceEvidence {
  return {
    id: `stash-${item.id}`,
    fileHash: item.source.fileHash,
    fileName: item.source.fileName,
    page: item.source.page,
    quote: item.text,
    pdfY: item.source.pdfY,
  };
}

export function extractCitationRefs(content: string): CitationRef[] {
  const refs: CitationRef[] = [];
  const seen = new Set<string>();
  for (const match of content.matchAll(MARKER_PATTERN)) {
    if (seen.has(match[1])) continue;
    seen.add(match[1]);
    refs.push({ evidenceId: match[1] });
  }
  return refs;
}

export function stripCitationMarkers(content: string): string {
  return content
    .replace(MARKER_PATTERN, "")
    .replace(/[ \t]+([。！？；，,.!?;])/g, "$1");
}

export function collectSessionEvidence(
  session: InterpretationSession
): Map<string, SourceEvidence> {
  const evidence = new Map<string, SourceEvidence>();
  for (const source of session.sources) {
    const item = evidenceFromStash(source);
    evidence.set(item.id, item);
  }
  for (const message of session.messages) {
    for (const item of message.evidence ?? []) {
      if (!item.id || evidence.has(item.id)) continue;
      evidence.set(item.id, item);
    }
  }
  return evidence;
}

function evidenceIsWellFormed(evidence: SourceEvidence): boolean {
  return (
    evidence.id.length > 0 &&
    evidence.fileHash.length > 0 &&
    evidence.fileName.length > 0 &&
    Number.isInteger(evidence.page) &&
    evidence.page > 0 &&
    (evidence.pdfY === undefined ||
      (Number.isFinite(evidence.pdfY) && evidence.pdfY >= 0))
  );
}

export function validateMessageCitations(
  session: InterpretationSession,
  message: InterpretationMessage
): ValidatedCitation[] {
  const evidenceById = collectSessionEvidence(session);
  const refs = message.citations ?? extractCitationRefs(message.content);
  return refs.map((ref) => {
    const evidence = evidenceById.get(ref.evidenceId);
    const verified =
      evidence !== undefined &&
      evidence.id === ref.evidenceId &&
      evidenceIsWellFormed(evidence) &&
      (evidence.toolCallId === undefined ||
        session.messages.some(
          (candidate) =>
            candidate.role === "tool" &&
            candidate.toolCallId === evidence.toolCallId &&
            candidate.evidence?.some((item) => item.id === evidence.id)
        ));
    return {
      ...ref,
      evidence: verified ? evidence : undefined,
      status: verified ? "verified" : "invalid",
    };
  });
}

export function citationNavigation(
  citation: ValidatedCitation
): CitationNavigation {
  const evidence = citation.evidence;
  return {
    citationId: citation.evidenceId,
    fileHash: evidence?.fileHash,
    fileName: evidence?.fileName,
    page: evidence?.page,
    pdfY: evidence?.pdfY,
    verified: citation.status === "verified",
  };
}
