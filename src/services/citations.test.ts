import { describe, expect, it } from "vitest";
import {
  evidenceFromStash,
  stripCitationMarkers,
  validateMessageCitations,
  type SourceEvidence,
} from "./citations";
import { createSession, type InterpretationMessage } from "./sessions";
import { createStashItem } from "./stash";

const source = createStashItem(
  {
    tabId: "tab-1",
    fileName: "standard.pdf",
    filePath: "/standard.pdf",
    fileHash: "hash-1",
    page: 23,
    pdfX: 20,
    pdfY: 120,
  },
  "The test voltage shall be 250 V."
);

const sourceMarker = `[[cite:stash-${source.id}]]`;

function assistant(content: string): InterpretationMessage {
  return {
    id: "answer-1",
    role: "assistant",
    content,
    createdAt: 1,
  };
}

describe("citations", () => {
  it("verifies references to user-selected source evidence", () => {
    const session = createSession([source], "question");
    const message = assistant(`Requirement${sourceMarker}`);
    session.messages.push(message);

    const citations = validateMessageCitations(session, message);
    expect(citations).toHaveLength(1);
    expect(citations[0].status).toBe("verified");
    expect(citations[0].evidence).toEqual(evidenceFromStash(source));
  });

  it("rejects fabricated or unknown evidence ids", () => {
    const session = createSession([source], "question");
    const message = assistant("Claim[[cite:src-fabricated]]");
    session.messages.push(message);

    expect(validateMessageCitations(session, message)[0].status).toBe(
      "invalid"
    );
  });

  it("verifies tool evidence only when its tool result is persisted", () => {
    const session = createSession([], "question");
    const evidence: SourceEvidence = {
      id: "src-page-1",
      fileHash: "hash-1",
      fileName: "standard.pdf",
      page: 23,
      quote: "250 V",
      toolCallId: "call-1",
    };
    const message = assistant("Claim[[cite:src-page-1]]");
    session.messages.push(message);
    expect(validateMessageCitations(session, message)[0].status).toBe(
      "invalid"
    );

    session.messages.splice(1, 0, {
      id: "tool-1",
      role: "tool",
      content: "250 V",
      createdAt: 1,
      toolCallId: "call-1",
      evidence: [evidence],
    });
    expect(validateMessageCitations(session, message)[0].status).toBe(
      "verified"
    );
  });

  it("rejects malformed evidence and answers without citations", () => {
    const session = createSession([source], "question");
    const message = assistant("No evidence supplied");
    session.messages.push(message);
    expect(validateMessageCitations(session, message)).toEqual([]);

    session.messages.push({
      id: "tool-1",
      role: "tool",
      content: "bad",
      createdAt: 1,
      evidence: [
        {
          id: "src-bad",
          fileHash: "",
          fileName: "standard.pdf",
          page: 0,
        },
      ],
    });
    const invalid = assistant("Bad[[cite:src-bad]]");
    expect(validateMessageCitations(session, invalid)[0].status).toBe(
      "invalid"
    );
  });

  it("deduplicates references and strips internal markers for exports", () => {
    const session = createSession([source], "question");
    const message = assistant(`A${sourceMarker} B${sourceMarker}`);
    session.messages.push(message);
    expect(validateMessageCitations(session, message)).toHaveLength(1);
    expect(stripCitationMarkers(`要求${sourceMarker}。`)).toBe("要求。");
  });
});
