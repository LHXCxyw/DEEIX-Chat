package agentoperation

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"time"
)

type Status string

const (
	Pending   Status = "pending"
	Running   Status = "running"
	Succeeded Status = "succeeded"
	Failed    Status = "failed"
	Uncertain Status = "uncertain"
	Cancelled Status = "cancelled"
)

type Kind string

const (
	ReadFile      Kind = "read_file"
	ListDirectory Kind = "list_directory"
	WriteFile     Kind = "write_file"
	Command       Kind = "command"
)

var (
	ErrInvalid    = errors.New("操作参数无效")
	ErrTransition = errors.New("不允许的操作状态转换")
	ErrApproval   = errors.New("审批无效、过期或绑定不匹配")
)

const MaxApprovalLifetime = 24 * time.Hour

// Spec 是创建后不可变的操作身份和授权边界；不持久化原始参数。
type Spec struct {
	OwnerUserID              uint
	OperationID              string
	RunID                    string
	WorkspaceID              uint
	Kind                     Kind
	ParametersHash           string
	ExpectedWorkspaceVersion string
	PermissionScope          string
}

type Binding struct {
	ParametersHash   string
	WorkspaceVersion string
	PermissionScope  string
}

type Approval struct {
	Binding
	GrantedAt time.Time
	ExpiresAt time.Time
}

type Operation struct {
	Spec
	Status        Status
	LeaseOwner    string
	LeaseExpiresAt *time.Time
	Revision      uint64
	Approval      *Approval
	ResultSummary string
	CreatedAt     time.Time
	UpdatedAt     time.Time
}

func (s Spec) Validate() error {
	if s.OwnerUserID == 0 || s.WorkspaceID == 0 || strings.TrimSpace(s.OperationID) == "" || len(s.OperationID) > 128 || strings.TrimSpace(s.RunID) == "" || len(s.RunID) > 64 || strings.TrimSpace(s.ExpectedWorkspaceVersion) == "" || len(s.ExpectedWorkspaceVersion) > 128 || strings.TrimSpace(s.PermissionScope) == "" || len(s.PermissionScope) > 256 {
		return ErrInvalid
	}
	switch s.Kind {
	case ReadFile, ListDirectory, WriteFile, Command:
	default:
		return ErrInvalid
	}
	hash, err := hex.DecodeString(s.ParametersHash)
	if err != nil || len(hash) != sha256.Size || s.ParametersHash != strings.ToLower(s.ParametersHash) {
		return ErrInvalid
	}
	return nil
}

func (s Spec) Binding() Binding {
	return Binding{ParametersHash: s.ParametersHash, WorkspaceVersion: s.ExpectedWorkspaceVersion, PermissionScope: s.PermissionScope}
}

func (a Approval) Validate(s Spec, now time.Time) error {
	if a.Binding != s.Binding() || a.GrantedAt.IsZero() || a.GrantedAt.After(now) || !a.ExpiresAt.After(now) || !a.ExpiresAt.After(a.GrantedAt) || a.ExpiresAt.Sub(a.GrantedAt) > MaxApprovalLifetime {
		return ErrApproval
	}
	return nil
}

// CanTransition 不提供通用的“可重试”标记，只有列举的安全读取类型可从不确定状态恢复。
func CanTransition(kind Kind, from, to Status) bool {
	switch from {
	case Pending:
		return to == Running || to == Cancelled
	case Running:
		return to == Succeeded || to == Failed || to == Uncertain
	case Uncertain:
		return to == Running && (kind == ReadFile || kind == ListDirectory)
	default:
		return false
	}
}

// ParametersHash 对 JSON 对象键排序并消除空白，保留数字原文以避免精度丢失。
// 重复对象键和尾随 JSON 被拒绝，防止不同解释器对审批参数产生歧义。
func ParametersHash(raw []byte) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	value, err := decodeValue(dec)
	if err != nil {
		return "", ErrInvalid
	}
	if _, err = dec.Token(); err != io.EOF {
		return "", ErrInvalid
	}
	canonical, err := json.Marshal(value)
	if err != nil {
		return "", ErrInvalid
	}
	sum := sha256.Sum256(canonical)
	return hex.EncodeToString(sum[:]), nil
}

func decodeValue(dec *json.Decoder) (any, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return tok, nil
	}
	switch delim {
	case '{':
		result := map[string]any{}
		for dec.More() {
			keyToken, err := dec.Token()
			if err != nil {
				return nil, err
			}
			key, ok := keyToken.(string)
			if !ok {
				return nil, ErrInvalid
			}
			if _, exists := result[key]; exists {
				return nil, ErrInvalid
			}
			value, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			result[key] = value
		}
		end, err := dec.Token()
		if err != nil || end != json.Delim('}') {
			return nil, ErrInvalid
		}
		return result, nil
	case '[':
		result := []any{}
		for dec.More() {
			value, err := decodeValue(dec)
			if err != nil {
				return nil, err
			}
			result = append(result, value)
		}
		end, err := dec.Token()
		if err != nil || end != json.Delim(']') {
			return nil, ErrInvalid
		}
		return result, nil
	default:
		return nil, ErrInvalid
	}
}
