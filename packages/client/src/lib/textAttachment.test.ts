import { describe, expect, it } from "vitest";
import {
  isTextAttachment,
  LONG_MESSAGE_FILENAME,
  LONG_MESSAGE_PREVIEW,
  MESSAGE_BODY_LIMIT,
  splitOversizedMessage,
} from "./textAttachment";
import type { Attachment } from "@workspace/shared";

const file = (name: string, mime: string): Attachment => ({
  id: "up-1",
  name,
  mime,
  size: 12,
  url: `/api/uploads/up-1/${name}`,
});

describe("splitOversizedMessage", () => {
  it("leaves a short draft as-is", () => {
    expect(splitOversizedMessage("hello")).toBeNull();
    expect(splitOversizedMessage("x".repeat(MESSAGE_BODY_LIMIT))).toBeNull();
  });

  it("turns a long draft into a preview plus message.txt", () => {
    const text = `${"word ".repeat(100)}@agent please look\n${"x".repeat(MESSAGE_BODY_LIMIT)}`;
    const split = splitOversizedMessage(text);
    expect(split).not.toBeNull();
    expect(split!.content.length).toBeLessThan(text.length);
    expect(split!.content).toContain("…");
    expect(split!.content).toContain("@agent");
    expect(split!.file.name).toBe(LONG_MESSAGE_FILENAME);
    expect(split!.file.type).toBe("text/plain");
    expect(split!.file.size).toBe(text.length);
  });

  it("appends mentions the preview would drop", () => {
    const prefix = "a".repeat(MESSAGE_BODY_LIMIT);
    const text = `${prefix} please see @noodle and @bea`;
    const split = splitOversizedMessage(text);
    expect(split).not.toBeNull();
    expect(split!.content.length).toBeLessThanOrEqual(LONG_MESSAGE_PREVIEW + 40);
    expect(split!.content).toMatch(/@noodle/);
    expect(split!.content).toMatch(/@bea/);
  });
});

describe("isTextAttachment", () => {
  it("treats text mime and common extensions as readable", () => {
    expect(isTextAttachment(file("notes.txt", "application/octet-stream"))).toBe(true);
    expect(isTextAttachment(file("readme.md", "text/markdown"))).toBe(true);
    expect(isTextAttachment(file("data.json", "application/json"))).toBe(true);
    expect(isTextAttachment(file("report.pdf", "application/pdf"))).toBe(false);
  });
});
