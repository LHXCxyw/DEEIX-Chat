package conversation

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestConversationAttachmentHandlerAuthorization(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, authorization := range []string{"", `,"edit_authorized":false`, `,"edit_authorized":null`} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodPost, "/conversations/c/workspace/files/from-attachment", strings.NewReader(`{"file_id":"f","path":"a.txt"`+authorization+`}`))
		c.Request.Header.Set("Content-Type", "application/json")
		(&Handler{}).ImportConversationFileFromAttachment(c)
		if w.Code != http.StatusForbidden {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
}
