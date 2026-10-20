import assert from "node:assert/strict";
import test from "node:test";
import type { ChatModelOption, ModelModality, PendingAttachment } from "../types/chat-runtime.ts";
import { resolveChatSubmitDecision } from "./chat-task.ts";

function model(overrides: Partial<ChatModelOption> = {}): ChatModelOption {
  return {
    platformModelName: "test-model",
    icon: "",
    vendor: "",
    vendorName: "",
    vendorIcon: "",
    displayGroupID: null,
    displayGroupName: "",
    displayGroupIcon: "",
    personalProviderName: null,
    personalProviderIcon: "",
    kinds: ["chat"],
    protocols: ["openai_responses"],
    defaultOptions: {},
    optionControls: [],
    lockedOptionPaths: [],
    nativeToolKeys: [],
    nativeTools: [],
    pricing: null,
    videoExtension: null,
    reasoning: null,
    controls: [],
    inputModalities: [],
    outputModalities: [],
    contextWindow: null,
    ...overrides,
  };
}

function attachment(mimeType: string): PendingAttachment {
  return { fileID: `file-${mimeType}`, fileName: "附件", mimeType, sizeBytes: 32 };
}

for (const inputModalities of [[], ["text"], ["text", "image", "pdf", "audio", "video"]] satisfies ModelModality[][]) {
  for (const mimeType of ["image/png", "application/pdf", "audio/wav", "video/mp4"]) {
    test(`输入声明 ${JSON.stringify(inputModalities)} 不拦截聊天附件 ${mimeType}`, () => {
      const attachments = [attachment(mimeType)];
      const original = structuredClone(attachments);
      const decision = resolveChatSubmitDecision(model({ inputModalities }), attachments);
      assert.equal(decision.task, "chat");
      assert.equal(decision.blockedReason, null);
      assert.equal(decision.attachmentCount, 1);
      assert.deepEqual(attachments, original);
    });
  }
}

test("混合多模态附件不因仅文本声明而过滤或拦截", () => {
  const attachments = ["image/png", "application/pdf", "audio/wav", "video/mp4"].map(attachment);
  const original = structuredClone(attachments);
  const decision = resolveChatSubmitDecision(model({ inputModalities: ["text"] }), attachments);
  assert.equal(decision.task, "chat");
  assert.equal(decision.blockedReason, null);
  assert.equal(decision.attachmentCount, 4);
  assert.deepEqual(attachments, original);
});

test("图像编辑任务不会因缺少图片输入声明而拦截", () => {
  const decision = resolveChatSubmitDecision(model({
    kinds: ["image_gen", "image_edit"],
    protocols: ["openai_image_generations", "openai_image_edits"],
    inputModalities: ["text"],
  }), [attachment("image/png")]);
  assert.equal(decision.task, "image_edit");
  assert.equal(decision.blockedReason, null);
});

test("缺少编辑任务配置时不擅自将参考图降级为文生图", () => {
  const decision = resolveChatSubmitDecision(model({
    kinds: ["image_gen"],
    protocols: ["openai_image_generations"],
    inputModalities: ["text", "image"],
  }), [attachment("image/png")]);
  assert.equal(decision.blockedReason, "image_edit_unsupported");
  assert.notEqual(decision.task, "image_generation");
});

test("图像编辑仍要求参考图并保留协议实际输入限制", () => {
  const selected = model({ kinds: ["image_edit"], protocols: ["openai_image_edits"] });
  assert.equal(resolveChatSubmitDecision(selected, []).blockedReason, "image_edit_input_required");
  assert.equal(resolveChatSubmitDecision(selected, [attachment("image/png"), attachment("application/pdf")]).blockedReason,
    "image_task_rejects_non_image_attachments");
});

test("视频参考限制来自协议而非输入模态声明", () => {
  const attachments = [attachment("audio/wav"), attachment("video/mp4"), attachment("image/png")];
  const selected = model({ kinds: ["video_gen"], protocols: ["openai_video_generations"], inputModalities: [] });
  assert.equal(resolveChatSubmitDecision(selected, attachments).blockedReason, null);
  assert.equal(resolveChatSubmitDecision(selected, attachments).task, "video_generation");
  assert.equal(resolveChatSubmitDecision({ ...selected, protocols: ["xai_video_generations"] }, attachments).blockedReason,
    "video_generation_too_many_references");
});
