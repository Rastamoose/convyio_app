/**
 * Save bytes as a local file without navigating. A same-origin `download`
 * attribute is ignored when the server sends Content-Disposition: inline
 * (uploads are served that way so <img> can preview them), so we fetch the
 * body and hand the browser a blob URL instead.
 */
export function saveLocalFile(blob: Blob, name: string): void {
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

export async function downloadFromResponse(
  res: Response | null,
  name: string,
): Promise<void> {
  if (!res?.ok) throw new Error("could not download file");
  saveLocalFile(await res.blob(), name);
}
