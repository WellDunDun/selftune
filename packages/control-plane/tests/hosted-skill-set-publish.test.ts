import { describe, expect, it } from "vitest";
import * as Schema from "effect/Schema";

import {
  HostedSkillSetPublishFinalizeRequest,
  HostedSkillSetPublishIntentReceipt,
  HostedSkillSetPublishIntentRequest,
  HostedSkillSetPublishUploadReceipt,
  HostedSkillSetReleaseReceipt,
  MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES,
} from "../src";

const revisionSha256 = "1".repeat(64);
const envelopeSha256 = "2".repeat(64);

describe("hosted Skill Set publish contracts", () => {
  it("bounds the intent, upload, finalize, and immutable release wire values", () => {
    expect(
      Schema.decodeUnknownSync(HostedSkillSetPublishIntentRequest)({
        skill_set_id: "engineering",
        skill_set_revision_sha256: revisionSha256,
        envelope_sha256: envelopeSha256,
        byte_length: MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES,
      }),
    ).toEqual({
      skill_set_id: "engineering",
      skill_set_revision_sha256: revisionSha256,
      envelope_sha256: envelopeSha256,
      byte_length: MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES,
    });
    expect(
      Schema.decodeUnknownSync(HostedSkillSetPublishIntentReceipt)({
        publish_intent_id: "intent_123",
        upload_url: "https://upload.example/releases/intent_123",
        expires_at: Date.parse("2026-09-01T10:00:00.000Z"),
      }),
    ).toEqual({
      publish_intent_id: "intent_123",
      upload_url: "https://upload.example/releases/intent_123",
      expires_at: Date.parse("2026-09-01T10:00:00.000Z"),
    });
    expect(
      Schema.decodeUnknownSync(HostedSkillSetPublishUploadReceipt)({
        storageId: "storage_123",
      }),
    ).toEqual({ storageId: "storage_123" });
    expect(
      Schema.decodeUnknownSync(HostedSkillSetPublishFinalizeRequest)({
        publish_intent_id: "intent_123",
        storage_id: "storage_123",
      }),
    ).toEqual({ publish_intent_id: "intent_123", storage_id: "storage_123" });
    expect(
      Schema.decodeUnknownSync(HostedSkillSetReleaseReceipt)({
        release_id: "release_123",
        skill_set_id: "engineering",
        sequence: 1,
        skill_set_revision_sha256: revisionSha256,
        envelope_sha256: envelopeSha256,
        published_at: Date.parse("2026-08-31T10:00:00.000Z"),
        idempotent: false,
      }),
    ).toMatchObject({
      release_id: "release_123",
      skill_set_id: "engineering",
      sequence: 1,
      skill_set_revision_sha256: revisionSha256,
      envelope_sha256: envelopeSha256,
      idempotent: false,
    });

    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetPublishIntentRequest)({
        skill_set_id: "engineering",
        skill_set_revision_sha256: revisionSha256,
        envelope_sha256: envelopeSha256,
        byte_length: MAXIMUM_PORTABLE_SKILL_SET_ENVELOPE_BYTES + 1,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(HostedSkillSetReleaseReceipt)({
        release_id: "release_123",
        skill_set_id: "engineering",
        sequence: 0,
        skill_set_revision_sha256: "not-a-sha256",
        envelope_sha256: envelopeSha256,
        published_at: Date.now(),
        idempotent: false,
      }),
    ).toThrow();
  });
});
