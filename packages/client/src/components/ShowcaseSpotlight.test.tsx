import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ShowcaseSpotlight } from "./ShowcaseSpotlight";

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});

describe("ShowcaseSpotlight", () => {
  it("dims the product when the guide is the primary focus", () => {
    render(<ShowcaseSpotlight focus={{ kind: "guide", label: "Shared evidence" }} />);
    expect(screen.getByTestId("showcase-dim")).toBeInTheDocument();
  });

  it("cuts out the semantic product target", async () => {
    const { container } = render(
      <>
        <div data-demo-plan-ref="plan-1">Plan</div>
        <ShowcaseSpotlight focus={{ kind: "plan", id: "plan-1", label: "One Plan" }} />
      </>,
    );
    const target = container.querySelector<HTMLElement>("[data-demo-plan-ref]")!;
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
      top: 100,
      left: 120,
      right: 520,
      bottom: 380,
      width: 400,
      height: 280,
      x: 120,
      y: 100,
      toJSON: () => ({}),
    });
    window.dispatchEvent(new Event("resize"));

    await waitFor(() => expect(screen.getByTestId("showcase-spotlight")).toHaveStyle({ left: "112px", top: "92px" }));
    expect(target.scrollIntoView).toHaveBeenCalled();
  });
});
