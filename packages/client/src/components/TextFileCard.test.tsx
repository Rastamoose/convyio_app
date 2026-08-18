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
  it("clips a long file and expands on Show all", async () => {
    const user = userEvent.setup();
    const body = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
    apiFetch.mockResolvedValue({ ok: true, text: async () => body });

    render(<TextFileCard attachment={notes} mentionRegex={null} />);

    expect(await screen.findByText((value) => value.includes("line 1"))).toBeInTheDocument();
    expect(screen.queryByText((value) => value.includes("line 20"))).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show all" }));
    expect(screen.getByText((value) => value.includes("line 20"))).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(screen.queryByText((value) => value.includes("line 20"))).not.toBeInTheDocument();
  });

  it("puts a download icon in the card corner", async () => {
    apiFetch.mockResolvedValue({ ok: true, text: async () => "hi" });
    render(<TextFileCard attachment={notes} mentionRegex={null} />);

    const link = await screen.findByRole("link", { name: "Download message.txt" });
    expect(link).toHaveAttribute("href", "http://api.test/api/uploads/up-txt/message.txt");
    expect(link).toHaveAttribute("download", "message.txt");
  });
});
