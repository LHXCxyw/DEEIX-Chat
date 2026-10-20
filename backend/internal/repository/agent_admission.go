package repository

import (
	"context"

	"github.com/DEEIX-AI/DEEIX-Chat/backend/internal/domain/admission"
)

type AgentCommandAdmissionRepository interface {
	AcquireCommandLease(ctx context.Context, ownerUserID uint, operationID string) (admission.Lease, error)
	ReleaseCommandLease(ctx context.Context, lease admission.Lease) error
}
