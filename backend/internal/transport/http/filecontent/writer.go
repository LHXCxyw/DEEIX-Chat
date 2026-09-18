package filecontent

import (
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	"github.com/gin-gonic/gin"
)

// Write 将已授权的文件内容以统一的安全响应头写入 HTTP 响应。
// reader 可 seek 时经由 http.ServeContent 输出，自动获得 If-None-Match/304
// 与 Range/206 能力；否则退化为全量拷贝（仅保留手工 ETag/304）。
func Write(c *gin.Context, result *appupload.FileContentResult, public bool) error {
	defer result.Reader.Close() //nolint:errcheck

	contentType := safeContentType(result.ContentType)
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", buildContentDisposition(result.File.FileName, isPassiveInlineContentType(contentType)))
	writeCacheHeaders(c, result.File.Purpose, public)
	applySecurityHeaders(c, public)
	etag := ETag(result.File.SHA256)
	if etag != "" {
		c.Header("ETag", etag)
	}

	if seeker, ok := result.Reader.(io.ReadSeeker); ok {
		// ServeContent 依据预设 Content-Type 输出，并自行处理条件请求与分段读取。
		http.ServeContent(c.Writer, c.Request, "", result.ModTime, seeker)
		return nil
	}

	if !result.ModTime.IsZero() {
		c.Header("Last-Modified", result.ModTime.UTC().Format(http.TimeFormat))
	}
	if notModified(c.Request.Header.Get("If-None-Match"), etag) {
		c.Status(http.StatusNotModified)
		return nil
	}
	if result.SizeBytes > 0 {
		c.Header("Content-Length", strconv.FormatInt(result.SizeBytes, 10))
	}
	if _, err := io.Copy(c.Writer, result.Reader); err != nil {
		c.Abort()
		return err
	}
	return nil
}

// WriteNotModified 在未读取存储内容的情况下响应 304 重验证，
// 缓存头与安全头必须与 200 响应保持一致，避免缓存条目策略漂移。
func WriteNotModified(c *gin.Context, purpose string, public bool, etag string) {
	if etag != "" {
		c.Header("ETag", etag)
	}
	writeCacheHeaders(c, purpose, public)
	applySecurityHeaders(c, public)
	c.Status(http.StatusNotModified)
}

// ETag 由文件 SHA256 构造强 ETag；SHA256 缺失时返回空串（无条件请求能力）。
func ETag(sha256 string) string {
	normalized := strings.ToLower(strings.TrimSpace(sha256))
	if normalized == "" {
		return ""
	}
	return `"` + normalized + `"`
}

// RequestNotModified 判断请求的 If-None-Match 是否命中给定 SHA256 对应的 ETag。
func RequestNotModified(c *gin.Context, sha256 string) bool {
	etag := ETag(sha256)
	return etag != "" && notModified(c.GetHeader("If-None-Match"), etag)
}

func notModified(ifNoneMatch, etag string) bool {
	if ifNoneMatch == "" || etag == "" {
		return false
	}
	for _, part := range strings.Split(ifNoneMatch, ",") {
		part = strings.TrimSpace(part)
		if part == etag || part == "W/"+etag || part == "*" {
			return true
		}
	}
	return false
}

func writeCacheHeaders(c *gin.Context, purpose string, public bool) {
	// 生成产物内容不可变（每次生成/重查都产生新 fileID），可长缓存
	if immutableGeneratedArtifact(purpose) {
		if public {
			c.Header("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			c.Header("Cache-Control", "private, max-age=31536000, immutable")
		}
		return
	}
	// 上传原件同样不可变；max-age 与 access token TTL 对齐，token 轮换后经 ETag 重验证
	if public {
		c.Header("Cache-Control", "public, max-age=86400")
	} else {
		c.Header("Cache-Control", "private, max-age=86400")
	}
	if !public {
		// 授权响应按凭证区分缓存条目，避免同浏览器多账号串缓存
		c.Header("Vary", "Authorization")
	}
}

// immutableGeneratedArtifact 判断文件是否为生成产物或派生变体：这类内容一经写入永不修改
// （后续生成/重查都会产生新的 fileID，变体由不可变原件确定性派生），因此可以放心长缓存。
func immutableGeneratedArtifact(purpose string) bool {
	switch strings.TrimSpace(purpose) {
	case "generated_image", "generated_video", "thumbnail":
		return true
	default:
		return false
	}
}

func buildContentDisposition(fileName string, inline bool) string {
	normalizedName := strings.TrimSpace(fileName)
	if normalizedName == "" {
		normalizedName = "file"
	}
	escapedName := strings.NewReplacer("\\", "_", "\"", "_", "\n", "_", "\r", "_").Replace(normalizedName)
	disposition := "attachment"
	if inline {
		disposition = "inline"
	}
	return disposition + `; filename="` + escapedName + `"; filename*=UTF-8''` + url.PathEscape(normalizedName)
}

func safeContentType(contentType string) string {
	mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(contentType))
	if err != nil {
		mediaType = strings.TrimSpace(contentType)
		params = nil
	}
	normalized := strings.ToLower(strings.TrimSpace(mediaType))
	if normalized == "" {
		return "application/octet-stream"
	}
	if isActiveContentType(normalized) {
		return "text/plain; charset=utf-8"
	}
	if len(params) == 0 {
		return normalized
	}
	return mime.FormatMediaType(normalized, params)
}

func isActiveContentType(mediaType string) bool {
	switch strings.ToLower(strings.TrimSpace(mediaType)) {
	case "text/html",
		"text/css",
		"text/javascript",
		"text/xml",
		"application/javascript",
		"application/ecmascript",
		"application/x-javascript",
		"application/typescript",
		"application/xml",
		"application/xhtml+xml",
		"image/svg+xml":
		return true
	default:
		return false
	}
}

func isPassiveInlineContentType(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(contentType))
	if err != nil {
		mediaType = contentType
	}
	normalized := strings.ToLower(strings.TrimSpace(mediaType))
	if normalized == "application/pdf" {
		return true
	}
	switch normalized {
	case "image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp":
		return true
	default:
		return false
	}
}

func applySecurityHeaders(c *gin.Context, public bool) {
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Security-Policy", "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'none'; object-src 'none'; frame-ancestors 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:")
	if public {
		c.Header("Cross-Origin-Resource-Policy", "cross-origin")
		return
	}
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
}
