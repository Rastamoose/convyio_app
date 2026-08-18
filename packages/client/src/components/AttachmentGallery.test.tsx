import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Attachment } from "@workspace/shared";
import { AttachmentGallery } from "./AttachmentGallery";

// The gallery reads attachmentUrl from the workspace context; the gallery is
// the unit under test, so only that collaborator is replaced.
const apiFetch = vi.fn();

vi.mock("../hooks/WorkspaceContext", () => ({
  useWorkspace: () => ({
    attachmentUrl: (a: Attachment) => `http://api.test${a.url}`,
    apiFetch,
  }),
}));

const image = (id: string, name: string, dims = true): Attachment => ({
  id,
  name,
  mime: "image/png",
  size: 2048,
  ...(dims ? { width: 800, height: 600 } : {}),
  url: `/api/uploads/${id}/${name}`,
});

const pdf: Attachment = {
  id: "up-pdf",
  name: "report.pdf",
  mime: "application/pdf",
  size: 12_900_000,
  url: "/api/uploads/up-pdf/report.pdf",
};

const notes: Attachment = {
  id: "up-txt",
  name: "notes.txt",
  mime: "text/plain",
  size: 42,
  url: "/api/uploads/up-txt/notes.txt",
};

describe("AttachmentGallery", () => {
  const onImageClick = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetch.mockResolvedValue({
      ok: true,
      text: async () => "line one\nline two",
    });
  });

  it("renders a single image as a thumbnail with the session-prefixed src and reserved box", () => {
    render(
      <AttachmentGallery
        attachments={[image("up-1", "cat.png")]}
        onImageClick={onImageClick}
      />,
    );

    const img = screen.getByRole("img", { name: "cat.png" });
    expect(img).toHaveAttribute(
      "src",
      "http://api.test/api/uploads/up-1/cat.png",
    );
    // 800x600 scaled into the 400x350 cap → 400px wide, ratio preserved.
    expect(img).toHaveStyle({ width: "400px", aspectRatio: "800 / 600" });
  });

  it("clicking an image thumbnail reports the attachment", async () => {
    const user = userEvent.setup();
    const cat = image("up-1", "cat.png");
    render(<AttachmentGallery attachments={[cat]} onImageClick={onImageClick} />);

    await user.click(screen.getByRole("button", { name: "View cat.png" }));
    expect(onImageClick).toHaveBeenCalledWith(cat);
  });

  it("lays two or more images out as uniform grid cells", () => {
    render(
      <AttachmentGallery
        attachments={[image("up-1", "a.png"), image("up-2", "b.png", false)]}
        onImageClick={onImageClick}
      />,
    );

    const cells = screen.getAllByRole("button");
    expect(cells).toHaveLength(2);
    expect(cells[0].parentElement).toHaveClass("grid-cols-2");
    expect(screen.getByRole("img", { name: "b.png" })).toHaveAttribute(
      "src",
      "http://api.test/api/uploads/up-2/b.png",
    );
  });

  it("renders a non-image as a download card with name link and human size", () => {
    render(<AttachmentGallery attachments={[pdf]} onImageClick={onImageClick} />);

    const link = screen.getByRole("link", { name: "Download report.pdf" });
    expect(link).toHaveAttribute(
      "href",
      "http://api.test/api/uploads/up-pdf/report.pdf",
    );
    expect(link).toHaveAttribute("download", "report.pdf");
    expect(screen.getByText("report.pdf")).toBeInTheDocument();
    expect(screen.getByText("12.3 MB")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("renders mixed attachments as image thumbnails plus file cards", () => {
    render(
      <AttachmentGallery
        attachments={[image("up-1", "cat.png"), pdf]}
        onImageClick={onImageClick}
      />,
    );

    expect(screen.getByRole("img", { name: "cat.png" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download report.pdf" })).toBeInTheDocument();
  });

  it("renders a text file as an inline readable card, not a download-only link", async () => {
    render(<AttachmentGallery attachments={[notes]} onImageClick={onImageClick} />);

    expect(await screen.findByText((value) => value.includes("line one"))).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Download notes.txt" })).toHaveAttribute(
      "href",
      "http://api.test/api/uploads/up-txt/notes.txt",
    );
    expect(screen.queryByRole("link", { name: "notes.txt" })).not.toBeInTheDocument();
    expect(apiFetch).toHaveBeenCalledWith("/api/uploads/up-txt/notes.txt");
  });
});
