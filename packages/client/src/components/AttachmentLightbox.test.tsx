import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment } from "@workspace/shared";
import { AttachmentLightbox } from "./AttachmentLightbox";

// The lightbox reads attachmentUrl from the workspace context; the lightbox
// is the unit under test, so only that collaborator is replaced.
vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    attachmentUrl: (a: Attachment) => `http://api.test${a.url}`,
  }),
}));

const image = (id: string, name: string): Attachment => ({
  id,
  name,
  mime: "image/png",
  size: 2048,
  width: 800,
  height: 600,
  url: `/api/uploads/${id}/${name}`,
});

describe("AttachmentLightbox", () => {
  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<AttachmentLightbox attachment={image("up-1", "cat.png")} onClose={onClose} />);

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders no prev/next controls for a single image", () => {
    render(<AttachmentLightbox attachment={image("up-1", "cat.png")} onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Previous image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
  });

  it("also hides controls when siblings has just the one image", () => {
    const cat = image("up-1", "cat.png");
    render(<AttachmentLightbox attachment={cat} siblings={[cat]} onClose={vi.fn()} />);

    expect(screen.queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
  });

  it("ArrowRight/ArrowLeft step through siblings and wrap at the ends", async () => {
    const user = userEvent.setup();
    const a = image("up-1", "a.png");
    const b = image("up-2", "b.png");
    const c = image("up-3", "c.png");
    render(<AttachmentLightbox attachment={a} siblings={[a, b, c]} onClose={vi.fn()} />);

    expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();

    // Wraps backward past the first image to the last.
    await user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("img", { name: "c.png" })).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("img", { name: "b.png" })).toBeInTheDocument();

    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("img", { name: "c.png" })).toBeInTheDocument();

    // Wraps forward past the last image back to the first.
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();
  });

  it("on-screen chevrons navigate the same way as the arrow keys", async () => {
    const user = userEvent.setup();
    const a = image("up-1", "a.png");
    const b = image("up-2", "b.png");
    render(<AttachmentLightbox attachment={a} siblings={[a, b]} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("img", { name: "b.png" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Previous image" }));
    expect(screen.getByRole("img", { name: "a.png" })).toBeInTheDocument();
  });

  it("falls back to a single image when the opened attachment isn't among the siblings", () => {
    const a = image("up-1", "a.png");
    const other = image("up-2", "other.png");
    render(<AttachmentLightbox attachment={other} siblings={[a]} onClose={vi.fn()} />);

    expect(screen.getByRole("img", { name: "other.png" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next image" })).not.toBeInTheDocument();
  });

  it("keeps the download link pointed at the currently shown image", async () => {
    const user = userEvent.setup();
    const a = image("up-1", "a.png");
    const b = image("up-2", "b.png");
    render(<AttachmentLightbox attachment={a} siblings={[a, b]} onClose={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "Next image" }));
    expect(screen.getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "http://api.test/api/uploads/up-2/b.png",
    );
  });
});
