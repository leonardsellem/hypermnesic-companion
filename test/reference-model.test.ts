import { describe, it, expect } from "vitest";
import {
  displayModel,
  formatLink,
  normalizeRefPath,
  referenceLabel,
  samePath,
  sectionBreadcrumb,
} from "../src/surfaces/reference-model";

describe("normalizeRefPath", () => {
  it("collapses repeated slashes, converts backslashes, trims edges", () => {
    expect(normalizeRefPath("/a//b/c.md/")).toBe("a/b/c.md");
    expect(normalizeRefPath("a\\b")).toBe("a/b");
    expect(normalizeRefPath("  note.md  ")).toBe("note.md");
  });
});

describe("samePath — full-path equality guard (R27)", () => {
  it("is true for identical paths", () => {
    expect(samePath("archive/2021/meeting.md", "archive/2021/meeting.md")).toBe(true);
    expect(samePath("/archive//2021/meeting.md", "archive/2021/meeting.md")).toBe(true);
  });

  it("is false when only the basename matches (mis-resolution case)", () => {
    // Engine asked for archive/2021/meeting.md; the vault resolved a DIFFERENT
    // meeting.md by basename fallback — must NOT be treated as the same note.
    expect(samePath("archive/2021/meeting.md", "inbox/meeting.md")).toBe(false);
  });

  it("is false when the roots diverge", () => {
    expect(samePath("master/projects/foo.md", "projects/foo.md")).toBe(false);
  });
});

describe("displayModel", () => {
  it("nested path → basename title + de-emphasized folder", () => {
    expect(displayModel("a/b/Note Title.md")).toEqual({ title: "Note Title", folder: "a/b" });
  });

  it("root-level note → no folder segment", () => {
    expect(displayModel("Note.md")).toEqual({ title: "Note", folder: "" });
  });

  it("strips only the trailing .md extension", () => {
    expect(displayModel("notes/v1.2.md")).toEqual({ title: "v1.2", folder: "notes" });
  });
});

describe("referenceLabel — title → heading → basename (Covers AE1; R3, R4)", () => {
  it("uses a present engine title as the label", () => {
    expect(referenceLabel({ path: "a/b.md", title: "Alpha", heading: "Intro" })).toBe("Alpha");
  });

  it("treats a whitespace-only title as absent and falls to the heading", () => {
    expect(referenceLabel({ path: "a/b.md", title: "   ", heading: "Intro" })).toBe("Intro");
  });

  it("falls all the way to the basename when title and heading are both empty", () => {
    expect(referenceLabel({ path: "a/My Note.md", title: " ", heading: " " })).toBe("My Note");
  });

  it("uses the basename when no title field is present at all", () => {
    expect(referenceLabel({ path: "a/My Note.md" })).toBe("My Note");
  });

  it("renders wikilink / markdown characters in a title as literal text (KTD2 — no link parsing)", () => {
    // A title rendered through MarkdownRenderer would become a create-on-click
    // link; the label helper returns it verbatim and the renderer sets it as text.
    expect(referenceLabel({ path: "a/b.md", title: "[[Foo]] **bar**" })).toBe("[[Foo]] **bar**");
  });
});

describe("sectionBreadcrumb — the faint quoted '· in {section}' context (R4)", () => {
  it("returns the chunk heading for a titled row", () => {
    expect(sectionBreadcrumb({ path: "a/b.md", title: "Alpha", heading: "Methods" })).toBe("Methods");
  });

  it("is suppressed when the heading just repeats the title (no duplicate)", () => {
    expect(sectionBreadcrumb({ path: "a/b.md", title: "Alpha", heading: "Alpha" })).toBeNull();
  });

  it("is null for a titled row that carries no heading", () => {
    expect(sectionBreadcrumb({ path: "a/b.md", title: "Alpha" })).toBeNull();
  });

  it("is null for a recall-style row (no title) so its heading renders the existing way", () => {
    expect(sectionBreadcrumb({ path: "a/b.md", heading: "Methods" })).toBeNull();
  });
});

describe("formatLink — fallback formatter", () => {
  it("renders wikilink form with and without an alias", () => {
    expect(formatLink("a/b.md", undefined, false)).toBe("[[a/b.md]]");
    expect(formatLink("a/b.md", "Alias", false)).toBe("[[a/b.md|Alias]]");
  });

  it("renders markdown form using the alias or derived title", () => {
    expect(formatLink("a/b.md", "Alias", true)).toBe("[Alias](a/b.md)");
    expect(formatLink("a/My Note.md", undefined, true)).toBe("[My Note](a/My%20Note.md)");
  });
});
