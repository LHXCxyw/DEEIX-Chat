package middleware

import (
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// SecurityHeaders 为所有 HTTP 响应补充通用安全响应头。
//
// frameAncestors 是允许嵌套本站在 iframe 中的来源列表（CSP frame-ancestors 语法）。
// 为空、none 或非法时保持默认的 X-Frame-Options: DENY；配置后改用 CSP 表达白名单，
// 因为 X-Frame-Options 无法允许跨子域来源。
func SecurityHeaders(frameAncestors string) gin.HandlerFunc {
	policy := normalizeFrameAncestors(frameAncestors)
	return func(c *gin.Context) {
		header := c.Writer.Header()
		setHeaderIfEmpty(header, "X-Content-Type-Options", "nosniff")
		if policy == "" {
			setHeaderIfEmpty(header, "X-Frame-Options", "DENY")
		} else {
			setHeaderIfEmpty(header, "Content-Security-Policy", "frame-ancestors "+policy)
			// SAMEORIGIN 只表达同源；白名单含其它来源时不能再发 X-Frame-Options。
			if policy == "'self'" {
				setHeaderIfEmpty(header, "X-Frame-Options", "SAMEORIGIN")
			}
		}
		setHeaderIfEmpty(header, "Permissions-Policy", "camera=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()")
		c.Next()
	}
}

// normalizeFrameAncestors 返回可安全写入响应头的来源列表；空或非法值表示继续禁止嵌套。
func normalizeFrameAncestors(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	// 拒绝换行、分号与反引号：前者可拼接额外 CSP 指令，后者是常见的 Markdown 误粘贴，
	// 会让该来源在浏览器里失效。
	if strings.ContainsAny(trimmed, ";`\r\n") {
		return ""
	}
	lowered := strings.ToLower(trimmed)
	if lowered == "none" || lowered == "'none'" {
		return ""
	}
	return trimmed
}

func setHeaderIfEmpty(header http.Header, key string, value string) {
	if header.Get(key) != "" {
		return
	}
	header.Set(key, value)
}
