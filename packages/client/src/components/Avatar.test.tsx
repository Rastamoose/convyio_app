import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { Avatar } from "./Avatar";

describe("Avatar", () => {
  it("uses the mascot for noodle even when callers pass mascot=false", () => {
    const { container } = render(<Avatar name="noodle" size={32} mascot={false} />);
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", "/favicon.svg");
    expect(container.textContent).toBe("");
  });

  it("uses the letter fallback for everyone else", () => {
    const { container } = render(<Avatar name="harris" size={32} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("H");
  });
});
