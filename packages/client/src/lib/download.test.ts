import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadFromResponse, saveLocalFile } from "./download";

const createObjectURL = vi.fn(() => "blob:file");
const revokeObjectURL = vi.fn();

describe("saveLocalFile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
  });

  it("clicks a blob URL with download set, without leaving the page", () => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });

    saveLocalFile(new Blob(["hello"], { type: "text/plain" }), "notes.txt");

    expect(createObjectURL).toHaveBeenCalled();
    expect(clicked).toHaveLength(1);
    expect(clicked[0].download).toBe("notes.txt");
    expect(clicked[0].href).toBe("blob:file");
    expect(clicked[0].target).toBe("");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:file");
  });
});

describe("downloadFromResponse", () => {
  it("saves the response body under the given name", async () => {
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const res = {
      ok: true,
      blob: async () => new Blob(["hi"], { type: "text/plain" }),
    } as Response;

    await downloadFromResponse(res, "message.txt");
    expect(createObjectURL).toHaveBeenCalled();
  });

  it("rejects a missing or failed response", async () => {
    await expect(downloadFromResponse(null, "x")).rejects.toThrow("could not download file");
    await expect(
      downloadFromResponse({ ok: false } as Response, "x"),
    ).rejects.toThrow("could not download file");
  });
});
