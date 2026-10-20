"use client";

import * as React from "react";
import { updateUserSettings, useUserSettings } from "@/entities/user-settings";
import type { AgentPermissionMode } from "@/shared/api/conversation-types";
import { useAuthSession } from "@/shared/auth/auth-session-context";

export function useChatAgentPermissionMode() {
  const { accessToken } = useAuthSession();
  const { settings, loaded } = useUserSettings();
  const value = settings["chat.agent_permission_mode"];
  const mode: AgentPermissionMode = value === "auto" || value === "full" ? value : "manual";
  const [saving, setSaving] = React.useState(false);
  const setMode = async (next: AgentPermissionMode) => {
    if (!accessToken || saving || !loaded) return;
    setSaving(true);
    try {
      await updateUserSettings(accessToken, { "chat.agent_permission_mode": next });
    } finally {
      setSaving(false);
    }
  };
  return { mode, setMode, saving, loaded };
}
