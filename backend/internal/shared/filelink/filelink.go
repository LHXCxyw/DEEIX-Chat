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
	"strconv"
	"time"
)

// SignatureTTL 是签名链接的有效期：覆盖视频任务提交与轮询期间上游回源拉图的窗口。
const SignatureTTL = time.Hour

const (
	signaturePurpose          = "file-content"
	thumbnailSignaturePurpose = "file-thumbnail"
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

func trimTrailingSlash(value string) string {
	for len(value) > 0 && value[len(value)-1] == '/' {
		value = value[:len(value)-1]
	}
	return value
}
