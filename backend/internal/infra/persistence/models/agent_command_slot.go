package models

import "time"

type AgentCommandSlot struct {
	ContainerID          string    `gorm:"size:64;not null;default:''"`
	ContainerOwner       string    `gorm:"size:64;not null;default:''"`
	ContainerTaskID      string    `gorm:"size:128;not null;default:''"`
	ContainerOperationID string    `gorm:"size:128;not null;default:''"`
	Slot                 int       `gorm:"primaryKey"`
	OwnerUserID          uint      `gorm:"not null;index:idx_agent_command_slots_owner_active"`
	OperationID          string    `gorm:"size:128;not null"`
	Token                string    `gorm:"size:64;not null"`
	LeaseUntil           time.Time `gorm:"not null;index:idx_agent_command_slots_expiry"`
}

func (AgentCommandSlot) TableName() string { return "chat_agent_command_slots" }
