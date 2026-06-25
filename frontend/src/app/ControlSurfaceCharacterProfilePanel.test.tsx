import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

// The panel fetches the profile on mount; stub the hook so the test is a pure
// render/typing check with no network.
vi.mock("./useCharacterProfile", () => ({
  useCharacterProfile: () => ({
    state: { status: "ready", snapshot: null, action: "idle", message: null, messageTone: "neutral" },
    saveProfile: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined)
  })
}));

import { ControlSurfaceCharacterProfilePanel } from "./ControlSurfaceCharacterProfilePanel";

describe("ControlSurfaceCharacterProfilePanel", () => {
  it("lets the operator type into every profile field without crashing", () => {
    render(<ControlSurfaceCharacterProfilePanel />);

    const boxes = screen.getAllByRole("textbox") as HTMLTextAreaElement[];
    expect(boxes).toHaveLength(4); // personality, do, don't, formatting

    // Reproduces the reported "blank on typing": the onChange must not read a
    // pooled/nulled event field inside the state updater.
    boxes.forEach((box, index) => {
      fireEvent.change(box, { target: { value: `typed-${index}` } });
      expect(box.value).toBe(`typed-${index}`);
    });
  });
});
