import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PanelHeader } from "./PanelHeader";

function renderPanelHeader(view: "chat" | "board" | "resources" = "chat") {
  const handlers = {
    onToggleSidebar: vi.fn(),
  };
  const result = render(
    <PanelHeader view={view} sidebarOpen channel="general" {...handlers} />,
  );
  return { ...handlers, unmount: result.unmount };
}

describe("PanelHeader", () => {
  it("toggles the sidebar", async () => {
    const user = userEvent.setup();
    const { onToggleSidebar } = renderPanelHeader();

    await user.click(screen.getByRole("button", { name: "Hide sidebar" }));
    expect(onToggleSidebar).toHaveBeenCalled();
  });

  it("names the room only in the chat view", () => {
    const first = renderPanelHeader("chat");
    expect(screen.getByText("general")).toBeInTheDocument();
    first.unmount();

    renderPanelHeader("board");
    expect(screen.queryByText("general")).toBeNull();
  });
});
