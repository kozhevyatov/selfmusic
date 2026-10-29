import { Check, ChevronDown, Library } from "@/components/icons";
import { Menu } from "@/components/ui/menu";
import { api, updateCurrentUser, type LibraryScope, type MyLibrary } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { invalidate, useQuery } from "@/lib/query";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const LABELS: Record<LibraryScope, string> = { all: "Вся музыка", shared: "Только общая", mine: "Только моя" };
const SHORT: Record<LibraryScope, string> = { all: "Вся", shared: "Общая", mine: "Моя" };
const HINTS: Record<LibraryScope, string> = {
  all: "Общие папки и личная",
  shared: "Без загруженного лично",
  mine: "Только то, что загрузил ты",
};

/** Есть ли из чего выбирать: и личные, и общие папки одного типа. */
export function scopeAvailable(libs: MyLibrary[] | undefined) {
  if (!libs) return false;
  return (["music", "audiobooks"] as const).some(
    (k) => libs.some((l) => l.kind === k && l.personal && l.album_count > 0) && libs.some((l) => l.kind === k && !l.personal),
  );
}

/** Раздел «Аудиокниги» показываем, если есть общая папка книг или в личной уже что-то лежит. */
export function booksAvailable(libs: MyLibrary[] | undefined) {
  return Boolean(libs?.some((l) => l.kind === "audiobooks" && (!l.personal || l.album_count > 0)));
}

/** «Вся музыка / Только общая / Только моя» — фильтр медиатеки, хранится в профиле. */
export function LibraryScopeSwitch({ compact = false }: { compact?: boolean }) {
  const { user } = useAuth();
  const libs = useQuery(["libraries"], api.library.libraries, { staleTime: 300_000 });
  const scope = user?.library_scope ?? "all";
  // выбранный фильтр показываем всегда — иначе из него нельзя было бы выйти
  if (!user || (!scopeAvailable(libs.data) && scope === "all")) return null;
  const set = async (s: LibraryScope) => {
    if (s === scope) return;
    try {
      updateCurrentUser(await api.me.update({ library_scope: s }));
      invalidate([]); // всё, что показывали, — уже с другим фильтром
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  const filtered = scope !== "all";
  return (
    <Menu
      label="Что показывать"
      align={compact ? "end" : "start"}
      items={(["all", "shared", "mine"] as LibraryScope[]).map((s) => ({
        label: LABELS[s],
        hint: HINTS[s],
        icon: s === scope ? <Check /> : <span />,
        onSelect: () => set(s),
      }))}
      trigger={(t) => (
        <button
          {...t}
          title="Что показывать в медиатеке"
          className={cn(
            "flex items-center gap-1.5 rounded-full border text-[13px] font-bold transition",
            compact ? "h-8 px-2.5" : "h-9 w-full px-3",
            filtered ? "border-accent/50 bg-accent/15 text-accent-ink" : "text-muted hover:bg-surface-2 hover:text-fg",
          )}
        >
          <Library className="size-4 shrink-0" />
          <span className={cn("truncate", !compact && "flex-1 text-left")}>{compact ? SHORT[scope] : LABELS[scope]}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </button>
      )}
    />
  );
}
