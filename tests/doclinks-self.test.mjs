import { describe, it, expect } from "vitest";
import * as docLinks from "../gates/doc-links.mjs";

const at = (path, text) => [{ path, text }];
const rules = (f) => f.map((x) => x.rule);
const repo = ["README.md", "docs/guide.md", "gates/scope.mjs"];
const cfg = { repoUrl: "https://github.com/ajeermahmood/bouncer-gates" };

describe("doc-links: absolute links back into this repository", () => {
  it("validates a self-referencing blob link", () => {
    // Why this exists: a README published to npm keeps its relative links
    // verbatim and they resolve against npmjs.com, where they all 404. This
    // repository's own package page had nineteen broken links for that reason.
    // Rewriting them absolute fixes npm; recognising our own repo keeps them
    // covered by the gate instead of silently skipped as external.
    const good = "[g](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/guide.md)";
    expect(docLinks.scan(at("README.md", good), repo, cfg)).toHaveLength(0);

    const bad = "[g](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/gone.md)";
    expect(rules(docLinks.scan(at("README.md", bad), repo, cfg))).toEqual(["doc-links/broken"]);
  });

  it("handles tree links and any ref", () => {
    const tree = "[d](https://github.com/ajeermahmood/bouncer-gates/tree/v1.2.3/docs)";
    expect(docLinks.scan(at("README.md", tree), repo, cfg)).toHaveLength(0);
  });

  it("keeps anchors working on a self link", () => {
    const anchored = "[g](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/guide.md#setup)";
    expect(docLinks.scan(at("README.md", anchored), repo, cfg)).toHaveLength(0);
  });

  it("leaves other repositories alone", () => {
    const other = "[x](https://github.com/someone/else/blob/main/docs/nope.md)";
    expect(docLinks.scan(at("README.md", other), repo, cfg)).toHaveLength(0);
  });

  it("does nothing when no repoUrl is configured", () => {
    const bad = "[g](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/gone.md)";
    expect(docLinks.scan(at("README.md", bad), repo)).toHaveLength(0);
  });
});
