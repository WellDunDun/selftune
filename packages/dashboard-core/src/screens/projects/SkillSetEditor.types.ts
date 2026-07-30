import type {
  ProjectCaptureCandidateModel,
  ProjectHarnessModel,
  ProjectSkillOptionModel,
  ProjectSkillSetDeriveInput,
  ProjectSkillSetInput,
  ProjectSkillSetModel,
} from "../../models";
import type { SkillSetEditorMode } from "./skill-set-constants";

export type SkillSetEditorProps = {
  mode: SkillSetEditorMode;
  open: boolean;
  availableSkills: ProjectSkillOptionModel[];
  initialValue: ProjectSkillSetModel | null;
  draftValue: ProjectSkillSetInput | null;
  captureCandidates: ProjectCaptureCandidateModel[];
  connectedHarnesses?: ProjectHarnessModel[];
  canCreate: boolean;
  canCapture: boolean;
  isPending: boolean;
  onOpenChange(open: boolean): void;
  onModeChange(mode: "create" | "derive"): void;
  onSubmit(value: ProjectSkillSetInput | ProjectSkillSetDeriveInput): void;
};
