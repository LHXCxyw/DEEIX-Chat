import type {
  PatchPromptPresetRequest as ContractPatchPromptPresetRequest,
  WritePromptPresetRequest as ContractWritePromptPresetRequest,
  PromptPresetDataResponse,
  PromptPresetDeleteDataResponse,
  PromptPresetPageResponseDoc,
  PromptPresetResponse,
} from "@deeix/api-contract";

export type PromptPresetScope = "builtin" | "user";

export type PromptPresetDTO = Omit<PromptPresetResponse, "scope"> & {
  scope: PromptPresetScope;
};

type ContractPromptPresetPage = PromptPresetPageResponseDoc["data"];

export type PromptPresetPage = Omit<ContractPromptPresetPage, "results"> & {
  results: PromptPresetDTO[];
};

export type WritePromptPresetRequest = ContractWritePromptPresetRequest;

export type PatchPromptPresetRequest = ContractPatchPromptPresetRequest;

export type PromptPresetData = Omit<PromptPresetDataResponse, "promptPreset"> & {
  promptPreset: PromptPresetDTO;
};

export type PromptPresetDeleteData = PromptPresetDeleteDataResponse;
