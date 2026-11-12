package conversation

import (
	"errors"
	"net/http"
	"strings"

	appupload "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/upload"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/transport/http/middleware"
	"github.com/gin-gonic/gin"
)

type timelineConcatSegmentRequest struct {
	FileID string  `json:"fileID"`
	Start  float64 `json:"start"`
	End    float64 `json:"end"`
}

type timelineConcatAudioSegmentRequest struct {
	FileID        string   `json:"fileID"`
	Start         float64  `json:"start"`
	End           float64  `json:"end"`
	TimelineStart *float64 `json:"timelineStart"`
}

type timelineConcatRequest struct {
	Segments      []timelineConcatSegmentRequest      `json:"segments"`
	AudioSegments []timelineConcatAudioSegmentRequest `json:"audioSegments"`
}

type timelineConcatResponse struct {
	FileID    string `json:"fileID"`
	FileName  string `json:"fileName"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
}

// ConcatTimeline 时间线片段拼接：按顺序裁剪并拼接多个视频，返回新的平台视频文件。
// 运行环境需提供 ffmpeg（FFMPEG_PATH 或 PATH 中的 ffmpeg）。
func (h *Handler) ConcatTimeline(c *gin.Context) {
	userID := middleware.MustUserID(c)
	var payload timelineConcatRequest
	if err := c.ShouldBindJSON(&payload); err != nil {
		response.ErrorFrom(c, http.StatusBadRequest, err)
		return
	}
	if len(payload.Segments) == 0 {
		response.ErrorFrom(c, http.StatusBadRequest, errors.New("timeline requires at least one segment"))
		return
	}
	segments := make([]appupload.TimelineSegment, 0, len(payload.Segments))
	for _, item := range payload.Segments {
		fileID := strings.TrimSpace(item.FileID)
		if fileID == "" {
			response.ErrorFrom(c, http.StatusBadRequest, errors.New("segment fileID is required"))
			return
		}
		segments = append(segments, appupload.TimelineSegment{
			FileID: fileID,
			Start:  item.Start,
			End:    item.End,
		})
	}
	audioSegments := make([]appupload.TimelineAudioSegment, 0, len(payload.AudioSegments))
	for _, item := range payload.AudioSegments {
		fileID := strings.TrimSpace(item.FileID)
		if fileID == "" {
			continue
		}
		audioSegments = append(audioSegments, appupload.TimelineAudioSegment{
			FileID:        fileID,
			Start:         item.Start,
			End:           item.End,
			TimelineStart: item.TimelineStart,
		})
	}
	result, err := h.uploads.ConcatTimeline(c.Request.Context(), appupload.ConcatTimelineInput{
		UserID:        userID,
		Segments:      segments,
		AudioSegments: audioSegments,
	})
	if err != nil {
		// 拼接待 ffmpeg 执行，失败原因写入响应文案便于前端提示
		message := strings.TrimSpace(err.Error())
		if len(message) > 400 {
			message = message[:400]
		}
		response.ErrorDescribed(c, response.Description{
			Status:  http.StatusBadRequest,
			Code:    response.CodeRequestInvalid,
			Message: "timeline concat failed: " + message,
		})
		return
	}
	response.Success(c, timelineConcatResponse{
		FileID:    result.File.FileID,
		FileName:  result.File.FileName,
		MimeType:  result.File.MimeType,
		SizeBytes: result.File.SizeBytes,
	})
}
