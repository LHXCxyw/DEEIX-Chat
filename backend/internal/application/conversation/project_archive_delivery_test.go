package conversation

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/ports/objectstorage"
)

type archiveDeliveryStore struct {
	objectstorage.Store
	data   map[string]string
	opened []string
}

func (s *archiveDeliveryStore) Open(_ context.Context, key string) (io.ReadCloser, objectstorage.ObjectInfo, error) {
	s.opened = append(s.opened, key)
	value, ok := s.data[key]
	if !ok {
		return nil, objectstorage.ObjectInfo{}, errors.New("对象不存在")
	}
	return io.NopCloser(bytes.NewBufferString(value)), objectstorage.ObjectInfo{}, nil
}

func archiveDeliveryTestLimits() archiveDeliveryLimits {
	return archiveDeliveryLimits{files: 10, fileBytes: 100, totalBytes: 200, zipBytes: 4096}
}

func TestArchiveDeliverySnapshotAndExclusions(t *testing.T) {
	store := &archiveDeliveryStore{data: map[string]string{"version-1": "old bytes"}}
	files := []model.ProjectFile{{RelativePath: "src/main.go", EntryType: "file", StorageKey: "version-1"}}
	for _, name := range []string{".env", "nested/.env.production", ".git/config", "node_modules/a.js", ".venv/lib.py", "secrets/key.txt", "private.pem", ".npmrc", "vendor/lib.go"} {
		files = append(files, model.ProjectFile{RelativePath: name, EntryType: "file", StorageKey: "missing-secret"})
	}
	var result bytes.Buffer
	count, err := writeArchiveDelivery(context.Background(), store, files, &result, archiveDeliveryTestLimits())
	if err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	store.data["version-1"] = "new bytes"
	archive, err := zip.NewReader(bytes.NewReader(result.Bytes()), int64(result.Len()))
	if err != nil {
		t.Fatal(err)
	}
	if len(archive.File) != 1 || archive.File[0].Name != "src/main.go" {
		t.Fatalf("错误归档内容: %v", archive.File)
	}
	reader, err := archive.File[0].Open()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	data, err := io.ReadAll(reader)
	if err != nil || string(data) != "old bytes" {
		t.Fatalf("快照发生变化: %q %v", data, err)
	}
	if len(store.opened) != 1 {
		t.Fatalf("读取了排除文件: %v", store.opened)
	}
}

func TestArchiveDeliveryRejectsUnsafePaths(t *testing.T) {
	for _, name := range []string{"../x", "a/../../x", "/absolute", "C:\\secret", "a\\..\\secret", "..", "a\x00b", "a//b", "a/./b"} {
		t.Run(name, func(t *testing.T) {
			store := &archiveDeliveryStore{}
			var out bytes.Buffer
			_, err := writeArchiveDelivery(context.Background(), store, []model.ProjectFile{{EntryType: "file", RelativePath: name}}, &out, archiveDeliveryTestLimits())
			if err == nil || len(store.opened) != 0 {
				t.Fatalf("未拒绝非法路径: %v", err)
			}
		})
	}
}

func TestArchiveDeliveryLimitsAndFailures(t *testing.T) {
	for _, scenario := range []string{"file", "total", "zip", "count", "duplicate", "missing", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			limits := archiveDeliveryTestLimits()
			store := &archiveDeliveryStore{data: map[string]string{"key": "1234567890"}}
			files := []model.ProjectFile{{EntryType: "file", RelativePath: "a", StorageKey: "key"}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch scenario {
			case "file":
				limits.fileBytes = 5
			case "total":
				limits.totalBytes = 5
			case "zip":
				limits.zipBytes = 10
			case "count":
				limits.files = 0
			case "duplicate":
				files = append(files, files[0])
			case "missing":
				files[0].StorageKey = "missing"
			case "cancelled":
				cancel()
			}
			var out bytes.Buffer
			if _, err := writeArchiveDelivery(ctx, store, files, &out, limits); err == nil {
				t.Fatal("应返回真实失败")
			}
		})
	}
}
