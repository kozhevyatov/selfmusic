import { useSyncExternalStore } from "react";
import type { Track } from "./api";

export type DialogState =
  | { kind: "none" }
  | { kind: "playlist"; tracks: Track[] }
  | { kind: "tags"; trackId: number }
  | { kind: "album-tags"; albumId: number }
  | { kind: "confirm"; title: string; text: string; action: string; danger?: boolean; resolve: (ok: boolean) => void };

let state: DialogState = { kind: "none" };
const listeners = new Set<() => void>();

function set(next: DialogState) {
  state = next;
  listeners.forEach((l) => l());
}

export const dialogs = {
  addToPlaylist: (tracks: Track[]) => set({ kind: "playlist", tracks }),
  editTags: (trackId: number) => set({ kind: "tags", trackId }),
  editAlbum: (albumId: number) => set({ kind: "album-tags", albumId }),
  confirm: (opts: { title: string; text: string; action: string; danger?: boolean }) =>
    new Promise<boolean>((resolve) => set({ kind: "confirm", ...opts, resolve })),
  close: () => {
    if (state.kind === "confirm") state.resolve(false);
    set({ kind: "none" });
  },
  closeQuiet: () => set({ kind: "none" }),
};

export function useDialogState() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    () => state,
  );
}
