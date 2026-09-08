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

const signaturePurpose = "file-content"

var ErrInvalidSignature = errors.New("filelink: invalid signature")

// Sign 计算文件内容签名（HMAC-SHA256 hex）。
func Sign(secret string, userID uint, fileID string, expiresAt int64) string {
	mac := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(mac, "%s:%d:%s:%d", signaturePurpose, userID, fileID, expiresAt)
	return hex.EncodeToString(mac.Sum(nil))
}

// BuildContentURL 构建文件内容的签名访问 URL；publicAPIBaseURL 未配置时返回空串，
// 调用方应回退为内联传输文件字节。
func BuildContentURL(publicAPIBaseURL, secret string, userID uint, fileID string, now time.Time) string {
	base := trimTrailingSlash(publicAPIBaseURL)
	if base == "" || secret == "" || fileID == "" {
		return ""
	}
	expiresAt := now.Add(SignatureTTL).Unix()
	query := url.Values{}
	query.Set("user_id", strconv.FormatUint(uint64(userID), 10))
	query.Set("expires", strconv.FormatInt(expiresAt, 10))
	query.Set("signature", Sign(secret, userID, fileID, expiresAt))
	return base + "/api/v1/files/" + url.PathEscape(fileID) + "/signed-content?" + query.Encode()
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

func trimTrailingSlash(value string) string {
	for len(value) > 0 && value[len(value)-1] == '/' {
		value = value[:len(value)-1]
	}
	return value
}
