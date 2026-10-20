"use client";

import * as React from "react";
import { type AgentCapabilities, getAgentCapabilities } from "@/shared/api/agent-capabilities";
import { useAuthSession } from "@/shared/auth/auth-session-context";

export function useAgentCapabilities() {
  const { accessToken } = useAuthSession();
  const [state, setState] = React.useState<{
    token: string | null;
    data: AgentCapabilities | null;
    failed: boolean;
  }>({ token: null, data: null, failed: false });
  const [revision, refresh] = React.useReducer((value: number) => value + 1, 0);

  React.useEffect(() => {
    if (!accessToken) return;
    const controller = new AbortController();
    setState({ token: accessToken, data: null, failed: false });
    void getAgentCapabilities(accessToken, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ token: accessToken, data, failed: false });
      },
      () => {
        if (!controller.signal.aborted) setState({ token: accessToken, data: null, failed: true });
      },
    );
    return () => controller.abort();
  }, [accessToken, revision]);

  const current = accessToken && state.token === accessToken;
  const data = current ? state.data : null;
  const failed = Boolean(current && state.failed);
  return {
    data,
    failed,
    loading: Boolean(accessToken && !data && !failed),
    refresh,
  };
}
