import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  parseSkillSetPackUrl,
  renderSkillSetPackLandingPage,
  skillSetPackDesktopUrl,
  SkillSetPackPreview,
} from "../src/domain/skill-set-pack";

const TOKEN = "A".repeat(43);

describe("Skill Set Pack protocol", () => {
  it.effect("derives same-origin preview and content endpoints from a branded URL", () =>
    Effect.gen(function* () {
      const parsed = yield* parseSkillSetPackUrl(`https://team.example/p/${TOKEN}`);
      assert.strictEqual(
        parsed.previewUrl.href,
        `https://team.example/api/v1/public/packs/${TOKEN}`,
      );
      assert.strictEqual(
        parsed.contentUrl.href,
        `https://team.example/api/v1/public/packs/${TOKEN}/content`,
      );
    }),
  );

  it.effect("rejects non-branded paths and URL decorations", () =>
    Effect.gen(function* () {
      yield* Effect.flip(parseSkillSetPackUrl(`https://team.example/x/${TOKEN}`));
      yield* Effect.flip(
        parseSkillSetPackUrl(`https://team.example/p/${TOKEN}?redirect=elsewhere`),
      );
    }),
  );

  it("creates an exact Desktop handoff without putting the Pack URL in a query string", () => {
    assert.strictEqual(
      skillSetPackDesktopUrl(`https://team.example/p/${TOKEN}`),
      `selftune://pack/aHR0cHM6Ly90ZWFtLmV4YW1wbGU/${TOKEN}`,
    );
  });

  it("renders a metadata-first landing page with review and license details", () => {
    const preview = new SkillSetPackPreview({
      protocol: "selftune.skill-set-pack.v1",
      packId: "pack-1",
      artifactId: "skill-set/launch/revision",
      name: "Launch review",
      description: "A pinned review workflow.",
      skillSetRevisionSha256: "a".repeat(64),
      objectSha256: "b".repeat(64),
      mode: "reusable_unlisted",
      expiresAt: "2026-09-07T10:00:00.000Z",
      requiresSignIn: false,
      components: [{ logicalSkillId: "release-review", licenseExpression: "MIT" }],
    });
    const html = renderSkillSetPackLandingPage({
      packUrl: `https://team.example/p/${TOKEN}`,
      preview,
    });
    assert.match(html, /Open in SelfTune Desktop/);
    assert.match(html, /release-review/);
    assert.match(html, /MIT/);
    assert.match(html, /Desktop opens a review first/);
  });
});
