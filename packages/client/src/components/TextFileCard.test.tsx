import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment } from "@workspace/shared";
import { TextFileCard } from "./TextFileCard";

const apiFetch = vi.fn();

vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    attachmentUrl: (a: Attachment) => `http://api.test${a.url}`,
    apiFetch,
  }),
}));

const notes: Attachment = {
  id: "up-txt",
  name: "message.txt",
  mime: "text/plain",
  size: 80,
  url: "/api/uploads/up-txt/message.txt",
};

describe("TextFileCard", () => {
  it("clips a long file and pops the full text out on Expand", async () => {
    const user = userEvent.setup();
    const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    apiFetch.mockResolvedValue({ ok: true, text: async () => body });

    render(<TextFileCard attachment={notes} mentionRegex={null} />);

    expect(await screen.findByText((value) => value.includes("line 1"))).toBeInTheDocument();
    expect(screen.queryByText((value) => value.includes("line 20"))).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand message.txt" }));
    const dialog = screen.getByRole("dialog", { name: "message.txt" });
    expect(dialog).toHaveTextContent("line 20");

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText((value) => value.includes("line 20"))).not.toBeInTheDocument();
  });

  it("downloads the file in place from the corner button", async () => {
    const user = userEvent.setup();
    const blob = new Blob(["hi"], { type: "text/plain" });
    apiFetch.mockResolvedValue({
      ok: true,
      text: async () => "hi",
      blob: async () => blob,
    });
    const create = vi.fn(() => "blob:file");
    URL.createObjectURL = create;
    URL.revokeObjectURL = vi.fn();
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    render(<TextFileCard attachment={notes} mentionRegex={null} />);

    await user.click(await screen.findByRole("button", { name: "Download message.txt" }));
    expect(apiFetch).toHaveBeenCalledWith("/api/uploads/up-txt/message.txt");
    expect(create).toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("message.txt");
    expect(clicked[0].href).toBe("blob:file");
  });
});
