import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { buildMentionRegex, renderContent, renderMessageContent } from "./markdown";

const mentionRegex = buildMentionRegex(["hana", "omar"]);

describe("renderContent", () => {
  it("is length-preserving: no syntax characters are stripped, just wrapped", () => {
    const content = "**hi** @hana see task-1 `x`";
    const { container } = render(<div>{renderContent(content, mentionRegex, true)}</div>);

    expect(container.textContent).toBe(content);
  });

  it("pill-renders mentions and task-refs, wired to onRefClick", () => {
    const content = "@hana check task-42";
    const onRefClick = () => {};
    const { container } = render(
      <div>{renderContent(content, mentionRegex, true, onRefClick)}</div>,
    );

    expect(container.querySelector("[class*='bg-accent/']")?.textContent).toBe("@hana");
    expect(container.querySelector(".text-accent")?.textContent).toBe("task-42");
  });
});

describe("renderMessageContent", () => {
  it("renders a fenced code block as pre/code with no markdown or mentions inside", () => {
    const content = "```js\nconst x = **1**; // @hana\n```";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    const pre = container.querySelector("pre code");
    expect(pre?.textContent).toBe("const x = **1**; // @hana");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("[class*='bg-accent/']")).toBeNull();
  });

  it("renders inline code with no markdown or mentions inside", () => {
    const content = "run `**@hana** task-1` now";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    const code = container.querySelector("code");
    expect(code?.textContent).toBe("**@hana** task-1");
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("[class*='bg-accent/']")).toBeNull();
  });

  it("renders a blockquote line with a left border", () => {
    const content = "> quoted line";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    const quote = container.querySelector(".border-l-2");
    expect(quote?.textContent).toBe("quoted line");
  });

  it("renders bold, underline, italic and strikethrough, nestable", () => {
    const content = "**bold *and italic* text** __under__ *it* _it2_ ~~gone~~";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    const strong = container.querySelector("strong");
    expect(strong?.textContent).toBe("bold and italic text");
    expect(strong?.querySelector("em")?.textContent).toBe("and italic");
    expect(container.querySelector(".underline")?.textContent).toBe("under");
    expect(container.querySelectorAll("em")).toHaveLength(3); // nested + two standalone
    expect(container.querySelector(".line-through")?.textContent).toBe("gone");
  });

  it("does not treat spaced asterisks as emphasis", () => {
    const content = "3 * 4 * 5 = 60";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    expect(container.querySelector("em")).toBeNull();
    expect(container.textContent).toBe(content);
  });

  it("autolinks bare URLs, keeping trailing punctuation and unbalanced parens outside", () => {
    const content = "see http://example.com/a, and (http://example.com/b) done.";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    const links = Array.from(container.querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "http://example.com/a",
      "http://example.com/b",
    ]);
    for (const a of links) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    }
    expect(container.textContent).toBe(content);
  });

  it("keeps a balanced trailing paren as part of the URL", () => {
    const content = "http://en.wikipedia.org/wiki/Foo_(bar)";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    expect(container.querySelector("a")?.getAttribute("href")).toBe(content);
  });

  it("still pill-renders mentions and task-refs outside code", () => {
    const content = "@hana please look at task-7";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    expect(container.querySelector("[class*='bg-accent/']")?.textContent).toBe("@hana");
    expect(container.querySelector(".text-accent")?.textContent).toBe("task-7");
  });

  it("renders headings and lists without leaving the markers", () => {
    const content = "#### greeting\nI am **noodle**.\n\n* be useful\n* be kind\n\n1. first\n2. second";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    expect(container.textContent).not.toContain("####");
    expect(container.textContent).not.toMatch(/(^|\n)\* /);
    expect(container.querySelector(".text-sm.font-semibold")?.textContent).toBe("greeting");
    expect(container.querySelector("strong")?.textContent).toBe("noodle");
    expect(container.textContent).toContain("•");
    expect(container.textContent).toContain("be useful");
    expect(container.textContent).toContain("1.");
    expect(container.textContent).toContain("first");
  });

  it("renders a raw script tag as literal text, never as an element", () => {
    const content = "<script>alert(1)</script>";
    const { container } = render(<div>{renderMessageContent(content, mentionRegex)}</div>);

    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toBe(content);
  });
});
