// Package filelink 生成与校验文件内容的限时签名访问链接，
// 供无登录态的上游服务（如视频生成网关）按 URL 回源拉取文件。
package filelink

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// SignatureTTL 是签名链接的有效期：覆盖视频任务提交与轮询期间上游回源拉图的窗口。
const SignatureTTL = time.Hour

const (
	signaturePurpose          = "file-content"
	thumbnailSignaturePurpose = "file-thumbnail"
	workspaceSignaturePurpose = "workspace-download"
)

const (
	// WorkspaceDownloadModeFile 表示单文件下载。
	WorkspaceDownloadModeFile = "file"
	// WorkspaceDownloadModeArchive 表示目录/多文件 ZIP 下载。
	WorkspaceDownloadModeArchive = "archive"
)

var ErrInvalidSignature = errors.New("filelink: invalid signature")

// Sign 计算文件内容签名（HMAC-SHA256 hex）。
func Sign(secret string, userID uint, fileID string, expiresAt int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%s:%d:%s:%d", signaturePurpose, userID, fileID, expiresAt)
	return hex.EncodeToString(mac.Sum(nil))
}

// SignThumbnail 计算缩略图变体签名，签名材料额外绑定变体名，
// 防止持 thumb 档签名者拼出 preview 档链接。
func SignThumbnail(secret string, userID uint, fileID string, variant string, expiresAt int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%s:%d:%s:%s:%d", thumbnailSignaturePurpose, userID, fileID, variant, expiresAt)
	return hex.EncodeToString(mac.Sum(nil))
}

// alignedExpiry 将过期时间向上取整到小时边界：同一自然小时内同一文件签出的 URL
// 逐字节相同，浏览器缓存跨页面导航命中，CDN 缓存键稳定；实际有效期介于 TTL 与 TTL+1h。
func alignedExpiry(now time.Time) int64 {
	horizon := now.Add(SignatureTTL)
	truncated := horizon.Truncate(time.Hour)
	if !truncated.Equal(horizon) {
		truncated = truncated.Add(time.Hour)
	}
	return truncated.Unix()
}

// BuildContentURL 构建文件内容的签名访问 URL；publicAPIBaseURL 未配置时返回空串，
// 调用方应回退为内联传输文件字节。
func BuildContentURL(publicAPIBaseURL, secret string, userID uint, fileID string, now time.Time) string {
	base := trimTrailingSlash(publicAPIBaseURL)
	if base == "" || secret == "" || fileID == "" {
		return ""
	}
	expiresAt := alignedExpiry(now)
	query := url.Values{}
	query.Set("user_id", strconv.FormatUint(uint64(userID), 10))
	query.Set("expires", strconv.FormatInt(expiresAt, 10))
	query.Set("signature", Sign(secret, userID, fileID, expiresAt))
	return base + "/api/v1/files/" + url.PathEscape(fileID) + "/signed-content?" + query.Encode()
}

// BuildSignedContentPath 构建文件内容签名访问的相对路径（无 origin），
// 供前端按自身 API base 拼接后作为 <img>/<video> 直连地址；secret 未配置时返回空串。
func BuildSignedContentPath(secret string, userID uint, fileID string, now time.Time) string {
	if secret == "" || fileID == "" {
		return ""
	}
	expiresAt := alignedExpiry(now)
	query := url.Values{}
	query.Set("user_id", strconv.FormatUint(uint64(userID), 10))
	query.Set("expires", strconv.FormatInt(expiresAt, 10))
	query.Set("signature", Sign(secret, userID, fileID, expiresAt))
	return "/api/v1/files/" + url.PathEscape(fileID) + "/signed-content?" + query.Encode()
}

// BuildSignedThumbnailPath 构建缩略图变体签名访问的相对路径；variant 为空时默认 thumb 档。
func BuildSignedThumbnailPath(secret string, userID uint, fileID string, variant string, now time.Time) string {
	if secret == "" || fileID == "" {
		return ""
	}
	if variant == "" {
		variant = "thumb"
	}
	expiresAt := alignedExpiry(now)
	query := url.Values{}
	query.Set("variant", variant)
	query.Set("user_id", strconv.FormatUint(uint64(userID), 10))
	query.Set("expires", strconv.FormatInt(expiresAt, 10))
	query.Set("signature", SignThumbnail(secret, userID, fileID, variant, expiresAt))
	return "/api/v1/files/" + url.PathEscape(fileID) + "/signed-thumbnail?" + query.Encode()
}

// Verify 校验签名链接并返回其授权的用户 ID。
func Verify(secret, userIDStr, fileID, expiresStr, signature string, now time.Time) (uint, error) {
	if secret == "" || userIDStr == "" || fileID == "" || expiresStr == "" || signature == "" {
		return 0, ErrInvalidSignature
	}
	userID, err := strconv.ParseUint(userIDStr, 10, 64)
	if err != nil {
		return 0, ErrInvalidSignature
	}
	expiresAt, err := strconv.ParseInt(expiresStr, 10, 64)
	if err != nil || expiresAt < now.Unix() {
		return 0, ErrInvalidSignature
	}
	expected := Sign(secret, uint(userID), fileID, expiresAt)
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return 0, ErrInvalidSignature
	}
	return uint(userID), nil
}

