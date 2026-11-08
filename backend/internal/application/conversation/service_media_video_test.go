package conversation

import (
	"testing"
)

func TestValidateGeneratedVideoBytesRejectsUndetectedContent(t *testing.T) {
	if _, _, err := validateGeneratedVideoBytes([]byte("not a video"), "video/mp4"); err == nil {
		t.Fatal("expected declared video MIME to be insufficient without a supported video header")
	}
}

// 参考素材的类型必须由 MIME 推出 audio/video，否则音频、参考视频会落进 file，
// 在 readMediaVideoReferenceParts 里被判成"视频生成输入无效"。
func TestInferAttachmentKindSeparatesReferenceMedia(t *testing.T) {
	cases := map[string]string{
		"image/png":       "image",
		"video/mp4":       "video",
		"audio/mpeg":      "audio",
		"application/pdf": "file",
		"":                "file",
	}
	for mimeType, want := range cases {
		if got := inferAttachmentKind(mimeType); got != want {
			t.Fatalf("inferAttachmentKind(%q) = %q, want %q", mimeType, got, want)
		}
		if got := normalizeAttachmentKind(inferAttachmentKind(mimeType), mimeType); got != want {
			t.Fatalf("normalizeAttachmentKind(%q) = %q, want %q", mimeType, got, want)
		}
	}
}
