package conversation

import (
	"context"
	"errors"
	"testing"

	appprocessing "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/processing"
	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/infra/objectstorage"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
)

// failedFileProcessingRepository 让 WaitUntilReady 读到一个处理失败的文件。
type failedFileProcessingRepository struct {
	repository.FileProcessingStatusRepository
	file model.FileObject
}

func (r failedFileProcessingRepository) GetActiveFileObjectByID(context.Context, uint, string) (*model.FileObject, error) {
	file := r.file
	return &file, nil
}

// scannedPDF 是文本提取失败的本轮 PDF（扫描件、图片型 PDF）。
func scannedPDF() AttachmentInput {
	return AttachmentInput{
		FileID: "scan", FileName: "scan.pdf", Kind: "file", FileCategory: fileCategoryPDF, MimeType: "application/pdf",
		StoragePath: "files/scan", FileSize: int64(len("%PDF-1.7 scan")), Current: true, MessageRole: "user",
	}
}

func failedPDFService(t *testing.T) *Service {
	t.Helper()
	return &Service{
		storeProvider: &conversationTestStoreProvider{store: objectstorage.NewLocal(t.TempDir())},
		processingSvc: appprocessing.NewServiceWithRuntime(appprocessing.Dependencies{
			Repository: failedFileProcessingRepository{file: model.FileObject{
				FileID: "scan", FileCategory: fileCategoryPDF, ProcessingStatus: "failed",
				ProcessingErrorCode: "extract_empty", ProcessingErrorMessage: "PDF 未提取到可读文本。",
			}},
		}),
	}
}

// 只有支持原生 PDF 的路由才允许本轮提取失败的 PDF 继续发送；预算仍按单文件上限判断。
func TestNativeInputPolicyReadsWithoutExtraction(t *testing.T) {
	att := scannedPDF()
	att.ProcessingStatus = "failed"
	if !(nativeInputPolicy{PDF: true}).readsWithoutExtraction(att) {
		t.Fatal("支持原生 PDF 的路由应允许提取失败的 PDF")
	}
	if (nativeInputPolicy{}).readsWithoutExtraction(att) {
		t.Fatal("不支持原生 PDF 的路由不应放行")
	}
	oversized := att
	oversized.FileSize = maxNativePDFTotalBytes + 1
	if (nativeInputPolicy{PDF: true}).readsWithoutExtraction(oversized) {
		t.Fatal("超出单文件预算的 PDF 不应放行")
	}
	tooManyPages := att
	tooManyPages.PageCount = maxNativePDFTotalPages + 1
	if (nativeInputPolicy{PDF: true}).readsWithoutExtraction(tooManyPages) {
		t.Fatal("超出页数上限的 PDF 不应放行")
	}
	noPath := att
	noPath.StoragePath = " "
	if (nativeInputPolicy{PDF: true}).readsWithoutExtraction(noPath) {
		t.Fatal("没有存储路径的文件不应放行")
	}
}

// 提取失败的 PDF 可以进入原生候选；提取失败的音频仍被排除。
func TestIsNativeInputCandidateAllowsFailedPDFOnly(t *testing.T) {
	att := scannedPDF()
	att.ProcessingStatus = "failed"
	if !isNativeInputCandidate(att) {
		t.Fatal("提取失败的 PDF 应作为原生候选")
	}
	audio := att
	audio.FileCategory = fileCategoryAudio
	audio.MimeType = "audio/mpeg"
	if isNativeInputCandidate(audio) {
		t.Fatal("提取失败的音频不应作为原生候选")
	}
}

// 模型能直接阅读 PDF 时，本轮 PDF 提取失败不再拒绝发送；否则仍按「文件未准备完成」拒绝。
func TestHydrateAttachmentsForSendKeepsFailedPDFForNativeReaders(t *testing.T) {
	service := failedPDFService(t)

	items, err := service.hydrateAttachmentsForSend(t.Context(), 1, []AttachmentInput{scannedPDF()}, nativeInputPolicy{PDF: true}, nil)
	if err != nil {
		t.Fatalf("支持原生 PDF 的路由不应拒绝提取失败的 PDF: %v", err)
	}
	if len(items) != 1 || items[0].ProcessingStatus != "failed" || items[0].ProcessingErrorCode != "extract_empty" {
		t.Fatalf("应保留失败状态供后续规划: %#v", items)
	}

	if _, err = service.hydrateAttachmentsForSend(t.Context(), 1, []AttachmentInput{scannedPDF()}, nativeInputPolicy{}, nil); !errors.Is(err, ErrFileProcessingNotReady) {
		t.Fatalf("不支持原生 PDF 的路由仍应拒绝，实际: %v", err)
	}

	oversized := scannedPDF()
	oversized.FileSize = maxNativePDFTotalBytes + 1
	if _, err = service.hydrateAttachmentsForSend(t.Context(), 1, []AttachmentInput{oversized}, nativeInputPolicy{PDF: true}, nil); !errors.Is(err, ErrFileProcessingNotReady) {
		t.Fatalf("超出原生预算的 PDF 仍应拒绝，实际: %v", err)
	}
}
