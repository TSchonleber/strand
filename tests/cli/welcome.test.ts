/**
 * Welcome splash tests. No polling, no data source — just a pure component
 * render with injected command + tool lists.
 */

import { DEFAULT_COMMANDS, Welcome, type WelcomeEntry } from "@/cli/tui/welcome";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

const SAMPLE_TOOLS: WelcomeEntry[] = [
  { name: "fs_read", description: "read a text file" },
  { name: "http_fetch", description: "HTTP GET with SSRF guard" },
  { name: "git_status", description: "git status --porcelain" },
];

describe("strand tui welcome", () => {
  it("renders the banner + command + tool columns", () => {
    const tree = createElement(Welcome, {
      commands: DEFAULT_COMMANDS,
      tools: SAMPLE_TOOLS,
    });
    const { lastFrame, unmount } = render(tree);
    const frame = lastFrame() ?? "";

    // Banner renders (ink-big-text converts STRAND to block letters;
    // any non-empty frame proves the render path is working).
    expect(frame.length).toBeGreaterThan(0);

    // Section headers
    expect(frame).toContain("COMMANDS");
    expect(frame).toContain("TOOLS");

    // Command names appear
    expect(frame).toContain("run <goal>");
    expect(frame).toContain("tui");
    expect(frame).toContain("status");
    expect(frame).toContain("keys");

    // Tool names appear
    expect(frame).toContain("fs_read");
    expect(frame).toContain("http_fetch");
    expect(frame).toContain("git_status");

    // Subtitle + footer hint (non-TTY path logs a hint instead of keys)
    expect(frame).toMatch(/agent harness|non-TTY/);

    unmount();
  });

  it("renders cleanly with zero tools", () => {
    const tree = createElement(Welcome, {
      commands: DEFAULT_COMMANDS,
      tools: [],
    });
    const { lastFrame, unmount } = render(tree);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("COMMANDS");
    expect(frame).toContain("TOOLS");
    unmount();
  });
});
