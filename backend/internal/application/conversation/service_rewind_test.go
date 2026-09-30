package conversation

import (
	"testing"

	model "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/conversation"
)

func fileEntry(pathValue string, version int, storageKey string) model.ProjectFile {
	return model.ProjectFile{
		RelativePath: pathValue, EntryType: model.ProjectFileEntryTypeFile,
		Version: version, StorageKey: storageKey, SizeBytes: 100,
	}
}

// 回退计划必须覆盖四类基础动作：恢复内容、重建已删除文件、删除回退点后新建的文件、
// 内容一致时不产生动作。
func TestComputeRewindFileActions(t *testing.T) {
	target := map[string]model.ProjectFileSnapshot{
		"a.txt": {Version: 1, StorageKey: "key-a-old", SizeBytes: 10},
		"b.txt": {Version: 0, StorageKey: "", SizeBytes: 0},
		"c.txt": {Version: 2, StorageKey: "key-c-old", SizeBytes: 20},
		"d.txt": {Version: 3, StorageKey: "key-d-old", SizeBytes: 30},
	}
	changedAfter := map[string]struct{}{
		"b.txt": {}, "e.txt": {},
	}
	liveFiles := []model.ProjectFile{
		fileEntry("a.txt", 2, "key-a-new"),
		fileEntry("b.txt", 1, "key-b-new"),
		fileEntry("c.txt", 2, "key-c-old"),
		fileEntry("e.txt", 1, "key-e-new"),
		// 无日志痕迹的存量文件必须保持原样。
		fileEntry("legacy.txt", 1, "key-legacy"),
	}

	actions, restoreTargets, deleteTargets, _ := computeRewindFileActions(target, changedAfter, liveFiles)

	byPath := map[string]ConversationRewindPreviewItem{}
	for _, item := range actions {
		byPath[item.RelativePath] = item
	}
	if len(byPath) != 4 {
		t.Fatalf("expected 4 actions, got %d: %+v", len(actions), actions)
	}
	if item := byPath["a.txt"]; item.Action != RewindFileActionRestore || item.TargetVersion != 3 {
		t.Fatalf("a.txt should restore with version bump, got %+v", item)
	}
	if item := byPath["b.txt"]; item.Action != RewindFileActionDelete || item.CurrentVersion != 1 {
		t.Fatalf("b.txt should delete live file, got %+v", item)
	}
	if item := byPath["e.txt"]; item.Action != RewindFileActionDelete {
		t.Fatalf("e.txt created after rewind point should delete, got %+v", item)
	}
	if item := byPath["d.txt"]; item.Action != RewindFileActionCreate || item.TargetVersion != 4 {
		t.Fatalf("d.txt should be recreated, got %+v", item)
	}
	if _, ok := byPath["c.txt"]; ok {
		t.Fatalf("c.txt content matches target; no action expected")
	}
	if _, ok := byPath["legacy.txt"]; ok {
		t.Fatalf("legacy file without change log must be untouched")
	}
	if restoreTargets["a.txt"].StorageKey != "key-a-old" {
		t.Fatalf("restore target snapshot mismatch")
	}
	if _, ok := deleteTargets["b.txt"]; !ok {
		t.Fatalf("delete target should track live file row")
	}
	if _, ok := deleteTargets["e.txt"]; !ok {
		t.Fatalf("delete target should track newly created live file")
	}
}

// 目录节点不参与回退计算。
func TestComputeRewindFileActionsSkipsDirectories(t *testing.T) {
	liveFiles := []model.ProjectFile{
		{RelativePath: "docs", EntryType: model.ProjectFileEntryTypeDirectory},
	}
	actions, _, _, _ := computeRewindFileActions(map[string]model.ProjectFileSnapshot{}, map[string]struct{}{}, liveFiles)
	if len(actions) != 0 {
		t.Fatalf("directories must not produce actions: %+v", actions)
	}
}
