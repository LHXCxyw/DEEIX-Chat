package admin

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"

	appadmin "github.com/DEEIX-AI/DEEIX-Chat/backend/internal/application/admin"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/repository"
	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/shared/response"
	"github.com/gin-gonic/gin"
)

func (h *Handler) SetCommandSlotService(service *appadmin.CommandSlotService) {
	h.commandSlots = service
}

func (h *Handler) ListCommandSlots(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	items, err := h.commandSlots.List(c.Request.Context())
	if err != nil {
		response.InternalError(c, err)
		return
	}
	response.Success(c, items)
}

func (h *Handler) RecoverCommandSlot(c *gin.Context) {
	c.Header("Cache-Control", "no-store")
	slot, err := strconv.Atoi(c.Param("slot"))
	if err != nil || slot < 0 {
		response.ErrorFrom(c, http.StatusBadRequest, repository.ErrInvalidInput)
		return
	}
	var input appadmin.RecoverCommandSlotInput
	dec := json.NewDecoder(http.MaxBytesReader(c.Writer, c.Request.Body, 4096))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&input); err != nil {
		response.InvalidRequestBody(c, err)
		return
	}
	if err := dec.Decode(new(any)); err != io.EOF {
		response.ErrorFrom(c, http.StatusBadRequest, repository.ErrInvalidInput)
		return
	}
	input.Slot = slot
	item, err := h.commandSlots.Recover(c.Request.Context(), input)
	switch {
	case err == nil:
		response.Success(c, item)
	case errors.Is(err, repository.ErrInvalidInput):
		response.ErrorFrom(c, http.StatusBadRequest, err)
	case errors.Is(err, repository.ErrConflict):
		response.ErrorFrom(c, http.StatusConflict, err)
	case errors.Is(err, appadmin.ErrCommandSlotBlocked):
		// 明确非成功语义，不返回 token、命令参数或底层 Docker 错误。
		c.JSON(http.StatusConflict, gin.H{"status": "blocked", "released": false, "slot": item})
	case err != nil:
		response.InternalError(c, err)
	default:
		response.InternalError(c, appadmin.ErrCommandSlotBlocked)
	}
}
