package conversation

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestImportProjectAttachmentRequest(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tt := range []struct {
		body                string
		invalid, authorized bool
	}{
		{body: `{"file_id":"f","path":"src/a.go","edit_authorized":true}`, authorized: true},
		{body: `{"file_id":"f","path":"a.txt"}`},
		{body: `{"file_id":"f","path":"a.txt","edit_authorized":null}`},
		{body: `{"file_id":"f","path":"a.txt","edit_authorized":false}`},
		{body: `{"file_id":"f","path":"a.txt","edit_authorized":"true"}`, invalid: true},
		{body: `{"file_id":"f","path":"a.txt","edit_authorized":1}`, invalid: true},
		{body: `{"path":"a.txt","edit_authorized":true}`, invalid: true},
		{body: `{"file_id":"f","edit_authorized":true}`, invalid: true},
	} {
		t.Run(tt.body, func(t *testing.T) {
			c, _ := gin.CreateTestContext(httptest.NewRecorder())
			c.Request = httptest.NewRequest(http.MethodPost, "/", strings.NewReader(tt.body))
			c.Request.Header.Set("Content-Type", "application/json")
			var req ImportProjectAttachmentRequest
			err := c.ShouldBindJSON(&req)
			if (err != nil) != tt.invalid || (!tt.invalid && req.EditAuthorized != tt.authorized) {
				t.Fatalf("request=%+v error=%v", req, err)
			}
		})
	}
}

func TestImportProjectAttachmentHandlerRejectsMissingAuthorization(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, authorization := range []string{"", `,"edit_authorized":false`, `,"edit_authorized":null`} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodPost, "/conversation-projects/project/files/from-attachment", strings.NewReader(`{"file_id":"f","path":"a.txt"`+authorization+`}`))
		c.Request.Header.Set("Content-Type", "application/json")
		(&Handler{}).ImportProjectFileFromAttachment(c)
		if w.Code != http.StatusForbidden || !strings.Contains(w.Body.String(), "project.attachment_edit_authorization_required") {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	}
}
