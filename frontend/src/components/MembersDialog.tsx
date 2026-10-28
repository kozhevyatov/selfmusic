import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { api, type Playlist } from "@/lib/api";
import { invalidate, useQuery } from "@/lib/query";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { Avatar } from "./Cover";
import { Check, LoaderCircle } from "./icons";

/** Соавторы плейлиста: могут добавлять, убирать и переставлять треки */
export function MembersDialog({ open, onClose, playlist }: { open: boolean; onClose: () => void; playlist: Playlist }) {
  const users = useQuery(["users-directory"], api.playlists.users, { enabled: open });
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setPicked(new Set(playlist.members.map((m) => m.id)));
  }, [open, playlist]);

  const save = async () => {
    setBusy(true);
    try {
      await api.playlists.setMembers(playlist.id, [...picked]);
      invalidate(["playlist", playlist.id], ["playlists"]);
      toast.success(picked.size ? "Соавторы сохранены — плейлист появится у них в списке" : "Плейлист снова только ваш");
      onClose();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Совместный плейлист"
      description="Отмеченные люди увидят плейлист у себя и смогут добавлять, убирать и переставлять треки. Рядом с каждым треком видно, кто его добавил."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy && <LoaderCircle className="size-4 animate-spin" />} Сохранить
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        {users.isLoading && <p className="py-4 text-sm text-muted">Загрузка…</p>}
        {users.data?.length === 0 && <p className="py-4 text-sm text-muted">Других пользователей на сервере пока нет.</p>}
        {users.data?.map((u) => {
          const on = picked.has(u.id);
          return (
            <button
              key={u.id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                const next = new Set(picked);
                if (on) next.delete(u.id);
                else next.add(u.id);
                setPicked(next);
              }}
              className={cn("flex items-center gap-3 rounded-xl p-2 text-left transition hover:bg-surface-2", on && "bg-surface-2")}
            >
              <Avatar name={u.name} src={u.avatar} className="size-10" />
              <span className="flex-1 font-bold">{u.name}</span>
              <span className={cn("flex size-6 items-center justify-center rounded-full border-2", on ? "border-accent bg-accent text-accent-fg" : "border-line")}>
                {on && <Check className="size-4" />}
              </span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