// VerifyThumbnail 校验缩略图变体签名并返回其授权的用户 ID。
func VerifyThumbnail(secret, userIDStr, fileID, variant, expiresStr, signature string, now time.Time) (uint, error) {
	if variant == "" {
		variant = "thumb"
	}
	if secret == "" || userIDStr == "" || fileID == "" || expiresStr == "" || signature == "" {
		return 0, ErrInvalidSignature
	}
	userID, err := strconv.ParseUint(userIDStr, 10, 64)
	if err != nil {
		return 0, ErrInvalidSignature
	}
	expiresAt, err := strconv.ParseInt(expiresStr, 10, 64)
	if err != nil || expiresAt < now.Unix() {
		return 0, ErrInvalidSignature
	}
	expected := SignThumbnail(secret, uint(userID), fileID, variant, expiresAt)
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return 0, ErrInvalidSignature
	}
	return uint(userID), nil
}

// canonicalWorkspaceTargets 归一化并排序下载目标：反斜杠转正斜杠、去重、去空。
// 排序保证同一组目标拼出的签名材料与查询参数顺序稳定；空目标表示整个工作区目录。
func canonicalWorkspaceTargets(targets []string) []string {
	if len(targets) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(targets))
	normalized := make([]string, 0, len(targets))
	for _, target := range targets {
		value := strings.TrimSpace(strings.ReplaceAll(target, "\\", "/"))
		if value == "" || value == "." {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		normalized = append(normalized, value)
	}
	sort.Strings(normalized)
	return normalized
}

func workspaceTargetsMaterial(targets []string) string {
	return strings.Join(canonicalWorkspaceTargets(targets), "\n")
}

// NormalizeWorkspaceMode 归一化下载模式：显式 file/archive 原样返回，
// 其余按目标数量推断——单个目标走单文件，其余（含空目标=整个工作区）走 ZIP 打包。
func NormalizeWorkspaceMode(mode string, targets []string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case WorkspaceDownloadModeFile:
		return WorkspaceDownloadModeFile
	case WorkspaceDownloadModeArchive:
		return WorkspaceDownloadModeArchive
	default:
		if len(canonicalWorkspaceTargets(targets)) == 1 {
			return WorkspaceDownloadModeFile
		}
		return WorkspaceDownloadModeArchive
	}
}

// SignWorkspace 计算会话工作区下载签名（HMAC-SHA256 hex）。
// 签名材料绑定用户、会话公开 ID、下载模式、排序后的目标路径与过期时间，
// 换会话、换模式或换路径都无法复用。
func SignWorkspace(secret string, userID uint, conversationPublicID string, mode string, targets []string, expiresAt int64) string {
	canonical := canonicalWorkspaceTargets(targets)
	normalizedMode := NormalizeWorkspaceMode(mode, canonical)
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%s:%d:%s:%s:%s:%d", workspaceSignaturePurpose, userID, strings.TrimSpace(conversationPublicID), normalizedMode, workspaceTargetsMaterial(canonical), expiresAt)
	return hex.EncodeToString(mac.Sum(nil))
}

// BuildSignedWorkspaceDownloadPath 构建会话工作区下载的相对签名路径（无 origin）。
// targets 为空表示整个工作区目录；secret 未配置时返回空串。
func BuildSignedWorkspaceDownloadPath(secret string, userID uint, conversationPublicID string, mode string, targets []string, now time.Time) string {
	if secret == "" || strings.TrimSpace(conversationPublicID) == "" {
		return ""
	}
	canonical := canonicalWorkspaceTargets(targets)
	normalizedMode := NormalizeWorkspaceMode(mode, canonical)
	expiresAt := alignedExpiry(now)
	query := url.Values{}
	query.Set("mode", normalizedMode)
	query.Set("user_id", strconv.FormatUint(uint64(userID), 10))
	query.Set("conversation_id", strings.TrimSpace(conversationPublicID))
	for _, target := range canonical {
		query.Add("path", target)
	}
	query.Set("expires", strconv.FormatInt(expiresAt, 10))
	query.Set("signature", SignWorkspace(secret, userID, conversationPublicID, normalizedMode, canonical, expiresAt))
	return "/api/v1/workspace-downloads/signed?" + query.Encode()
}

// BuildWorkspaceDownloadURL 构建带 origin 的会话工作区下载链接，供 agent 回复文本直接复制；
// publicAPIBaseURL 未配置时返回空串，调用方应回退到相对路径。
func BuildWorkspaceDownloadURL(publicAPIBaseURL, secret string, userID uint, conversationPublicID string, mode string, targets []string, now time.Time) string {
	base := trimTrailingSlash(publicAPIBaseURL)
	if base == "" {
		return ""
	}
	path := BuildSignedWorkspaceDownloadPath(secret, userID, conversationPublicID, mode, targets, now)
	if path == "" {
		return ""
	}
	return base + path
}

// VerifyWorkspace 校验会话工作区下载签名并返回其授权的用户 ID。
func VerifyWorkspace(secret, userIDStr, conversationPublicID, mode string, targets []string, expiresStr, signature string, now time.Time) (uint, error) {
	if secret == "" || userIDStr == "" || strings.TrimSpace(conversationPublicID) == "" || expiresStr == "" || signature == "" {
		return 0, ErrInvalidSignature
	}
	userID, err := strconv.ParseUint(userIDStr, 10, 64)
	if err != nil {
		return 0, ErrInvalidSignature
	}
	expiresAt, err := strconv.ParseInt(expiresStr, 10, 64)
	if err != nil || expiresAt < now.Unix() {
		return 0, ErrInvalidSignature
	}
	expected := SignWorkspace(secret, uint(userID), conversationPublicID, mode, targets, expiresAt)
	if !hmac.Equal([]byte(expected), []byte(signature)) {
		return 0, ErrInvalidSignature
	}
	return uint(userID), nil
}

func trimTrailingSlash(value string) string {
	for len(value) > 0 && value[len(value)-1] == '/' {
		value = value[:len(value)-1]
	}
	return value
}
