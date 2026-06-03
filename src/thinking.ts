/**
 * src/thinking.ts — in-editor thinking-mode as a dockable panel (U39 + first-class
 * redesign, FR-R10/R11/R12).
 *
 * "Think about this note/selection" calls the engine's read-only `think` tool and
 * renders, in fixed order, Related → Not yet linked → Question in a persistent,
 * dockable ItemView (like Backlinks/Outline) — not a dead-end modal. Related notes
 * and each side of an unlinked pair render through the shared reference-row
 * primitive (titled label, navigable links, Page-preview hover); the pair
 * connective is an inert, aria-hidden hint, never a "link these" control. Only the
 * single Socratic question renders as markdown, with unresolved links neutralized
 * so a click never creates a note (R28, KTD2). A visible `wrote: false` proof badge
 * and the trust badge ride every render; there is NO write affordance. Read-only.
 */
import {
  HoverPopover,
  ItemView,
  MarkdownRenderer,
  Notice,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { RelatedItem, ThinkResponse, UnlinkedPair, callTool, parseToolResult } from "./core";
import {
  exclusionPathForDeepen,
  isUnexpectedArgError,
  thinkArgs,
  validPairs,
} from "./think-helpers";
import { renderTrustBadge } from "./state";
import {
  ReferenceRowDeps,
  enableRovingFocus,
  linkResolvesLocally,
  renderReference,
  resolveReference,
} from "./surfaces/reference";
import { ReferenceInput, normalizeRefPath, referenceLabel } from "./surfaces/reference-model";

export const THINKING_VIEW_TYPE = "hypermnesic-thinking";

/** Bound the think-deeper history so a long chain can't grow memory unbounded;
 *  at the cap, "think deeper" is disabled so "back" always reaches the origin. */
const MAX_THINK_DEPTH = 10;

/** A cached frame on the think-deeper history stack — engine data only, so each
 *  render re-resolves references against the live vault (KTD6). */
interface ThinkingFrame {
  topic: string;
  sourcePath: string;
  state: ThinkingState;
  response: ThinkResponse | null;
}

export interface ThinkingDeps {
  getUrl(): string;
  hasThink(): boolean;
  /** `think` advertises a `path` parameter — self-exclusion is sendable (KTD3). */
  thinkAcceptsPath(): boolean;
  /** Whether the load-time capability probe has settled (R26). */
  probed(): boolean;
  /** Resolves when the in-flight probe settles, so a pre-probe trigger can retry. */
  probeReady(): Promise<void>;
  /** Shared reference-row deps (resolution, navigation, hover, menu, insertion). */
  rowDeps: ReferenceRowDeps;
}

type ThinkingState = "idle" | "probing" | "loading" | "ready" | "unavailable" | "unreachable";

/** Adapt an engine `related` item into the shared reference shape, carrying the
 *  H1 `title` so the row labels by title with a quoted-section breadcrumb (U2).
 *  An item with no usable path renders as a non-local row rather than crashing;
 *  an item with no `title` (older engine) degrades to basename + heading (R22). */
function toReferenceInput(related: RelatedItem): ReferenceInput {
  const path = typeof related.path === "string" ? related.path : "";
  const heading = typeof related.heading === "string" ? related.heading : undefined;
  const title = typeof related.title === "string" ? related.title : undefined;
  const snippet = typeof related.snippet === "string" ? related.snippet : undefined;
  if (path) return { path, heading, title, snippet };
  return { path: title ?? heading ?? "(unresolved related item)", heading, title, snippet };
}

export class ThinkingView extends ItemView {
  // Satisfy HoverParent so reference rows in this panel get native Page-preview.
  hoverPopover: HoverPopover | null = null;

  private topic = "";
  private sourcePath = "";
  private state: ThinkingState = "idle";
  private response: ThinkResponse | null = null;
  /** Prior frames for the think-deeper back affordance (KTD6). */
  private stack: ThinkingFrame[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private deps: ThinkingDeps,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return THINKING_VIEW_TYPE;
  }
  getDisplayText(): string {
    return "hypermnesic — thinking";
  }
  getIcon(): string {
    return "brain";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  /** Closing the leaf clears the chain so a re-opened panel starts fresh, never
   *  resurrecting a stale back-stack (KTD6). */
  async onClose(): Promise<void> {
    this.stack = [];
    this.response = null;
    this.state = "idle";
    this.topic = "";
  }

  /** Push the current frame and think about a related note in place (R11). */
  private async deepen(topic: string, sourcePath: string): Promise<void> {
    if (this.stack.length >= MAX_THINK_DEPTH) {
      new Notice("hypermnesic: thinking depth limit reached");
      return;
    }
    this.stack.push({
      topic: this.topic,
      sourcePath: this.sourcePath,
      state: this.state,
      response: this.response,
    });
    await this.loadTopic(topic, sourcePath);
  }

  /** Pop to the cached prior frame; render re-resolves its references (KTD6). */
  private goBack(): void {
    const prev = this.stack.pop();
    if (!prev) return;
    this.topic = prev.topic;
    this.sourcePath = prev.sourcePath;
    this.state = prev.state;
    this.response = prev.response;
    this.render();
  }

  /** Fresh entry point (the command / menu): start a new chain. `sourcePath` is
   *  the note the topic came from — it keeps reference resolution stable as the
   *  panel survives navigation (R8). */
  async setTopic(topic: string, sourcePath: string): Promise<void> {
    this.stack = [];
    await this.loadTopic(topic, sourcePath);
  }

  /** Engine URL changed: clear the result + back-stack to idle so back/deepen can't
   *  mix two engines' corpora and a flipped path-capability can't leak (R27, KTD5). */
  resetForEngineChange(): void {
    this.stack = [];
    this.response = null;
    this.state = "idle";
    this.topic = "";
    this.sourcePath = "";
    this.render();
  }

  private async loadTopic(topic: string, sourcePath: string): Promise<void> {
    this.topic = topic;
    this.sourcePath = sourcePath;

    // The load-time probe is fire-and-forget: a trigger before it settles must show
    // a transient "checking…" and retry once it lands — never a false "unavailable"
    // (R26). Await the single in-flight probe rather than starting a second (KTD4).
    if (!this.deps.probed()) {
      this.state = "probing";
      this.response = null;
      this.render();
      await this.deps.probeReady();
    }

    if (!this.deps.hasThink()) {
      this.state = "unavailable";
      this.response = null;
      this.render();
      return;
    }

    this.state = "loading";
    this.response = null;
    this.render();

    try {
      this.response = await this.fetchThink(topic, sourcePath);
      this.state = "ready";
    } catch {
      this.response = null;
      this.state = "unreachable";
    }
    this.render();
  }

  /** Call `think`, sending `path` for self-exclusion when supported (KTD3). If a
   *  served schema omits `path`, the engine rejects the extra argument; classify
   *  that and retry once without it. Any other failure propagates to "unreachable". */
  private async fetchThink(topic: string, sourcePath: string): Promise<ThinkResponse | null> {
    const args = thinkArgs(topic, sourcePath, this.deps.thinkAcceptsPath());
    try {
      return parseToolResult<ThinkResponse>(await callTool(this.deps.getUrl(), "think", args));
    } catch (err) {
      if ("path" in args && isUnexpectedArgError(err)) {
        return parseToolResult<ThinkResponse>(
          await callTool(this.deps.getUrl(), "think", thinkArgs(topic, sourcePath, false)),
        );
      }
      throw err;
    }
  }

  private get body(): HTMLElement {
    return this.containerEl.children[1] as HTMLElement;
  }

  private render(): void {
    const root = this.body;
    root.empty();
    root.addClass("hypermnesic-thinking");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "hypermnesic thinking");

    renderTrustBadge(root);

    // The observable no-write assertion — a visible proof badge (FR-R11/R10).
    // A truthy `wrote` is the only warning trigger; `wrote: false` is the explicit
    // proof; an absent `wrote` (older engine) degrades to the quiet badge, never
    // the warning (R29).
    const wrote = this.response?.wrote;
    const badge = root.createEl("div", { cls: "hypermnesic-wrote-badge" });
    if (wrote === true) {
      badge.setText("⚠ unexpected write flag");
    } else if (wrote === false) {
      badge.setText("✓ read-only · wrote: false");
    } else {
      badge.setText("read-only");
    }
    badge.setAttribute("aria-label", "this thinking surface made no writes");

    if (this.stack.length > 0) this.renderNav(root);

    if (this.topic) {
      root.createEl("h3", { cls: "hypermnesic-thinking-topic", text: this.topic });
    }

    const banner = root.createEl("div", { cls: "hypermnesic-status" });
    banner.setAttribute("aria-live", "polite");

    switch (this.state) {
      case "idle":
        banner.setText("Run “Think about this note or selection” to begin.");
        return;
      case "probing":
        banner.setText("checking the engine…");
        return;
      case "loading":
        banner.setText("thinking…");
        return;
      case "unavailable":
        banner.setText("thinking-mode unavailable on this engine");
        return;
      case "unreachable":
        banner.setText("could not reach the tailnet index");
        return;
    }

    const resp = this.response;
    if (!resp) {
      banner.setText("no response from thinking-mode");
      return;
    }
    if (resp.degraded_lexical_only) banner.setText("lexical-only — the semantic channel is down");

    const related = resp.related ?? [];
    const unlinked = resp.unlinked ?? [];
    const questions = resp.questions ?? [];
    if (!related.length && !unlinked.length && !questions.length) {
      banner.setText("nothing relevant yet — the index has no close match");
      return;
    }

    // Fixed order: Related (the navigable middle) → Not yet linked → Question.
    // Zero-item sections are omitted (renderers no-op on empty input).
    this.renderRelatedSection(root, related);
    this.renderUnlinkedSection(root, unlinked);
    this.renderQuestionSection(root, questions);
  }

  /** Back control + topic breadcrumb, shown while a think-deeper chain is open. */
  private renderNav(root: HTMLElement): void {
    const nav = root.createDiv({ cls: "hypermnesic-think-nav" });
    const back = nav.createEl("button", { cls: "hypermnesic-back" });
    back.setAttribute("aria-label", "Back to the previous thinking result");
    setIcon(back, "arrow-left");
    back.createSpan({ text: "Back" });
    back.addEventListener("click", () => this.goBack());

    const crumbs = nav.createSpan({ cls: "hypermnesic-breadcrumb" });
    crumbs.setAttribute("aria-hidden", "true");
    const trail = [...this.stack.map((f) => f.topic), this.topic];
    trail.forEach((label, i) => {
      if (i > 0) crumbs.createSpan({ cls: "hypermnesic-crumb-sep", text: " › " });
      crumbs.createSpan({ cls: "hypermnesic-crumb", text: label });
    });
  }

  private sectionHeader(host: HTMLElement, title: string, count: number): void {
    const h = host.createEl("h4", { cls: "hypermnesic-think-heading", text: title });
    h.createSpan({ cls: "hypermnesic-count", text: String(count) });
  }

  /** The single Socratic prompt: a quiet, un-railed line. The ONLY markdown path
   *  (KTD2) — embedded note refs stay live, unresolved links neutralized so a
   *  click never creates a note (R13, R14, AE9). Engine gates this to 0–1 items;
   *  if it ever sends more, each renders as its own quiet line. */
  private renderQuestionSection(root: HTMLElement, questions: string[]): void {
    if (!questions.length) return;
    const sec = root.createDiv({ cls: "hypermnesic-think-question" });
    this.sectionHeader(sec, "Question", questions.length);
    for (const q of questions) {
      const line = sec.createDiv({ cls: "hypermnesic-question-line" });
      // Guard the rendered links even if render rejects, so a partial render can
      // never leave an un-neutralized create-on-click link (R28 hardening).
      void MarkdownRenderer.render(this.deps.rowDeps.app, q, line, this.sourcePath, this)
        .then(() => this.guardProseLinks(line))
        .catch(() => this.guardProseLinks(line));
    }
  }

  /** Neutralize MarkdownRenderer-emitted links that don't resolve locally so a
   *  click never creates a note (R28, AE9). Resolvable links keep native
   *  navigation/preview and open the existing note. */
  private guardProseLinks(container: HTMLElement): void {
    container.querySelectorAll("a.internal-link").forEach((node) => {
      const el = node as HTMLElement;
      const href = el.getAttribute("data-href") ?? el.getAttribute("href") ?? "";
      if (href && linkResolvesLocally(this.deps.rowDeps.app, href, this.sourcePath)) return;
      el.removeClass("internal-link");
      el.addClass("hypermnesic-link-unresolved");
      el.removeAttribute("href");
      el.setAttribute("aria-disabled", "true");
      el.setAttribute("title", "not in this vault");
      el.addEventListener("click", (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
      });
    });
  }

  private renderRelatedSection(root: HTMLElement, related: RelatedItem[]): void {
    if (!related.length) return;
    const sec = root.createDiv({ cls: "hypermnesic-think-section hypermnesic-thinking-related" });
    this.sectionHeader(sec, "Related", related.length);
    const list = sec.createEl("ul", { cls: "hypermnesic-related-list" });
    list.setAttribute("role", "list");
    const focusables: HTMLElement[] = [];
    const atCap = this.stack.length >= MAX_THINK_DEPTH;
    for (const item of related) {
      const li = list.createEl("li", { cls: "hypermnesic-hit" });
      li.setAttribute("role", "listitem");
      const resolved = resolveReference(this.deps.rowDeps.app, toReferenceInput(item), this.sourcePath);
      focusables.push(renderReference(li, resolved, this.sourcePath, this.deps.rowDeps, this));

      // Inline "think deeper" — re-runs `think` on this note in place (R11).
      const deepen = li.createEl("button", { cls: "hypermnesic-deepen" });
      setIcon(deepen, "brain");
      if (atCap) {
        deepen.setAttribute("disabled", "true");
        deepen.setAttribute("aria-label", "Think deeper (depth limit reached)");
      } else {
        deepen.setAttribute("aria-label", `Think deeper about ${resolved.display.title}`);
        // Exclude the deepened note itself — its own resolved path, or NO path for
        // a non-local row (never the original note's path, the R16 mis-exclusion).
        deepen.addEventListener("click", () =>
          void this.deepen(resolved.display.title, exclusionPathForDeepen(resolved.file?.path)),
        );
      }
    }
    enableRovingFocus(list, focusables);
  }

  /** "Not yet linked": co-retrieved note pairs the engine surfaced as not yet
   *  connected. Client-side guard drops same-note / self pairs on resolved
   *  identity (R28, KTD6). Each surviving pair is a group; roving focus reaches
   *  only the navigable (local) sides — never the inert connective or a non-local
   *  side (R24, R25). No "link these" affordance — that stays on the write path. */
  private renderUnlinkedSection(root: HTMLElement, unlinked: UnlinkedPair[]): void {
    const resolveIdentity = (p: string): string => {
      const r = resolveReference(this.deps.rowDeps.app, { path: p }, this.sourcePath);
      return r.file ? r.file.path : normalizeRefPath(p);
    };
    const pairs = validPairs(unlinked, resolveIdentity, this.sourcePath);
    if (!pairs.length) return;

    const sec = root.createDiv({ cls: "hypermnesic-think-section hypermnesic-thinking-unlinked" });
    this.sectionHeader(sec, "Not yet linked", pairs.length);
    const list = sec.createEl("ul", { cls: "hypermnesic-unlinked-list" });
    list.setAttribute("role", "list");

    const focusables: HTMLElement[] = [];
    for (const pair of pairs) {
      const li = list.createEl("li", { cls: "hypermnesic-hit hypermnesic-unlinked-pair" });
      li.setAttribute("role", "group");
      const aLabel = referenceLabel({ path: pair.a_path, title: pair.a_title });
      const bLabel = referenceLabel({ path: pair.b_path, title: pair.b_title });
      li.setAttribute("aria-label", `${aLabel} and ${bLabel} — related but not yet linked`);

      const a = this.renderPairSide(li, pair.a_path, pair.a_title);
      if (a) focusables.push(a);

      // The inert connective: faint, aria-hidden, non-interactive — reads as a
      // neutral "and", never "connect these" (KTD8). Not a focus stop.
      const conn = li.createSpan({ cls: "hypermnesic-pair-connective", text: " · " });
      conn.setAttribute("aria-hidden", "true");

      const b = this.renderPairSide(li, pair.b_path, pair.b_title);
      if (b) focusables.push(b);
    }
    enableRovingFocus(list, focusables);
  }

  /** Render ONE side of an unlinked pair as plain text (never markdown, KTD2). A
   *  resolvable side is a navigable link that opens a resolved TFile — never
   *  openLinkText, which would create-on-miss (R6). A non-local side is muted
   *  "not in this vault" text with no peek and no focus stop (R9, R24). Returns
   *  the focusable link, or null for a non-local side. */
  private renderPairSide(
    host: HTMLElement,
    path: string,
    title: string | undefined,
  ): HTMLElement | null {
    const resolved = resolveReference(this.deps.rowDeps.app, { path, title }, this.sourcePath);
    const label = referenceLabel({ path, title });
    if (resolved.file) {
      const file = resolved.file;
      const link = host.createEl("a", {
        cls: "internal-link hypermnesic-ref-link hypermnesic-pair-side",
        text: label,
        href: "#",
      });
      link.setAttribute("aria-label", label);
      link.setAttribute("title", label);
      link.addEventListener("click", (evt) => {
        evt.preventDefault();
        this.deps.rowDeps.openFile(file, false);
      });
      link.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter" || evt.key === " ") {
          evt.preventDefault();
          this.deps.rowDeps.openFile(file, false);
        }
      });
      // Native Page-preview hover, consistent with the related rows (KTD4).
      link.addEventListener("mouseover", (evt) => {
        if (this.deps.rowDeps.pagePreviewEnabled()) {
          this.deps.rowDeps.app.workspace.trigger("hover-link", {
            event: evt,
            source: "hypermnesic-companion",
            hoverParent: this,
            targetEl: link,
            linktext: file.path,
            sourcePath: this.sourcePath,
          });
        }
      });
      return link;
    }
    const span = host.createSpan({ cls: "hypermnesic-pair-side hypermnesic-ref-nonlocal" });
    span.setAttribute("tabindex", "-1");
    span.setAttribute("aria-label", `${label}, not in this vault`);
    span.createSpan({ cls: "hypermnesic-ref-title", text: label });
    span.createSpan({ cls: "hypermnesic-not-in-vault", text: "not in this vault" });
    return null;
  }
}
