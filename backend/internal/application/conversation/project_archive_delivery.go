package conversation

import (
	"archive/zip"
	"context"
	"fmt"
	"io"
	"path"
	"strings"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/objectstorage"
)

// archiveDeliveryLimits 同时约束压缩前后大小，不能信任项目行中记录的文件大小。
type archiveDeliveryLimits struct {
	files                           int
	fileBytes, totalBytes, zipBytes int64
}

type archiveDeliveryWriter struct {
	writer    io.Writer
	remaining int64
}

func (w *archiveDeliveryWriter) Write(p []byte) (int, error) {
	if int64(len(p)) > w.remaining {
		return 0, fmt.Errorf("project archive exceeds compressed size limit")
	}
	n, err := w.writer.Write(p)
	w.remaining -= int64(n)
	return n, err
}

func archiveDeliveryPath(raw string) (string, error) {
	name := strings.ReplaceAll(raw, "\\", "/")
	if name == "" || strings.HasPrefix(name, "/") || strings.ContainsAny(name, ":\x00\r\n") {
		return "", fmt.Errorf("invalid project archive path")
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." || part == "." || part == "" {
			return "", fmt.Errorf("invalid project archive path")
		}
	}
	return name, nil
}

func excludeArchiveDeliveryPath(name string) bool {
	for _, part := range strings.Split(strings.ToLower(name), "/") {
		switch part {
		case ".git", "node_modules", "vendor", ".venv", "venv", "__pycache__", ".cache", ".next", ".nuxt", ".turbo", "target", ".aws", ".ssh", ".npm", ".pnpm-store", "secrets", "credentials", "credentials.json", "id_rsa", "id_ed25519", ".netrc", ".npmrc", ".pypirc":
			return true
		}
		if strings.HasPrefix(part, ".env") || strings.HasSuffix(part, ".pem") || strings.HasSuffix(part, ".key") || strings.HasSuffix(part, ".p12") || strings.HasSuffix(part, ".pfx") {
			return true
		}
	}
	return false
}

// writeArchiveDelivery 只读取传入快照的不可变对象，不在下载时重新查询项目。
func writeArchiveDelivery(ctx context.Context, store objectstorage.Store, files []model.ProjectFile, writer io.Writer, limits archiveDeliveryLimits) (int, error) {
	archive := zip.NewWriter(&archiveDeliveryWriter{writer: writer, remaining: limits.zipBytes})
	seen := make(map[string]bool)
	count := 0
	var total int64
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return 0, err
		}
		if file.EntryType != model.ProjectFileEntryTypeFile {
			continue
		}
		name, err := archiveDeliveryPath(file.RelativePath)
		if err != nil {
			return 0, err
		}
		if excludeArchiveDeliveryPath(name) {
			continue
		}
		if seen[name] || count >= limits.files || file.SizeBytes > limits.fileBytes {
			return 0, fmt.Errorf("duplicate path or project archive limit exceeded")
		}
		seen[name] = true
		entry, err := archive.CreateHeader(&zip.FileHeader{Name: path.Clean(name), Method: zip.Deflate})
		if err != nil {
			return 0, err
		}
		reader, _, err := store.Open(ctx, file.StorageKey)
		if err != nil {
			return 0, err
		}
		remaining := min(limits.fileBytes, limits.totalBytes-total)
		n, copyErr := io.Copy(entry, io.LimitReader(reader, remaining+1))
		closeErr := reader.Close()
		if copyErr != nil {
			return 0, copyErr
		}
		if closeErr != nil {
			return 0, closeErr
		}
		if n > remaining {
			return 0, fmt.Errorf("project archive exceeds source size limit")
		}
		total += n
		count++
	}
	if err := archive.Close(); err != nil {
		return 0, err
	}
	return count, nil
}
