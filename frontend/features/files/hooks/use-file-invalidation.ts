"use client";

import * as React from "react";

import {
  type FileLibraryInvalidatedDetail,
  subscribeFileLibraryInvalidated,
} from "@/shared/events/file-library-events";

export function useFileInvalidation(
  onInvalidated: (detail: FileLibraryInvalidatedDetail) => void,
) {
  const handlerRef = React.useRef(onInvalidated);

  React.useEffect(() => {
    handlerRef.current = onInvalidated;
  }, [onInvalidated]);

  React.useEffect(() => {
    return subscribeFileLibraryInvalidated((detail) => {
      handlerRef.current(detail);
    });
  }, []);
}
