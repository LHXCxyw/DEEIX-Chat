package llm

import (
	"strings"

	portllm "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/llm"
)

// collectImageInputParts 收集消息中可发送给图片编辑类协议的原始图片输入。
// 图片可以是内联字节（base64 传输）或 URL（上游自行拉取），二者至少有其一。
func collectImageInputParts(messages []portllm.Message) []portllm.ContentPart {
	images := make([]portllm.ContentPart, 0)
	for _, msg := range messages {
		for _, part := range msg.Parts {
			if part.Kind != portllm.ContentPartImage || (len(part.Data) == 0 && strings.TrimSpace(part.URL) == "") {
				continue
			}
			images = append(images, part)
		}
	}
	return images
}
