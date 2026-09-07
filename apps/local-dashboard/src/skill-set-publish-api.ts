import type {
  ProjectConnectionId,
  ProjectSkillSetPublishInput,
  ProjectSkillSetPublishPreviewInput,
  ProjectSkillSetPublishPreviewModel,
  ProjectSkillSetReleaseReceiptModel,
} from "@selftune/dashboard-core/models";

import { portfolioRequest } from "./dashboard-http";

interface LocalSkillSetPublishPreviewResponse {
  skillSetId: string;
  name: string;
  description: string;
  harnesses: ProjectConnectionId[];
  skillSetRevisionSha256: string;
  envelopeSha256: string;
  byteLength: number;
  contents: ProjectSkillSetPublishPreviewModel["contents"];
  dependencies: ProjectSkillSetPublishPreviewModel["dependencies"];
  dependencyInput: ProjectSkillSetPublishPreviewModel["dependencyInput"];
  checks: ProjectSkillSetPublishPreviewModel["checks"];
  confirmation: ProjectSkillSetPublishPreviewModel["confirmation"];
}

interface LocalSkillSetReleaseResponse {
  release_id: string;
  skill_set_id: string;
  sequence: number;
  skill_set_revision_sha256: string;
  envelope_sha256: string;
  published_at: number;
  idempotent: boolean;
}

export async function previewProjectSkillSetPublish(
  input: ProjectSkillSetPublishPreviewInput,
): Promise<ProjectSkillSetPublishPreviewModel> {
  const response = await portfolioRequest<LocalSkillSetPublishPreviewResponse>(
    "/api/v2/skill-sets/publish/preview",
    JSON.stringify({ set_id: input.skillSetId, dependency_resolution: input.dependencyResolution }),
  );
  return {
    skillSetId: response.skillSetId,
    name: response.name,
    description: response.description,
    connections: response.harnesses,
    skillSetRevisionSha256: response.skillSetRevisionSha256,
    envelopeSha256: response.envelopeSha256,
    byteLength: response.byteLength,
    contents: response.contents,
    dependencies: response.dependencies,
    dependencyInput: response.dependencyInput,
    checks: response.checks,
    confirmation: response.confirmation,
  };
}

export async function publishProjectSkillSet(
  input: ProjectSkillSetPublishInput,
): Promise<ProjectSkillSetReleaseReceiptModel> {
  const response = await portfolioRequest<LocalSkillSetReleaseResponse>(
    "/api/v2/skill-sets/publish",
    JSON.stringify({
      set_id: input.skillSetId,
      expected_skill_set_revision_sha256: input.expectedSkillSetRevisionSha256,
      expected_envelope_sha256: input.expectedEnvelopeSha256,
      dependency_resolution: input.dependencyResolution,
      expected_dependency_lock: input.expectedDependencyLock,
      confirm_publish: input.confirmPublish,
    }),
  );
  return {
    releaseId: response.release_id,
    skillSetId: response.skill_set_id,
    sequence: response.sequence,
    skillSetRevisionSha256: response.skill_set_revision_sha256,
    envelopeSha256: response.envelope_sha256,
    publishedAt: new Date(response.published_at).toISOString(),
    idempotent: response.idempotent,
  };
}
