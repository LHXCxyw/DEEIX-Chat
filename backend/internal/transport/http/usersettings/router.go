package usersettings

import "github.com/gin-gonic/gin"

// RegisterRoutes 注册用户配置路由（需要登录）。
func (m *Module) RegisterRoutes(authGroup *gin.RouterGroup) {
	g := authGroup.Group("/user/settings")
	g.GET("", m.Handler.GetSettings)
	g.PATCH("", m.Handler.PatchSettings)

	// 画布快照单独成组：体积远大于普通偏好项，不进入 ListSettings 的全量返回。
	canvas := authGroup.Group("/user/canvas-state")
	canvas.GET("", m.Handler.GetCanvasState)
	canvas.PUT("", m.Handler.PutCanvasState)
}
