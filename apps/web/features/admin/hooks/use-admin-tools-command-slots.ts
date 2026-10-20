import * as React from "react";
import { useTranslations } from "next-intl";

import { type AdminCommandSlot, CommandSlotRecoveryError, listAdminCommandSlots, recoverAdminCommandSlot } from "@/features/admin/api/command-slots";
import { useLocalizedErrorMessage } from "@/i18n/use-localized-error";
import { ApiError } from "@/shared/api/http-client";
import { resolveAccessToken } from "@/shared/auth/resolve-access-token";

export function useAdminToolsCommandSlots() {
  const t = useTranslations("adminTools.commandSlots");
  const resolveError = useLocalizedErrorMessage();
  const [slots, setSlots] = React.useState<AdminCommandSlot[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState("");
  const [notice, setNotice] = React.useState<{ success: boolean; message: string } | null>(null);
  const [selected, setSelected] = React.useState<AdminCommandSlot | null>(null);
  const [recovering, setRecovering] = React.useState(false);
  const busy = React.useRef(false);
  const request = React.useRef(0);

  const refresh = React.useCallback(async () => {
    const id = ++request.current;
    setLoading(true);
    setLoadError("");
    try {
      const token = await resolveAccessToken();
      const items = await listAdminCommandSlots(token);
      if (id === request.current) setSlots(items);
    } catch (error) {
      if (id === request.current) setLoadError(resolveError(error));
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [resolveError]);

  React.useEffect(() => {
    void refresh();
    return () => { request.current += 1; };
  }, [refresh]);

  const recover = React.useCallback(async () => {
    if (!selected || busy.current) return;
    busy.current = true;
    setRecovering(true);
    setNotice(null);
    try {
      const token = await resolveAccessToken();
      await recoverAdminCommandSlot(token, selected);
      setNotice({ success: true, message: t("recovered") });
    } catch (error) {
      const message = error instanceof CommandSlotRecoveryError
        ? `${t("blocked")} ${error.blockedReason || t("unknownReason")}`
        : error instanceof ApiError && error.status === 409
          ? `${t("conflict")} ${error.rawMessage}`
          : `${t("unconfirmed")} ${resolveError(error)}`;
      setNotice({ success: false, message });
    } finally {
      setSelected(null);
      await refresh();
      busy.current = false;
      setRecovering(false);
    }
  }, [refresh, resolveError, selected, t]);

  return {
    slots, loading, loadError, notice, selected, recovering, refresh, recover,
    select: (slot: AdminCommandSlot | null) => {
      if (!busy.current) setSelected(slot);
    },
  };
}
